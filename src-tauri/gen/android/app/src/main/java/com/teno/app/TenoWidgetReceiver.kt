package com.teno.app

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * 兩顆 widget 的共用基底：新增／更新時渲染＋武裝鬧鐘（PendingIntent 取代，重入安全）。
 * 狀態與抽字是兩個獨立 receiver —— 桌面上可各放一颗、各刪各的，鬧鐘照有無抽字實例武裝。
 */
open class TenoWidgetProviderBase : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        TenoWidget.renderAll(context)
        TenoWidget.armAlarms(context)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        val mgr = AppWidgetManager.getInstance(context)
        val statusGone = mgr.getAppWidgetIds(
            ComponentName(context, TenoStatusWidgetProvider::class.java)).isEmpty()
        val wordGone = mgr.getAppWidgetIds(
            ComponentName(context, TenoWordWidgetProvider::class.java)).isEmpty()
        // 兩顆都移除 → 換字／日界線鬧鐘作廢；通知獨立（設定頁可無 widget 使用）
        if (statusGone && wordGone) {
            TenoWidget.cancelAlarms(context, includeNotify = false)
        }
    }
}

/** 狀態 widget：今日到期 新／學／復三色數字 ＋ 今日進度。 */
class TenoStatusWidgetProvider : TenoWidgetProviderBase()

/** 抽字 widget：隨機一字＋音標／詞性＋釋義；⟳ 手動換字、間隔自動輪播。 */
class TenoWordWidgetProvider : TenoWidgetProviderBase()

/**
 * 鬧鐘與系統廣播接收器（ROTATE／DAY／NOTIFY／BOOT_COMPLETED）。
 * 動作都短；goAsync 丟背景緒避免主緒磁碟讀（StrictMode）。
 */
class TenoRefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val pending = goAsync()
        Thread {
            try {
                when (action) {
                    Intent.ACTION_BOOT_COMPLETED -> {
                        TenoWidget.armAlarms(context)
                        TenoWidget.syncResident(context)
                        TenoWidget.renderAll(context)
                    }
                    TenoWidget.ACTION_NOTIFY -> {
                        TenoWidget.postNotification(context)
                        TenoWidget.armAlarms(context)   // 明日同一時間再推
                    }
                    else -> {                          // ROTATE + DAY：重畫＋重武裝
                        TenoWidget.renderAll(context)
                        TenoWidget.armAlarms(context)
                    }
                }
            } finally {
                pending.finish()
            }
        }.start()
    }
}
