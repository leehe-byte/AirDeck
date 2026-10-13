package com.opengw.manager

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class CoreBackgroundService : Service() {
    private val TAG = "保活服务"
    private val CHANNEL_ID = "AirDeck_Service"
    private val NOTIFICATION_ID = 1001
    
    private var webServer: CoreWebServer? = null
    private var wakeLockManager: WakeLockManager? = null
    private var heartbeatScheduler: ScheduledExecutorService? = null
    private var usbDetectScheduler: ScheduledExecutorService? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "服务创建中...")
        wakeLockManager = WakeLockManager(this)
        wakeLockManager?.acquire("CoreService")
        
        startForegroundService()
        startWebServer()
        startHeartbeat()
        startUsbDetect()
    }

    private fun startForegroundService() {
        val channelName = "网关管理后台服务"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val chan = NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
            chan.lightColor = Color.BLUE
            chan.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(chan)
        }

        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setOngoing(true)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle("网关管理服务运行中")
            .setContentText("正在监控网络状态并提供 Web 服务")
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(pendingIntent)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    private fun getServerPort(): Int {
        val sp = getSharedPreferences("server_config", Context.MODE_PRIVATE)
        return sp.getInt("server_port", 8000)
    }

    private fun startWebServer() {
        if (webServer == null) {
            val port = getServerPort()
            webServer = CoreWebServer(this, port)
            webServer?.start()
            Log.i(TAG, "Ktor 服务器已在服务中启动 (端口: $port)")
        }
    }

    private var lastUsb0Up: Boolean? = null
    private var httpClient: okhttp3.OkHttpClient? = null

    private fun startHeartbeat() {
        heartbeatScheduler = Executors.newSingleThreadScheduledExecutor()
        heartbeatScheduler?.scheduleAtFixedRate({
            Log.d(TAG, "心跳检查: 服务存活中，网关状态正常")
        }, 0, 30, TimeUnit.SECONDS)
    }

    private fun startUsbDetect() {
        usbDetectScheduler = Executors.newSingleThreadScheduledExecutor()
        usbDetectScheduler?.scheduleAtFixedRate({
            checkUsbAndSwitchWifi()
        }, 2, 5, TimeUnit.SECONDS)
    }

    /** 读取前端保存的 auto_wifi_switch 开关，关闭则不再执行 USB 自动关 WiFi */
    private fun isAutoWifiSwitchEnabled(): Boolean {
        return try {
            val f = java.io.File(filesDir, "auto_wifi_switch.json")
            if (f.exists()) org.json.JSONObject(f.readText()).optBoolean("enabled", false) else false
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 通过 HTTP 请求 localhost:8000/api/proxy/... 发送请求
     * 完全复用前端路径，避免直接调用 BridgeProtocol 带来的会话问题
     */
    private fun proxyPost(path: String, params: Map<String, String>): String {
        try {
            if (httpClient == null) {
                httpClient = okhttp3.OkHttpClient.Builder()
                    .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                    .build()
            }
            val jsonBody = org.json.JSONObject(params).toString()
            val body = "postData=${java.net.URLEncoder.encode(jsonBody, "UTF-8")}"
            val port = getServerPort()
            val request = okhttp3.Request.Builder()
                .url("http://127.0.0.1:$port/api/proxy$path")
                .post(body.toRequestBody("application/x-www-form-urlencoded".toMediaType()))
                .build()
            val response = httpClient!!.newCall(request).execute()
            return response.body?.string() ?: ""
        } catch (e: Exception) {
            Log.e(TAG, "[USB_WIFI] HTTP 请求失败", e)
            return ""
        }
    }

    private fun proxyGet(path: String): String {
        try {
            if (httpClient == null) {
                httpClient = okhttp3.OkHttpClient.Builder()
                    .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                    .build()
            }
            val port = getServerPort()
            val request = okhttp3.Request.Builder()
                .url("http://127.0.0.1:$port/api/proxy$path")
                .get()
                .build()
            val response = httpClient!!.newCall(request).execute()
            return response.body?.string() ?: ""
        } catch (e: Exception) {
            Log.e(TAG, "[USB_WIFI] HTTP 请求失败", e)
            return ""
        }
    }

    /**
     * 检测 usb0 状态并自动开关 WiFi
     * 
     * 逻辑非常简单：
     * 1. 一直检查 usb0 状态
     * 2. usb0 UP → 发 SwitchOption=0 关 WiFi
     * 3. usb0 DOWN → 查 queryAccessPointInfo 看哪个 AP 的 AccessPointSwitchStatus=1
     *    然后发 ChipEnum=chip1/chip2 开对应频段
     */
    private fun checkUsbAndSwitchWifi() {
        if (!isAutoWifiSwitchEnabled()) return
        try {
            // 检测 usb0 状态
            val operstateFile = java.io.File("/sys/class/net/usb0/operstate")
            val isUp = try {
                operstateFile.readText().trim() == "up"
            } catch (e: Exception) {
                false
            }

            if (lastUsb0Up == isUp) return // 状态未变化，跳过
            lastUsb0Up = isUp

            Log.i(TAG, "[USB_WIFI] usb0 状态变化: ${if (isUp) "UP" else "DOWN"}")

            if (isUp) {
                // usb0 UP → 关闭 WiFi（仿照 wifi.js 中 SwitchOption=0）
                Log.d(TAG, "[USB_WIFI] >>> 发送关闭 WiFi")
                val res = proxyPost("/goform/goform_set_cmd_process", mapOf(
                    "goformId" to "switchWiFiModule",
                    "isTest" to "false",
                    "SwitchOption" to "0"
                ))
                Log.i(TAG, "[USB_WIFI] <<< 关闭 WiFi 响应: ${res.take(200)}")
            } else {
                // usb0 DOWN → 查询当前哪个 AP 开着，恢复对应频段
                Log.d(TAG, "[USB_WIFI] >>> 查询 WiFi 频段信息...")
                val infoStr = proxyGet("/goform/goform_get_cmd_process?isTest=false&cmd=queryAccessPointInfo&multi_data=1")
                Log.d(TAG, "[USB_WIFI] WiFi 信息响应: ${infoStr.take(200)}")
                val info = org.json.JSONObject(infoStr)
                val list = info.optJSONArray("ResponseList")
                var chip = "chip1" // 默认 2.4G
                if (list != null && list.length() >= 2) {
                    val ap0 = list.getJSONObject(0)
                    val ap1 = list.getJSONObject(1)
                    val ap0Status = ap0.optString("AccessPointSwitchStatus")
                    val ap1Status = ap1.optString("AccessPointSwitchStatus")
                    Log.d(TAG, "[USB_WIFI] AP0(2.4G) status=$ap0Status, AP1(5G) status=$ap1Status")
                    if (ap1Status == "1") chip = "chip2"
                }
                Log.d(TAG, "[USB_WIFI] >>> 发送开启 WiFi: chip=$chip")
                val res = proxyPost("/goform/goform_set_cmd_process", mapOf(
                    "goformId" to "switchWiFiChip",
                    "isTest" to "false",
                    "ChipEnum" to chip,
                    "GuestEnable" to "0"
                ))
                Log.i(TAG, "[USB_WIFI] <<< 开启 WiFi 响应: ${res.take(200)}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "[USB_WIFI] 异常", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "服务指令接收: START_STICKY")
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.w(TAG, "服务正在销毁，尝试释放资源")
        heartbeatScheduler?.shutdownNow()
        usbDetectScheduler?.shutdownNow()
        webServer?.stop()
        wakeLockManager?.release()
        super.onDestroy()
    }
}
