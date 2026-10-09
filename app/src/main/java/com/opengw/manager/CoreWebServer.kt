package com.opengw.manager

import android.content.Context
import android.os.Build
import android.util.Log
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.plugins.callloging.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.ktor.http.content.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.consumeEach
import org.slf4j.event.Level
import java.io.InputStream
import java.util.*
import org.json.JSONArray
import org.json.JSONObject
import android.app.ActivityManager
import android.os.Environment
import android.os.StatFs
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/**
 * 终极高性能 Ktor 服务器 - 诊断与投屏增强版 (v1.9.4)
 */
class CoreWebServer(private val context: Context, private val port: Int) {
    private val TAG = "CoreWebServer"
    private val bridge = BridgeProtocol(context)
    private val ttyd = TtydManager()
    private val netAdb = NetAdbManager()
    private val atManager = AtManager()
    private val remote = RemoteControlManager()
    private val scrcpy = ScrcpyManager(context)
    private val samba = SambaManager()
    private val batteryStats = BatteryStatsManager(context)
    private val sysStats = SystemStatsManager()
    private val plugins = PluginManager(context)
    private var server: ApplicationEngine? = null

    // 登录防爆破：连续失败 5 次后锁定 60 秒
    @Volatile private var loginFails = 0
    @Volatile private var loginLockUntil = 0L

    // 缓存高频 API 响应，避免反复读取 /proc 文件消耗 CPU
    private var cachedStatusJson: String = ""
    private var cachedStatusTime: Long = 0
    private var cachedDetailsJson: String = ""
    private var cachedDetailsTime: Long = 0
    private val cacheTtlMs = 3000L

    /**
     * 会话鉴权 token：登录（官方密码）时下发并持久化。
     * 所有 /api 与 WS 路由统一校验，token 仅登录可获得，不再公开分发。
     */
    private fun getSessionToken(): String {
        val sp = context.getSharedPreferences("plugin_auth", Context.MODE_PRIVATE)
        var token = sp.getString("token", null)
        if (token == null || token.length < 16) {
            token = java.util.UUID.randomUUID().toString()
            sp.edit().putString("token", token).apply()
        }
        return token
    }

    /** 轮换会话 token（改密码成功后调用），使旧 token 立即失效 */
    private fun rotateSessionToken() {
        val sp = context.getSharedPreferences("plugin_auth", Context.MODE_PRIVATE)
        sp.edit().putString("token", java.util.UUID.randomUUID().toString()).apply()
    }

    /** 校验请求携带的 token（支持 header 与 query 两种方式，query 供 WebSocket 使用） */
    private suspend fun checkAuth(call: ApplicationCall): Boolean {
        val header = call.request.headers["X-Auth-Token"]
        val query = call.request.queryParameters["token"]
        if ((header ?: query) == getSessionToken()) return true
        call.respondText("{\"result\":-401,\"msg\":\"未授权\"}", ContentType.Application.Json)
        return false
    }

    // ===================== 外观：自定义背景图 =====================
    // 指定一个网址，抓一次就落盘缓存：
    //   - 刷新 / 重启都读本地文件，不再联网，所以图片不会变
    //   - 存在服务端，换设备、换浏览器看到的都是同一张
    // 支持两类地址：直接指向图片的 URL，以及返回 JSON 的接口
    // （例如 Bing 每日一图 HPImageArchive.aspx?format=js，会自动从 JSON 里取图片地址）。
    private val appearanceDir: java.io.File get() = java.io.File(context.filesDir, "appearance")
    private val bgJsonFile: java.io.File get() = java.io.File(appearanceDir, "bg.json")

    private val bgHttp: okhttp3.OkHttpClient by lazy {
        okhttp3.OkHttpClient.Builder()
            .connectTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }

    private fun readBgMeta(): JSONObject = try {
        val f = bgJsonFile
        if (f.exists()) JSONObject(f.readText()) else JSONObject()
    } catch (e: Exception) {
        JSONObject()
    }

    private fun bgImageFile(meta: JSONObject): java.io.File {
        val name = meta.optString("file", "")
        return if (name.isEmpty()) java.io.File(appearanceDir, "__none__")
        else java.io.File(appearanceDir, name)
    }

    private fun appearanceJson(): JSONObject {
        val meta = readBgMeta()
        val f = bgImageFile(meta)
        val has = f.exists() && f.length() > 0
        return JSONObject().apply {
            put("hasImage", has)
            put("url", meta.optString("url", ""))
            put("resolvedUrl", meta.optString("resolvedUrl", ""))
            put("contentType", meta.optString("contentType", "image/jpeg"))
            put("savedAt", meta.optLong("savedAt", 0L))
            put("bytes", if (has) f.length() else 0L)
        }
    }

    private fun bgGet(url: String): Triple<Boolean, String, ByteArray> {
        val req = okhttp3.Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 13) BridgeLink")
            .build()
        bgHttp.newCall(req).execute().use { r ->
            val ct = r.header("Content-Type") ?: ""
            val body = r.body?.bytes() ?: ByteArray(0)
            return Triple(r.isSuccessful, ct, body)
        }
    }

    private fun fetchBackground(url: String): JSONObject {
        val fail = { msg: String ->
            JSONObject().apply { put("ok", false); put("msg", msg) }
        }
        if (url.isBlank()) return fail("地址为空")
        if (!url.startsWith("http://") && !url.startsWith("https://")) return fail("只支持 http/https 地址")

        return try {
            var target = url
            val first = bgGet(url)
            if (!first.first) return fail("请求失败（HTTP 错误）")
            var ct = first.second
            var bytes = first.third

            // 拿到的是 JSON（Bing 每日一图那类接口）→ 从里面取出真正的图片地址再抓一次
            val looksJson = ct.contains("json", true) ||
                (bytes.isNotEmpty() && bytes[0].toInt().toChar() == '{')
            if (looksJson) {
                val resolved = extractImageUrl(JSONObject(String(bytes, Charsets.UTF_8)), url)
                    ?: return fail("这个接口里没找到图片地址")
                target = resolved
                val second = bgGet(target)
                if (!second.first) return fail("下载图片失败（HTTP 错误）")
                ct = second.second
                bytes = second.third
            }

            if (!ct.startsWith("image/")) return fail("返回的不是图片（$ct）")
            if (bytes.isEmpty()) return fail("图片内容为空")
            if (bytes.size > 12 * 1024 * 1024) return fail("图片超过 12MB，换小一点的")

            appearanceDir.mkdirs()
            val ext = when {
                ct.contains("png") -> "png"
                ct.contains("webp") -> "webp"
                ct.contains("gif") -> "gif"
                else -> "jpg"
            }
            val name = "bg.$ext"
            // 先写临时文件再改名，避免读到写了一半的文件
            val tmp = java.io.File(appearanceDir, "bg.tmp")
            tmp.writeBytes(bytes)
            val old = bgImageFile(readBgMeta())
            if (old.exists() && old.name != name) old.delete()
            val dst = java.io.File(appearanceDir, name)
            if (dst.exists()) dst.delete()
            tmp.renameTo(dst)

            bgJsonFile.writeText(JSONObject().apply {
                put("url", url)
                put("resolvedUrl", target)
                put("contentType", ct)
                put("file", name)
                put("savedAt", System.currentTimeMillis())
            }.toString())

            appearanceJson().apply { put("ok", true) }
        } catch (e: Exception) {
            Log.e(TAG, "fetchBackground: ${e.message}")
            fail(e.message ?: "下载失败")
        }
    }

    /** 从常见字段里猜图片地址；相对路径按接口所在域名补全 */
    private fun extractImageUrl(o: JSONObject, base: String): String? {
        o.optJSONArray("images")?.optJSONObject(0)?.let { im ->
            im.optString("url").takeIf { it.isNotEmpty() }?.let { return absolutize(it, base) }
            im.optString("urlbase").takeIf { it.isNotEmpty() }?.let { return absolutize(it, base) }
        }
        for (k in listOf("url", "image", "img", "imageUrl", "image_url", "pic", "picture", "cover")) {
            o.optString(k).takeIf { it.isNotEmpty() }?.let { return absolutize(it, base) }
        }
        o.optJSONObject("data")?.let { return extractImageUrl(it, base) }
        return null
    }

    private fun absolutize(u: String, base: String): String {
        if (u.startsWith("http://") || u.startsWith("https://")) return u
        return try {
            val b = java.net.URI(base)
            val scheme = b.scheme ?: "https"
            val host = b.host ?: return u
            val port = if (b.port > 0) ":${b.port}" else ""
            "$scheme://$host$port" + if (u.startsWith("/")) u else "/$u"
        } catch (e: Exception) {
            u
        }
    }

    fun start() {
        plugins.init()
        plugins.runBootScripts()
        server = embeddedServer(CIO, port = port, host = "0.0.0.0", configure = {
            connectionIdleTimeoutSeconds = 60
        }) {
            install(CallLogging) { level = Level.INFO }
            install(WebSockets) {
                pingPeriod = java.time.Duration.ofSeconds(15)
                timeout = java.time.Duration.ofSeconds(30)
                maxFrameSize = 10 * 1024 * 1024
                masking = false
            }

            routing {
                // 全局鉴权：除登录外，所有 /api/* 与 WS 均需携带会话 token
                // 字体资源非敏感，放行以便 CSS @font-face 直接加载（CSS 无法携带鉴权头）
                intercept(io.ktor.server.application.ApplicationCallPipeline.Plugins) {
                    val path = call.request.path()
                    val isFont = path.startsWith("/api/proxy/fonts/")
                    // 背景图同理：它要当 CSS background-image 用，CSS 带不了鉴权头。
                    // 只放行 GET 读图；写入/清除仍走下面的 checkAuth。
                    val isBgImage = path.startsWith("/api/appearance/background") &&
                        call.request.httpMethod == io.ktor.http.HttpMethod.Get
                    val needAuth = (path.startsWith("/api/") && path != "/api/auth/login") || path == "/ws/scrcpy"
                    if (needAuth && !isFont && !isBgImage && !checkAuth(call)) {
                        finish()
                    }
                }

                get("/api/status") {
                    val now = System.currentTimeMillis()
                    if (cachedStatusJson.isNotEmpty() && now - cachedStatusTime < cacheTtlMs) {
                        call.respondText(cachedStatusJson, ContentType.Application.Json)
                        return@get
                    }
                    val status = JSONObject().apply {
                        put("model", Build.MODEL)
                        put("manufacturer", Build.MANUFACTURER)
                        put("kernel", System.getProperty("os.version") ?: "Unknown")
                        put("android_ver", Build.VERSION.RELEASE)
                        put("uptime", getAndroidUptime())
                        
                        val (batteryPct, batteryTemp, isCharging) = getBatteryInfo()
                        put("battery_level", batteryPct)
                        put("battery_temp", batteryTemp / 10.0)
                        put("is_charging", isCharging)

                        batteryStats.updateStats(batteryPct, isCharging)
                        
                        val memInfo = ActivityManager.MemoryInfo()
                        (this@CoreWebServer.context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memInfo)
                        val totalMem = memInfo.totalMem / (1024 * 1024)
                        val availMem = memInfo.availMem / (1024 * 1024)
                        put("mem_total", totalMem)
                        put("mem_used", totalMem - availMem)
                        put("memory_usage", ((totalMem - availMem) * 100 / totalMem).toInt())
                        
                        val stat = StatFs(Environment.getDataDirectory().path)
                        val totalStorage = (stat.blockCountLong * stat.blockSizeLong) / (1024 * 1024)
                        val availStorage = (stat.availableBlocksLong * stat.blockSizeLong) / (1024 * 1024)
                        put("storage_total", totalStorage)
                        put("storage_used", totalStorage - availStorage)
                        put("storage_usage", ((totalStorage - availStorage) * 100 / totalStorage).toInt())
                        put("cpu_usage", sysStats.getDetailedStats().optJSONObject("cpu")?.optInt("total_usage", 5) ?: 5)
                    }
                    cachedStatusJson = status.toString()
                    cachedStatusTime = System.currentTimeMillis()
                    call.respondText(cachedStatusJson, ContentType.Application.Json)
                }

                // 高精度性能详情 API
                get("/api/system/details") {
                    val now = System.currentTimeMillis()
                    if (cachedDetailsJson.isNotEmpty() && now - cachedDetailsTime < cacheTtlMs) {
                        call.respondText(cachedDetailsJson, ContentType.Application.Json)
                        return@get
                    }
                    cachedDetailsJson = sysStats.getDetailedStats().toString()
                    cachedDetailsTime = now
                    call.respondText(cachedDetailsJson, ContentType.Application.Json)
                }

                get("/api/battery/history") {
                    call.respondText(batteryStats.getHistory(), ContentType.Application.Json)
                }

                webSocket("/api/remote/control") {
                    try {
                        remote.startStreaming(this)
                        incoming.consumeEach { frame ->
                            if (frame is Frame.Text) {
                                val json = JSONObject(frame.readText())
                                remote.injectInput(
                                    action = json.optString("action"),
                                    x = json.optInt("x"),
                                    y = json.optInt("y"),
                                    x2 = json.optInt("x2", 0),
                                    y2 = json.optInt("y2", 0),
                                    key = if (json.has("key")) json.getString("key") else null
                                )
                            }
                        }
                    } catch (e: Exception) {
                        Log.e("WS_DEBUG", "WS Error: ${e.message}")
                    } finally {
                        remote.stopStreaming()
                    }
                }

                webSocket("/ws/scrcpy") {
                    try {
                        scrcpy.startServer()
                        scrcpy.handleWebSocket(this)
                    } catch (e: Exception) {
                        Log.e("WS_SCRCPY", "Error: ${e.message}")
                    } finally {
                        // 断开清理放到 IO 线程并捕获异常，避免在 Ktor 协程上下文操作进程导致未捕获崩溃
                        try {
                            withContext(Dispatchers.IO) { scrcpy.stopServer() }
                        } catch (e: Exception) {
                            Log.e("WS_SCRCPY", "Cleanup error: ${e.message}")
                        }
                    }
                }

                get("/api/scrcpy/start") {
                    scrcpy.startServer()
                    call.respondText("{\"result\":\"Command sent\"}", ContentType.Application.Json)
                }

                get("/api/at/send") {
                    val cmd = call.request.queryParameters["cmd"] ?: ""
                    val phoneId = call.request.queryParameters["n"]?.toIntOrNull() ?: 0
                    val result = withContext(Dispatchers.IO) { atManager.sendAt(cmd, phoneId) }
                    call.respondText(JSONObject().apply { put("result", result) }.toString(), ContentType.Application.Json)
                }

                route("/api/proxy/{...}") {
                    handle {
                        val path = call.request.uri.removePrefix("/api/proxy")
                        val method = call.request.httpMethod.value
                        val query = call.request.queryString()
                        val postData = if (method == "POST") call.receiveText() else null
                        val response = withContext(Dispatchers.IO) { bridge.dispatch(path, method, if (query.isEmpty()) null else query, postData) }
                        val ct = response.contentType?.let { ContentType.parse(it) } ?: ContentType.Application.OctetStream
                        call.respondBytes(response.bytes, ct)
                    }
                }

                // ===== Samba 管理 API（仅配置读写，启停由前端通过 goform 控制）=====
                get("/api/samba/status") { call.respondText(samba.getStatus().toString(), ContentType.Application.Json) }
                get("/api/samba/config") { call.respondText(samba.readConfig(), ContentType.Text.Plain) }
                post("/api/samba/config") {
                    val body = call.receiveText()
                    val postData = extractPostData(body)
                    call.respondText(samba.writeConfig(postData.optString("content", "")), ContentType.Application.Json)
                }
                get("/api/samba/shares") { call.respondText(samba.getShares().toString(), ContentType.Application.Json) }
                post("/api/samba/shares") {
                    val body = call.receiveText()
                    val postData = extractPostData(body)
                    val shares = postData.optJSONArray("shares") ?: JSONArray()
                    call.respondText(samba.updateShares(shares), ContentType.Application.Json)
                }
                post("/api/samba/share/add") {
                    val name = call.request.queryParameters["name"] ?: ""
                    val path = call.request.queryParameters["path"] ?: ""
                    val comment = call.request.queryParameters["comment"] ?: ""
                    call.respondText(samba.addShare(name, path, comment), ContentType.Application.Json)
                }
                post("/api/samba/share/remove") {
                    val name = call.request.queryParameters["name"] ?: ""
                    call.respondText(samba.removeShare(name), ContentType.Application.Json)
                }

                get("/api/ttyd/status") { call.respondText(ttyd.getStatus().toString(), ContentType.Application.Json) }
                post("/api/ttyd/start") { call.respondText(JSONObject().apply { put("result", ttyd.start()) }.toString(), ContentType.Application.Json) }
                post("/api/ttyd/stop") { call.respondText(JSONObject().apply { put("result", ttyd.stop()) }.toString(), ContentType.Application.Json) }

                // ===== 网络 ADB 控制 =====
                get("/api/adb-net/status") {
                    call.respondText(netAdb.getStatus().toString(), ContentType.Application.Json)
                }
                post("/api/adb-net/action") {
                    if (!checkAuth(call)) return@post
                    val postData = extractPostData(call.receiveText())
                    val enable = postData.optBoolean("enable", false)
                    val port = postData.optInt("port", 5555)
                    val result = withContext(Dispatchers.IO) { netAdb.setEnabled(enable, port) }
                    call.respondText(result.toString(), ContentType.Application.Json)
                }
                
                // ===== USB0 状态检测 & WiFi 自动开关 =====
                get("/api/usb0/status") {
                    val result = withContext(Dispatchers.IO) {
                        try {
                            val operstate = java.io.File("/sys/class/net/usb0/operstate").readText().trim()
                            JSONObject().apply {
                                put("present", true)
                                put("operstate", operstate)
                                put("is_up", operstate == "up")
                            }
                        } catch (e: Exception) {
                            JSONObject().apply {
                                put("present", false)
                                put("operstate", "down")
                                put("is_up", false)
                            }
                        }
                    }
                    call.respondText(result.toString(), ContentType.Application.Json)
                }

                // ===== 外观：自定义背景图（服务端缓存）=====
                // GET 图片本身不校验 token —— CSS 的 background-image 带不了自定义请求头。
                // 背景图不是敏感数据，且写入/清除都需要鉴权。
                get("/api/appearance") {
                    call.respondText(appearanceJson().toString(), ContentType.Application.Json)
                }

                post("/api/appearance/background") {
                    if (!checkAuth(call)) return@post
                    val postData = extractPostData(call.receiveText())
                    val url = postData.optString("url", "")
                    val result = withContext(Dispatchers.IO) { fetchBackground(url) }
                    call.respondText(result.toString(), ContentType.Application.Json)
                }

                get("/api/appearance/background") {
                    val f = bgImageFile(readBgMeta())
                    if (!f.exists() || f.length() == 0L) {
                        call.respondText(
                            "{\"ok\":false,\"msg\":\"未设置背景图\"}",
                            ContentType.Application.Json, HttpStatusCode.NotFound
                        )
                        return@get
                    }
                    // no-cache：每次校验，但内容本身不会变，所以刷新/重启后拿到的是同一张
                    call.response.header("Cache-Control", "no-cache")
                    call.respondFile(f)
                }

                delete("/api/appearance/background") {
                    if (!checkAuth(call)) return@delete
                    bgImageFile(readBgMeta()).delete()
                    if (bgJsonFile.exists()) bgJsonFile.delete()
                    call.respondText("{\"ok\":true}", ContentType.Application.Json)
                }

                // 保存/读取 WiFi 自动开关配置
                get("/api/wifi/auto-switch") {
                    val config = withContext(Dispatchers.IO) {
                        try {
                            val f = java.io.File(this@CoreWebServer.context.filesDir, "auto_wifi_switch.json")
                            if (f.exists()) f.readText() else "{\"enabled\":false}"
                        } catch (e: Exception) { "{\"enabled\":false}" }
                    }
                    call.respondText(config, ContentType.Application.Json)
                }
                post("/api/wifi/auto-switch") {
                    val body = call.receiveText()
                    val postData = extractPostData(body)
                    val enabled = postData.optBoolean("enabled", false)
                    withContext(Dispatchers.IO) {
                        try {
                            val f = java.io.File(this@CoreWebServer.context.filesDir, "auto_wifi_switch.json")
                            f.parentFile?.mkdirs()
                            f.writeText("{\"enabled\":$enabled}")
                        } catch (e: Exception) { Log.e("AUTO_WIFI", "Save config failed", e) }
                    }
                    call.respondText("{\"result\":\"saved\"}", ContentType.Application.Json)
                }

                post("/api/auth/login") {
                    val now = System.currentTimeMillis()
                    if (now < loginLockUntil) {
                        val remain = (loginLockUntil - now) / 1000
                        call.respondText(JSONObject().put("result", -2).put("msg", "尝试次数过多，请 ${remain} 秒后再试").toString(), ContentType.Application.Json)
                        return@post
                    }

                    val body = call.receiveText()
                    val pass = extractPostData(body).optString("password", "")
                    val result = withContext(Dispatchers.IO) { bridge.doLogin(pass) }
                    if (result == "SUCCESS") {
                        loginFails = 0
                        call.respondText("{\"result\":0, \"token\":\"${getSessionToken()}\"}", ContentType.Application.Json)
                    } else {
                        loginFails++
                        if (loginFails >= 5) {
                            loginLockUntil = now + 60_000
                            loginFails = 0
                        }
                        call.respondText("{\"result\":-1, \"msg\":\"$result\"}", ContentType.Application.Json)
                    }
                }

                post("/api/auth/change-password") {
                    val body = call.receiveText()
                    val postData = extractPostData(body)
                    val oldPwd = postData.optString("old", "")
                    val newPwd = postData.optString("new", "")
                    val payload = "oldPassword=$oldPwd&newPassword=$newPwd&goformId=CHANGE_PASSWORD"
                    val response = withContext(Dispatchers.IO) { bridge.dispatch("/goform/goform_set_cmd_process", "POST", null, payload) }
                    val raw = String(response.bytes)
                    // 修改成功则轮换 token，使旧会话立即失效
                    val ok = try {
                        val j = JSONObject(raw)
                        val r = j.opt("result")
                        r == null || r.toString() == "0" || r.toString().equals("success", true)
                    } catch (e: Exception) {
                        raw.contains("success") || raw.contains("\"0\"")
                    }
                    if (ok) rotateSessionToken()
                    call.respondText(raw, ContentType.Application.Json)
                }

                // ===== 插件系统 API =====
                get("/api/plugins") {
                    call.respondText(plugins.getPlugins().toString(), ContentType.Application.Json)
                }

                post("/api/plugins/install") {
                    if (!checkAuth(call)) return@post
                    var installed = JSONObject().put("result", "error").put("msg", "未收到文件")
                    try {
                        val multipart = call.receiveMultipart()
                        while (true) {
                            val current = multipart.readPart() ?: break
                            if (current is PartData.FileItem) {
                                // 在 IO 线程读取，避免 streamProvider 内部 runBlocking 阻塞 CIO 事件循环，
                                // 导致大文件上传读取不完整
                                val bytes = withContext(Dispatchers.IO) { current.streamProvider().readBytes() }
                                installed = plugins.installFromBytes(bytes, current.originalFileName ?: "plugin${PluginManager.EXT}")
                            }
                            current.dispose()
                        }
                    } catch (e: Exception) {
                        Log.e("PLUGIN_API", "安装异常", e)
                        installed = JSONObject().put("result", "error").put("msg", e.message ?: "安装异常")
                    }
                    call.respondText(installed.toString(), ContentType.Application.Json)
                }

                post("/api/plugins/preview") {
                    if (!checkAuth(call)) return@post
                    var preview = JSONObject().put("result", "error").put("msg", "未收到文件")
                    try {
                        val multipart = call.receiveMultipart()
                        while (true) {
                            val current = multipart.readPart() ?: break
                            if (current is PartData.FileItem) {
                                val bytes = withContext(Dispatchers.IO) { current.streamProvider().readBytes() }
                                preview = plugins.preview(bytes, current.originalFileName ?: "plugin${PluginManager.EXT}")
                            }
                            current.dispose()
                        }
                    } catch (e: Exception) {
                        Log.e("PLUGIN_API", "预览异常", e)
                        preview = JSONObject().put("result", "error").put("msg", e.message ?: "预览异常")
                    }
                    call.respondText(preview.toString(), ContentType.Application.Json)
                }

                post("/api/plugins/install-url") {
                    if (!checkAuth(call)) return@post
                    val postData = extractPostData(call.receiveText())
                    val url = postData.optString("url", "")
                    if (url.isBlank()) {
                        call.respondText(JSONObject().put("result", "error").put("msg", "URL 不能为空").toString(), ContentType.Application.Json)
                    } else {
                        val result = withContext(Dispatchers.IO) { plugins.installFromUrl(url) }
                        call.respondText(result.toString(), ContentType.Application.Json)
                    }
                }

                post("/api/plugins/{id}/uninstall") {
                    if (!checkAuth(call)) return@post
                    val result = withContext(Dispatchers.IO) { plugins.uninstall(call.parameters["id"] ?: "") }
                    call.respondText(result.toString(), ContentType.Application.Json)
                }

                post("/api/plugins/{id}/start") {
                    if (!checkAuth(call)) return@post
                    val result = withContext(Dispatchers.IO) { plugins.start(call.parameters["id"] ?: "") }
                    call.respondText(result.toString(), ContentType.Application.Json)
                }

                post("/api/plugins/{id}/stop") {
                    if (!checkAuth(call)) return@post
                    val result = withContext(Dispatchers.IO) { plugins.stop(call.parameters["id"] ?: "") }
                    call.respondText(result.toString(), ContentType.Application.Json)
                }

                post("/api/plugins/{id}/restart") {
                    if (!checkAuth(call)) return@post
                    val result = withContext(Dispatchers.IO) { plugins.restart(call.parameters["id"] ?: "") }
                    call.respondText(result.toString(), ContentType.Application.Json)
                }

                post("/api/plugins/{id}/exec") {
                    if (!checkAuth(call)) return@post
                    val postData = extractPostData(call.receiveText())
                    val cmd = postData.optString("command", "")
                    val result = withContext(Dispatchers.IO) { plugins.exec(call.parameters["id"] ?: "", cmd) }
                    call.respondText(result.toString(), ContentType.Application.Json)
                }

                get("/api/plugins/{id}/config") {
                    if (!checkAuth(call)) return@get
                    call.respondText(plugins.getConfig(call.parameters["id"] ?: "").toString(), ContentType.Application.Json)
                }

                post("/api/plugins/{id}/config") {
                    if (!checkAuth(call)) return@post
                    val postData = extractPostData(call.receiveText())
                    val result = plugins.setConfig(call.parameters["id"] ?: "", postData)
                    call.respondText(result.toString(), ContentType.Application.Json)
                }

                get("/api/plugins/{id}/file") {
                    if (!checkAuth(call)) return@get
                    val id = call.parameters["id"] ?: ""
                    val path = call.request.queryParameters["path"] ?: ""
                    val (content, err) = plugins.readFile(id, path)
                    if (err != null) {
                        call.respondText(JSONObject().put("result", "error").put("msg", err).toString(), ContentType.Application.Json)
                    } else {
                        call.respondText(content ?: "", ContentType.Text.Plain)
                    }
                }

                post("/api/plugins/{id}/file") {
                    if (!checkAuth(call)) return@post
                    val postData = extractPostData(call.receiveText())
                    val err = plugins.writeFile(call.parameters["id"] ?: "", postData.optString("path", ""), postData.optString("content", ""))
                    if (err == null) {
                        call.respondText("{\"result\":\"success\"}", ContentType.Application.Json)
                    } else {
                        call.respondText(JSONObject().put("result", "error").put("msg", err).toString(), ContentType.Application.Json)
                    }
                }

                // 兜底静态资源：优先插件 www 目录，否则从 assets/web 读取
                // （插件静态资源并入此路由，避免 Ktor tailcard 与通配路由的匹配歧义）
                get("{...}") {
                    val rawPath = call.request.path().removePrefix("/")
                    val path = if (rawPath.isBlank()) "index.html" else rawPath
                    call.response.headers.append("Cache-Control", "no-cache")

                    // 插件静态资源：/plugins/{id}/www/{...}
                    if (path.startsWith("plugins/")) {
                        val parts = path.split("/")
                        if (parts.size >= 4 && parts[0] == "plugins" && parts[2] == "www") {
                            val pluginId = parts[1]
                            val rel = parts.drop(3).joinToString("/")
                            val file = plugins.getWwwFile(pluginId, rel.ifEmpty { "index.html" })
                            if (file != null) {
                                call.respondFile(file)
                                return@get
                            }
                        }
                        call.respond(HttpStatusCode.NotFound)
                        return@get
                    }

                    try {
                        val inputStream: InputStream = this@CoreWebServer.context.assets.open("web/$path")
                        call.respondBytes(inputStream.readBytes(), ContentType.parse(getMimeType(path)))
                    } catch (e: Exception) { call.respond(HttpStatusCode.NotFound) }
                }
            }
        }.start(wait = false)
    }

    @Suppress("DEPRECATION")
    private fun getBatteryInfo(): Triple<Int, Int, Boolean> {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val temp = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        val pct = if (level != -1 && scale != -1) (level * 100 / scale.toFloat()).toInt() else 0
        return Triple(pct, temp, charging)
    }

    private fun getAndroidUptime(): String {
        val uptimeMillis = android.os.SystemClock.elapsedRealtime()
        val days = uptimeMillis / (24 * 60 * 60 * 1000)
        val hours = (uptimeMillis % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)
        val minutes = (uptimeMillis % (60 * 60 * 1000)) / (60 * 1000)
        return if (days > 0) "${days}d ${hours}h ${minutes}m" else "${hours}h ${minutes}m"
    }

    private fun getMimeType(path: String): String {
        return when {
            path.endsWith(".css") -> "text/css"
            path.endsWith(".js") -> "application/javascript"
            path.endsWith(".html") -> "text/html"
            path.endsWith(".svg") -> "image/svg+xml"
            path.endsWith(".png") -> "image/png"
            else -> "text/plain"
        }
    }

    /**
     * 从 Api.post 发送的 form-urlencoded 格式中提取 JSON 数据
     * 前端 Api.post 发送格式: postData={"key":"value"}
     */
    private fun extractPostData(body: String): JSONObject {
        return try {
            if (body.startsWith("postData=")) {
                val decoded = java.net.URLDecoder.decode(body.removePrefix("postData="), "UTF-8")
                JSONObject(decoded)
            } else {
                JSONObject(body)
            }
        } catch (e: Exception) {
            JSONObject()
        }
    }

    fun stop() {
        server?.stop(1000, 2000)
        scrcpy.stopServer()
        remote.stop()
    }
}
