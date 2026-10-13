package com.opengw.manager

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/**
 * 插件管理器 - AirDeck 插件系统
 *
 * 插件包为 .owpkg 格式（zip 压缩包），结构：
 *   manifest.json  必填：id / name / entryJs 等元数据
 *   www/           前端静态资源（serve 于 /plugins/{id}/www/ 下）
 *   bin/           可选：可执行二进制（安装时自动 chmod 755）
 *   files/         可选：需写入系统的文件（由 install.sh 处理）
 *   scripts/       可选：install.sh / remove.sh / start.sh / stop.sh
 *
 * 安装位置：filesDir/plugins/<id>/
 * 后端逻辑由插件前端 JS 调用核心通用能力 API 实现（exec/config/file），不涉及 dex 动态加载。
 */
class PluginManager(private val context: Context) {
    companion object {
        /** 插件包扩展名，避免与 zip/opkg 等通用格式冲突 */
        const val EXT = ".owpkg"
    }

    private val TAG = "PluginManager"
    private val rootDir = File(context.filesDir, "plugins")
    private val ID_REGEX = Regex("^[A-Za-z0-9_-]+$")

    private val plugins = LinkedHashMap<String, JSONObject>()

    fun init() {
        if (!rootDir.exists()) rootDir.mkdirs()
        scan()
    }

    private fun scan() {
        plugins.clear()
        val dirs = rootDir.listFiles { f -> f.isDirectory && !f.name.startsWith(".") } ?: return
        for (dir in dirs) {
            val manifest = parseManifest(dir)
            if (manifest != null) plugins[manifest.optString("id")] = manifest
            else Log.w(TAG, "跳过无效插件目录: ${dir.name}")
        }
        Log.i(TAG, "已加载 ${plugins.size} 个插件")
    }

    fun getPlugins(): JSONArray {
        val arr = JSONArray()
        for (p in plugins.values) arr.put(p)
        return arr
    }

    // ==================== 安装 / 卸载 ====================

    fun installFromBytes(bytes: ByteArray, fileName: String): JSONObject {
        val result = JSONObject()
        if (!fileName.endsWith(EXT)) {
            return result.put("result", "error").put("msg", "插件格式不正确，需要 $EXT 文件")
        }
        if (bytes.isEmpty()) {
            return result.put("result", "error").put("msg", "文件内容为空")
        }
        // 磁盘空间预检：解压后体积约为压缩包的数倍
        val freeSpace = rootDir.freeSpace
        if (freeSpace < bytes.size * 4L) {
            return result.put("result", "error")
                .put("msg", "存储空间不足（剩余 ${freeSpace / 1024 / 1024}MB，安装需约 ${bytes.size / 1024 / 1024 * 4}MB）")
        }
        val tmpDir = File(rootDir, ".tmp-${System.currentTimeMillis()}")
        try {
            tmpDir.mkdirs()
            if (!extractZip(bytes, tmpDir)) throw Exception("解压失败，文件可能损坏")
            val manifest = parseManifest(tmpDir)
            if (manifest == null) throw Exception("manifest.json 无效或缺失（需 id 与 entryJs 字段）")

            // 签名验证：带 signature.sig 则必须通过；无签名视为未签名（允许，标记显示）
            val hasSig = File(tmpDir, "signature.sig").exists()
            val sigValid = verifySignature(tmpDir)
            if (hasSig && !sigValid) throw Exception("插件签名无效，可能已被篡改")
            manifest.put("signed", sigValid)

            val id = manifest.getString("id")
            val target = File(rootDir, id)
            if (target.exists()) target.deleteRecursively()
            if (!tmpDir.renameTo(target)) {
                // 跨文件系统 rename 失败时回退为复制
                copyRecursively(tmpDir, target)
            }
            scan()
            chmodBin(id)
            val scriptOut = runPluginScript(id, "install")
            Log.i(TAG, "已安装插件: $id v${manifest.optString("version")}")
            return result.put("result", "success").put("plugin", manifest).put("output", scriptOut)
        } catch (e: Exception) {
            Log.e(TAG, "安装失败", e)
            return result.put("result", "error").put("msg", e.message ?: "未知错误")
        } finally {
            if (tmpDir.exists()) tmpDir.deleteRecursively()
        }
    }

    fun installFromUrl(url: String): JSONObject {
        val result = JSONObject()
        if (url.isBlank()) return result.put("result", "error").put("msg", "URL 不能为空")
        // SSRF 防护：限协议、限长度、禁止内网/本机地址
        if (url.length > 2048) return result.put("result", "error").put("msg", "URL 过长")
        val uri = try {
            java.net.URI(url)
        } catch (e: Exception) {
            return result.put("result", "error").put("msg", "URL 格式无效")
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            return result.put("result", "error").put("msg", "仅支持 http/https 协议")
        }
        val host = uri.host ?: return result.put("result", "error").put("msg", "URL 缺少主机名")
        if (isPrivateOrLocal(host)) {
            return result.put("result", "error").put("msg", "禁止从本机或内网地址安装插件")
        }
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
        try {
            val request = Request.Builder().url(url).get().build()
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) {
                    return result.put("result", "error").put("msg", "HTTP ${resp.code}")
                }
                val body = resp.body
                if (body == null) {
                    return result.put("result", "error").put("msg", "下载内容为空")
                }
                val bytes = body.bytes()
                if (bytes.isEmpty()) {
                    return result.put("result", "error").put("msg", "下载内容为空")
                }
                return installFromBytes(bytes, "remote$EXT")
            }
        } catch (e: Exception) {
            Log.e(TAG, "URL 安装失败", e)
            return result.put("result", "error").put("msg", "下载失败: ${e.message}")
        }
    }

    /** 判断主机是否为本机/内网地址（SSRF 防护） */
    private fun isPrivateOrLocal(host: String): Boolean {
        val h = host.lowercase().trim()
        if (h.isEmpty() || h == "localhost" || h.endsWith(".local")) return true
        val ip = try {
            java.net.InetAddress.getByName(h).hostAddress
        } catch (e: Exception) {
            return false // 域名解析失败交由后续请求处理
        }
        if (ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") ||
            ip.startsWith("169.254.") || ip == "0.0.0.0" || ip == "::1") return true
        if (ip.startsWith("172.")) {
            val second = ip.substringAfter("172.").substringBefore(".").toIntOrNull()
            if (second != null && second in 16..31) return true
        }
        if (ip.startsWith("fe80") || ip.startsWith("fc") || ip.startsWith("fd")) return true
        return false
    }

    fun uninstall(id: String): JSONObject {
        val result = JSONObject()
        if (!plugins.containsKey(id)) return result.put("result", "error").put("msg", "插件未安装")
        runPluginScript(id, "remove")
        File(rootDir, id).deleteRecursively()
        scan()
        return result.put("result", "success")
    }

    /** 预览插件包：解析 manifest 返回摘要信息（不安装、不落盘） */
    fun preview(bytes: ByteArray, fileName: String): JSONObject {
        val result = JSONObject()
        if (!fileName.endsWith(EXT)) {
            return result.put("result", "error").put("msg", "插件格式不正确，需要 $EXT 文件")
        }
        val tmpDir = File(rootDir, ".tmp-preview-${System.currentTimeMillis()}")
        try {
            tmpDir.mkdirs()
            if (!extractZip(bytes, tmpDir)) return result.put("result", "error").put("msg", "解压失败，文件可能损坏")
            val manifest = parseManifest(tmpDir)
            if (manifest == null) return result.put("result", "error").put("msg", "manifest.json 无效或缺失（需 id 与 entryJs 字段）")
            return result.put("result", "success")
                .put("id", manifest.optString("id"))
                .put("name", manifest.optString("name"))
                .put("version", manifest.optString("version"))
                .put("versionCode", manifest.optInt("versionCode", 0))
                .put("icon", manifest.optString("icon"))
                .put("description", manifest.optString("description"))
                .put("requiresRoot", manifest.optBoolean("requiresRoot", false))
                .put("signed", manifest.optBoolean("signed", false))
        } catch (e: Exception) {
            Log.e(TAG, "预览失败", e)
            return result.put("result", "error").put("msg", e.message ?: "解析失败")
        } finally {
            if (tmpDir.exists()) tmpDir.deleteRecursively()
        }
    }

    // ==================== 启停 ====================

    fun start(id: String): JSONObject = runScriptApi(id, "start")

    fun stop(id: String): JSONObject = runScriptApi(id, "stop")

    fun restart(id: String): JSONObject {
        runScriptApi(id, "stop")
        return runScriptApi(id, "start")
    }

    private fun runScriptApi(id: String, which: String): JSONObject {
        val out = runPluginScript(id, which)
        return JSONObject().put("result", "success").put("output", out)
    }

    /**
     * 开机启动时执行所有声明了 scripts.boot 的插件（后台线程，不阻塞服务器启动）。
     * boot 脚本应自行 nohup 后台化并判断是否真正需要自启。
     */
    fun runBootScripts() {
        Thread {
            for (p in plugins.values) {
                val id = p.optString("id")
                val scripts = p.optJSONObject("scripts") ?: continue
                val rel = scripts.optString("boot", "")
                if (rel.isBlank()) continue
                val f = resolveInPlugin(id, rel) ?: continue
                if (!f.exists()) continue
                Log.i(TAG, "执行插件 $id 的 boot 脚本")
                try {
                    runRootCommand("sh '${f.absolutePath}'")
                } catch (e: Exception) {
                    Log.e(TAG, "插件 $id boot 脚本执行失败", e)
                }
            }
        }.start()
    }

    private fun runPluginScript(id: String, which: String): String {
        val manifest = plugins[id] ?: return "插件不存在"
        val scripts = manifest.optJSONObject("scripts") ?: return "插件未声明脚本"
        val rel = scripts.optString(which, "")
        if (rel.isBlank()) return "插件未声明 $which 脚本"
        val f = resolveInPlugin(id, rel) ?: return "脚本路径越界"
        if (!f.exists()) return "脚本不存在: $rel"
        return runRootCommand("sh '${f.absolutePath}'")
    }

    // ==================== 通用能力 API ====================

    /**
     * 插件后端逻辑能力：以 root 执行命令（cwd 限定插件目录）。
     * 信任边界：命令可访问系统路径，这是插件实现后端逻辑所需；
     * 安全由「登录鉴权 + 登录防爆破 + 插件签名校验」兜底，而非限制命令本身。
     */
    fun exec(id: String, command: String): JSONObject {
        val result = JSONObject()
        if (!plugins.containsKey(id)) return result.put("result", "error").put("msg", "插件未安装")
        if (command.isBlank()) return result.put("result", "error").put("msg", "命令不能为空")
        if (command.length > 4096) return result.put("result", "error").put("msg", "命令过长")
        if (command.contains('\u0000')) return result.put("result", "error").put("msg", "命令包含非法字符")
        val dir = File(rootDir, id).absolutePath
        val out = runRootCommand("cd '$dir' && $command")
        return result.put("result", "success").put("output", out)
    }

    fun getConfig(id: String): JSONObject {
        if (!plugins.containsKey(id)) return JSONObject().put("error", "插件未安装")
        val f = File(rootDir, "$id/config.json")
        return try {
            if (f.exists()) JSONObject(f.readText()) else JSONObject()
        } catch (e: Exception) {
            JSONObject()
        }
    }

    fun setConfig(id: String, data: JSONObject): JSONObject {
        if (!plugins.containsKey(id)) return JSONObject().put("result", "error").put("msg", "插件未安装")
        return try {
            val f = File(rootDir, "$id/config.json")
            f.parentFile?.mkdirs()
            f.writeText(data.toString())
            JSONObject().put("result", "success")
        } catch (e: Exception) {
            JSONObject().put("result", "error").put("msg", e.message ?: "写入失败")
        }
    }

    /** 返回 Pair(content, error)，content 与 error 互斥 */
    fun readFile(id: String, relPath: String): Pair<String?, String?> {
        if (!plugins.containsKey(id)) return null to "插件未安装"
        val f = resolveInPlugin(id, relPath) ?: return null to "路径越界"
        if (!f.exists()) return null to "文件不存在"
        return try {
            f.readText() to null
        } catch (e: Exception) {
            null to (e.message ?: "读取失败")
        }
    }

    /** 返回 error 或 null（成功） */
    fun writeFile(id: String, relPath: String, content: String): String? {
        if (!plugins.containsKey(id)) return "插件未安装"
        val f = resolveInPlugin(id, relPath) ?: return "路径越界"
        return try {
            f.parentFile?.mkdirs()
            f.writeText(content)
            null
        } catch (e: Exception) {
            e.message ?: "写入失败"
        }
    }

    /** 获取插件 www 目录下的静态文件，越界返回 null */
    fun getWwwFile(id: String, relPath: String): File? {
        val base = File(rootDir, "$id/www").canonicalFile
        if (!base.exists()) return null
        val target = File(base, relPath).canonicalFile
        if (!target.path.startsWith(base.path + File.separator)) return null
        return if (target.exists() && target.isFile) target else null
    }

    // ==================== 内部工具 ====================

    private fun parseManifest(dir: File): JSONObject? {
        val f = File(dir, "manifest.json")
        if (!f.exists()) return null
        return try {
            val json = JSONObject(f.readText())
            val id = json.optString("id")
            if (id.isBlank() || !id.matches(ID_REGEX)) return null
            if (!json.has("entryJs")) return null
            json.put("dir", File(dir, "").absolutePath)
            json.put("enabled", true)
            // 每次解析（含服务重启后的扫描）都重新验签，避免 signed 状态丢失
            json.put("signed", verifySignature(dir))
            json
        } catch (e: Exception) {
            null
        }
    }

    /** 解析插件内相对路径，防路径穿越 */
    private fun resolveInPlugin(id: String, relPath: String): File? {
        if (!plugins.containsKey(id)) return null
        val base = File(rootDir, id).canonicalFile
        val target = File(base, relPath).canonicalFile
        return if (target.path.startsWith(base.path + File.separator)) target else null
    }

    private fun chmodBin(id: String) {
        val bin = File(rootDir, "$id/bin")
        if (!bin.exists()) return
        bin.listFiles()?.forEach { f ->
            if (f.isFile) runRootCommand("chmod 755 '${f.absolutePath}'")
        }
    }

    /** 校验插件签名：对 manifest.json 原始字节做 SHA256withRSA 验签 */
    private fun verifySignature(pluginDir: File): Boolean {
        val manifestFile = File(pluginDir, "manifest.json")
        val sigFile = File(pluginDir, "signature.sig")
        if (!manifestFile.exists() || !sigFile.exists()) return false
        return try {
            val publicKey = loadPublicKey()
            val sig = Signature.getInstance("SHA256withRSA")
            sig.initVerify(publicKey)
            sig.update(manifestFile.readBytes())
            sig.verify(sigFile.readBytes())
        } catch (e: Exception) {
            Log.e(TAG, "插件验签失败", e)
            false
        }
    }

    private fun loadPublicKey(): PublicKey {
        val pem = context.resources.openRawResource(R.raw.plugin_public_key)
            .bufferedReader().readText()
        val clean = pem
            .replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
            .replace("\n", "")
            .trim()
        val keyBytes = android.util.Base64.decode(clean, android.util.Base64.NO_WRAP)
        return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(keyBytes))
    }

    private fun extractZip(bytes: ByteArray, targetDir: File): Boolean {
        var lastEntryName: String? = null
        return try {
            ZipInputStream(bytes.inputStream()).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    // Windows 打包的 zip 用反斜杠，统一转为正斜杠再落盘
                    val name = entry.name.replace('\\', '/')
                    lastEntryName = name
                    val outFile = File(targetDir, name)
                    val canonical = outFile.canonicalFile
                    val base = targetDir.canonicalFile
                    // 跳过顶层目录项（如 bsdtar 产生的 "./"），其 canonical 即目标目录本身
                    if (name == "." || name == "./" || canonical == base) {
                        zip.closeEntry()
                        entry = zip.nextEntry
                        continue
                    }
                    // 防 zip-slip：所有解压路径必须位于目标目录内
                    if (!canonical.path.startsWith(base.path + File.separator)) return false
                    if (entry.isDirectory) {
                        canonical.mkdirs()
                    } else {
                        canonical.parentFile?.mkdirs()
                        FileOutputStream(canonical).use { fos ->
                            val buf = ByteArray(8192)
                            var n = zip.read(buf)
                            while (n != -1) {
                                fos.write(buf, 0, n)
                                n = zip.read(buf)
                            }
                        }
                    }
                    zip.closeEntry()
                    entry = zip.nextEntry
                }
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "解压失败: entry=$lastEntryName", e)
            false
        }
    }

    private fun copyRecursively(src: File, dst: File) {
        if (src.isDirectory) {
            if (!dst.exists()) dst.mkdirs()
            src.listFiles()?.forEach { child -> copyRecursively(child, File(dst, child.name)) }
        } else {
            src.copyTo(dst, overwrite = true)
        }
    }

    private fun runRootCommand(command: String): String {
        var process: Process? = null
        var os: DataOutputStream? = null
        var input: BufferedReader? = null
        try {
            process = Runtime.getRuntime().exec("su")
            os = DataOutputStream(process.outputStream)
            input = BufferedReader(InputStreamReader(process.inputStream))
            os.writeBytes("$command\nexit\n")
            os.flush()
            val output = StringBuilder()
            var line: String?
            while (input.readLine().also { line = it } != null) {
                output.append(line).append("\n")
            }
            if (!process.waitFor(10, TimeUnit.SECONDS)) {
                process.destroy()
                return "(timeout)"
            }
            return output.toString().trim()
        } catch (e: Exception) {
            Log.e(TAG, "Root command error: ${e.message}")
            return ""
        } finally {
            try {
                os?.close()
                input?.close()
                process?.destroy()
            } catch (e: Exception) {}
        }
    }
}
