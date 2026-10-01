package com.teno.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * 背景常駐（前台服務，使用者預設關）：讓 Widget 低間隔在 Doze 下也能穩定刷新。
 * 系統強制一則常駐通知（IMPORTANCE_MIN）。收到 stop 或設定關閉即自殺。
 */
class TenoResidentService : Service() {
    companion object {
        @Volatile var running = false
    }

    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            val c = TenoWidget.cfg(this@TenoResidentService)
            if (!c.residentOn) {
                stopSelf()
                return
            }
            TenoWidget.renderAll(this@TenoResidentService)
            handler.postDelayed(this, c.periodMs)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        running = true
        startForeground(TenoWidget.NOTIFY_ID + 1, buildNotif())
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, 3_000L)
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacks(tick)
        super.onDestroy()
    }

    private fun buildNotif(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel("teno_resident", "常駐", NotificationManager.IMPORTANCE_MIN))
        }
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "teno_resident")
                else Notification.Builder(this)
        return b
            .setSmallIcon(R.drawable.ic_stat_teno)
            .setContentTitle("Teno 常駐")
            .setContentText("桌面 Widget 定期刷新中")
            .setOngoing(true)
            .build()
    }
}
