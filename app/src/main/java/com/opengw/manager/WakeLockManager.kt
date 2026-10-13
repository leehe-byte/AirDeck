package com.opengw.manager

import android.content.Context
import android.os.PowerManager
import android.util.Log

class WakeLockManager(context: Context) {
    private val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    private var wakeLock: PowerManager.WakeLock? = null

    fun acquire(tag: String) {
        if (wakeLock?.isHeld == true) return
        
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AirDeck:$tag").apply {
            acquire()
        }
        Log.i("WakeLock", "WakeLock acquired: $tag")
    }

    fun release() {
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
            wakeLock = null
            Log.i("WakeLock", "WakeLock released")
        }
    }
}
