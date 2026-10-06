package com.teno.app

import android.app.Activity
import android.app.AlarmManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "WidgetPlugin"

@InvokeArg
class SaveCfgArgs {
    var rotateMin: Int = 60
    var notifyOn: Boolean = false
    var notifyIntervalMin: Int = 60
    var notifyDue: Boolean = true
    var notifyWord: Boolean = true
    var notifyGoal: Boolean = true
    var residentOn: Boolean = false
    var wordFields: String = ""   // 逗號分隔的 words 欄名（syllables,deck,…）
}

/**
 * Widget 設定與控制命令（JS 設定頁 → Rust → 這裡）。
 * 資料讀取／渲染／鬧鐘全在 TenoWidget；這裡只做參數進出與權限。
 */
@TauriPlugin
class WidgetPlugin(private val activity: Activity) : Plugin(activity) {

    private fun statusJs(): JSObject {
        val c = TenoWidget.cfg(activity)
        val js = JSObject()
        js.put("supported", true)
        js.put("rotateMin", c.rotateMin)
        js.put("notifyOn", c.notifyOn)
        js.put("notifyIntervalMin", c.notifyIntervalMin)
        js.put("notifyDue", c.notifyDue)
        js.put("notifyWord", c.notifyWord)
        js.put("notifyGoal", c.notifyGoal)
        js.put("residentOn", c.residentOn)
        js.put("wordFields", c.wordFields.joinToString(","))
        js.put("dbOk", TenoWidget.dbOk(activity))
        js.put("notifGranted",
            Build.VERSION.SDK_INT < 33 ||
                activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED)
        val am = activity.getSystemService(AlarmManager::class.java)
        js.put("exactAlarmOk", Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms())
        return js
    }

    @Command
    fun getStatus(invoke: Invoke) {
        invoke.resolve(statusJs())
    }

    @Command
    fun saveConfig(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveCfgArgs::class.java)
            TenoWidget.saveCfg(activity, TenoWidget.Cfg(
                rotateMin = args.rotateMin,
                notifyOn = args.notifyOn,
                notifyIntervalMin = args.notifyIntervalMin,
                notifyDue = args.notifyDue,
                notifyWord = args.notifyWord,
                notifyGoal = args.notifyGoal,
                residentOn = args.residentOn,
                wordFields = args.wordFields.split(",").map { it.trim() }.filter { it.isNotEmpty() },
            ))
            TenoWidget.armAlarms(activity)
            TenoWidget.renderAll(activity)
            TenoWidget.syncResident(activity)
            invoke.resolve(statusJs())
        } catch (e: Exception) {
            invoke.reject("saveConfig: ${e.message}")
        }
    }

    @Command
    fun refreshNow(invoke: Invoke) {
        try {
            TenoWidget.renderAll(activity)
            TenoWidget.armAlarms(activity)
            invoke.resolve(statusJs())
        } catch (e: Exception) {
            invoke.reject("refreshNow: ${e.message}")
        }
    }

    @Command
    fun requestPerms(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 33 &&
            activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 4001)
        }
        if (Build.VERSION.SDK_INT >= 31) {
            val am = activity.getSystemService(AlarmManager::class.java)
            if (!am.canScheduleExactAlarms()) {
                try {
                    activity.startActivity(Intent(
                        Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        Uri.parse("package:${activity.packageName}")))
                } catch (_: Exception) {}
            }
        }
        invoke.resolve(statusJs())
    }
}
