package com.opengw.manager

import android.Manifest
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.provider.Settings
import android.app.ActivityManager
import android.content.IntentFilter
import android.os.BatteryManager
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.content.res.AppCompatResources
import java.net.NetworkInterface

class MainActivity : AppCompatActivity() {

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.all { it.value }
        if (!allGranted) {
            Toast.makeText(this, "保活需要相关权限，请在设置中手动开启", Toast.LENGTH_LONG).show()
        }
    }

    // 被常驻服务占用的端口列表（不可使用）
    private val reservedPorts = setOf(53, 80, 139, 445, 2222, 5555, 8080, 8443, 9090, 9999)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        checkAndRequestPermissions()
        startCoreService()

        // 填充设备信息
        fillDeviceInfo()
        // 填充资源信息
        fillResourceInfo()
        // 设置端口控制
        setupPortControl()
    }

    private fun fillDeviceInfo() {
        val modelText = findViewById<TextView>(R.id.modelText)
        val androidVerText = findViewById<TextView>(R.id.androidVerText)
        val kernelText = findViewById<TextView>(R.id.kernelText)
        val uptimeText = findViewById<TextView>(R.id.uptimeText)
        val ipText = findViewById<TextView>(R.id.ipText)
        val versionText = findViewById<TextView>(R.id.versionText)
        val addressText = findViewById<TextView>(R.id.addressText)
        val portText = findViewById<TextView>(R.id.portText)

        val ip = getLocalIpAddress()
        val verName = try {
            packageManager.getPackageInfo(packageName, 0).versionName
        } catch (e: Exception) { "1.0" }

        modelText.text = "${Build.MANUFACTURER} ${Build.MODEL}"
        androidVerText.text = "Android ${Build.VERSION.RELEASE}"
        kernelText.text = System.getProperty("os.version") ?: "Unknown"
        uptimeText.text = getAndroidUptime()
        ipText.text = ip
        versionText.text = "v$verName"
        addressText.text = "http://$ip:${getCurrentPort()}"
        portText.text = getCurrentPort().toString()
    }

    @Suppress("DEPRECATION")
    private fun fillResourceInfo() {
        // 电池信息
        val batteryIntent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val temp = batteryIntent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0
        val batStatus = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val isCharging = batStatus == BatteryManager.BATTERY_STATUS_CHARGING || batStatus == BatteryManager.BATTERY_STATUS_FULL
        val batteryPct = if (level != -1 && scale != -1) (level * 100 / scale.toFloat()).toInt() else 0

        val batteryText = findViewById<TextView>(R.id.batteryText)
        val batteryProgress = findViewById<ProgressBar>(R.id.batteryProgress)
        batteryText.text = "$batteryPct% (${temp / 10.0}°C)"
        // 充电指示原来是在文本里塞一个闪电 emoji。改成右侧挂一枚矢量图标：
        // emoji 依赖设备字体，不同机型字形差异很大。
        if (isCharging) {
            val bolt = AppCompatResources.getDrawable(this, R.drawable.ic_bolt)
            bolt?.setBounds(0, 0, bolt.intrinsicWidth, bolt.intrinsicHeight)
            batteryText.setCompoundDrawables(null, null, bolt, null)
            batteryText.compoundDrawablePadding = (6 * resources.displayMetrics.density).toInt()
        } else {
            batteryText.setCompoundDrawables(null, null, null, null)
        }
        batteryProgress.progress = batteryPct

        // 内存信息
        val memInfo = ActivityManager.MemoryInfo()
        (getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memInfo)
        val totalMem = memInfo.totalMem / (1024 * 1024)
        val availMem = memInfo.availMem / (1024 * 1024)
        val usedMem = totalMem - availMem
        val memPct = (usedMem * 100 / totalMem).toInt()

        val memoryText = findViewById<TextView>(R.id.memoryText)
        val memoryProgress = findViewById<ProgressBar>(R.id.memoryProgress)
        memoryText.text = "${usedMem}MB / ${totalMem}MB ($memPct%)"
        memoryProgress.progress = memPct

        // 存储信息
        val stat = StatFs(Environment.getDataDirectory().path)
        val totalStorage = (stat.blockCountLong * stat.blockSizeLong) / (1024 * 1024)
        val availStorage = (stat.availableBlocksLong * stat.blockSizeLong) / (1024 * 1024)
        val usedStorage = totalStorage - availStorage
        val storagePct = (usedStorage * 100 / totalStorage).toInt()

        val storageText = findViewById<TextView>(R.id.storageText)
        val storageProgress = findViewById<ProgressBar>(R.id.storageProgress)
        storageText.text = formatStorage(usedStorage) + " / " + formatStorage(totalStorage) + " ($storagePct%)"
        storageProgress.progress = storagePct
    }

    private fun formatStorage(mb: Long): String {
        return when {
            mb >= 1024 -> "%.1fGB".format(mb / 1024.0)
            else -> "${mb}MB"
        }
    }

    private fun setupPortControl() {
        val portInput = findViewById<EditText>(R.id.portInput)
        val applyBtn = findViewById<Button>(R.id.applyPortBtn)
        val portHintText = findViewById<TextView>(R.id.portHintText)

        // 显示当前端口
        portInput.setText(getCurrentPort().toString())

        applyBtn.setOnClickListener {
            val text = portInput.text.toString().trim()
            val newPort = text.toIntOrNull()

            if (newPort == null || newPort < 1024 || newPort > 65535) {
                Toast.makeText(this, "端口必须在 1024-65535 之间", Toast.LENGTH_SHORT).show()
                portInput.setText(getCurrentPort().toString())
                return@setOnClickListener
            }

            if (newPort in reservedPorts) {
                Toast.makeText(this, "端口 $newPort 已被常驻服务占用，请选择其他端口", Toast.LENGTH_LONG).show()
                portInput.setText(getCurrentPort().toString())
                return@setOnClickListener
            }

            if (newPort == getCurrentPort()) {
                Toast.makeText(this, "端口未改变", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            // 保存新端口并重启服务器
            savePort(newPort)
            Toast.makeText(this, "端口已修改为 $newPort，正在重启服务器...", Toast.LENGTH_LONG).show()
            portHintText.text = "端口已修改为 $newPort，服务器正在重启..."

            // 重启服务
            stopService(Intent(this, CoreBackgroundService::class.java))
            startCoreService()

            // 更新显示
            findViewById<TextView>(R.id.portText).text = newPort.toString()
            findViewById<TextView>(R.id.addressText).text = "http://${getLocalIpAddress()}:$newPort"
        }
    }

    private fun getCurrentPort(): Int {
        val sp = getSharedPreferences("server_config", Context.MODE_PRIVATE)
        return sp.getInt("server_port", 8000)
    }

    private fun savePort(port: Int) {
        val sp = getSharedPreferences("server_config", Context.MODE_PRIVATE)
        sp.edit().putInt("server_port", port).apply()
    }

    private fun checkAndRequestPermissions() {
        val permissions = mutableListOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        requestPermissionLauncher.launch(permissions.toTypedArray())

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    startActivity(intent)
                }
            }
        }

        if (!hasUsageStatsPermission()) {
            Toast.makeText(this, "请开启'使用情况访问'", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        }
    }

    private fun hasUsageStatsPermission(): Boolean {
        val appOps = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), packageName)
        } else {
            appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun startCoreService() {
        val intent = Intent(this, CoreBackgroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun getAndroidUptime(): String {
        val uptimeMillis = android.os.SystemClock.elapsedRealtime()
        val days = uptimeMillis / (24 * 60 * 60 * 1000)
        val hours = (uptimeMillis % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)
        val minutes = (uptimeMillis % (60 * 60 * 1000)) / (60 * 1000)
        return if (days > 0) "${days}d ${hours}h ${minutes}m" else "${hours}h ${minutes}m"
    }

    fun getLocalIpAddress(): String {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces().toList()
            val br0 = interfaces.find { it.name == "br0" }
            br0?.inetAddresses?.toList()?.find { !it.isLoopbackAddress && it.address.size == 4 }?.let {
                return it.hostAddress
            }
            val wlan0 = interfaces.find { it.name == "wlan0" }
            wlan0?.inetAddresses?.toList()?.find { !it.isLoopbackAddress && it.address.size == 4 }?.let {
                return it.hostAddress
            }
            for (iface in interfaces) {
                if (iface.name.contains("Meta") || iface.name.contains("tun") || iface.name.contains("rmnet")) continue
                val addr = iface.inetAddresses.toList().find { !it.isLoopbackAddress && it.address.size == 4 }
                if (addr != null) return addr.hostAddress
            }
        } catch (e: Exception) {}
        return "127.0.0.1"
    }
}
