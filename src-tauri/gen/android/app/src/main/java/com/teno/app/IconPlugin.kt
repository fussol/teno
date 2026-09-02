package com.teno.app

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "IconPlugin"

@InvokeArg
class SetIconArgs {
    lateinit var name: String
}

/**
 * 動態切換 launcher icon（Android 標準 activity-alias 機制）。
 * alias 對照：
 *   original → MainActivity（主 activity，ic_launcher）
 *   ocean/forest/sunset/midnight/lemon/mint/rose/graphite/cream
 *   → MainActivityIcon2..10（ic_launcher_2..10）
 * 切換邏輯：先啟用目標，再停用其他所有 launcher entry（保證永遠至少一個 enabled）。
 */
@TauriPlugin
class IconPlugin(private val activity: Activity) : Plugin(activity) {

    private val aliases = listOf(
        "original" to "com.teno.app.MainActivityIcon1",
        "ocean" to "com.teno.app.MainActivityIcon2",
        "forest" to "com.teno.app.MainActivityIcon3",
        "sunset" to "com.teno.app.MainActivityIcon4",
        "midnight" to "com.teno.app.MainActivityIcon5",
        "lemon" to "com.teno.app.MainActivityIcon6",
        "mint" to "com.teno.app.MainActivityIcon7",
        "rose" to "com.teno.app.MainActivityIcon8",
        "graphite" to "com.teno.app.MainActivityIcon9",
        "cream" to "com.teno.app.MainActivityIcon10",
        // Color Hunt 前 10 名（2026 人氣排行）
        "ch1" to "com.teno.app.MainActivityIcon11",
        "ch2" to "com.teno.app.MainActivityIcon12",
        "ch3" to "com.teno.app.MainActivityIcon13",
        "ch4" to "com.teno.app.MainActivityIcon14",
        "ch5" to "com.teno.app.MainActivityIcon15",
        "ch6" to "com.teno.app.MainActivityIcon16",
        "ch7" to "com.teno.app.MainActivityIcon17",
        "ch8" to "com.teno.app.MainActivityIcon18",
        "ch9" to "com.teno.app.MainActivityIcon19",
        "ch10" to "com.teno.app.MainActivityIcon20",
    )

    private fun component(name: String) = ComponentName(activity.packageName, name)

    /**
     * F5：manifest 唯一 enabled="true" 的 alias（其餘 Icon2..20 皆 enabled="false"）。
     * DEFAULT 態語意對二者相反：Icon1 DEFAULT=active、其餘 DEFAULT=inactive。
     * 未來 manifest 若新增預設 enabled 的 alias，須同步此常量；漏改屬安全方向錯誤
     * （isComponentActive 少認 active，而清理只動 runtime ENABLED，不會誤 disable）。
     */
    private val DEFAULT_ALIAS = "com.teno.app.MainActivityIcon1"

    /** F5：active 判定單一事實源（st 由呼叫端讀好，避免重複 IPC） */
    private fun isComponentActive(name: String, st: Int): Boolean =
        st == PackageManager.COMPONENT_ENABLED_STATE_ENABLED ||
            (st == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && name == DEFAULT_ALIAS)

    /**
     * F4：統一 restart PendingIntent 構造器——cancel 探測（FLAG_NO_CREATE）與排程
     * 必須產出逐欄位一致的 Intent，PI 匹配才對得上（匹配比對 action/category/component）。
     * FLAG_NO_CREATE 時系統回 null（無既有 PI）。
     */
    private fun restartPending(name: String, flags: Int): PendingIntent? =
        PendingIntent.getActivity(
            activity, 0,
            Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(component(name))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            flags,
        )

    /**
     * 初始化：確保 MainActivity 本體永遠 enabled。
     * 舊版 bug 可能已把它 disable（切換時誤停用），alias 指向 disabled activity 會無法啟動。
     * 同時 dump 目前所有 alias 的真實 enabled 狀態到 logcat（載入時監測）。
     */
    override fun load(webView: android.webkit.WebView) {
        try {
            activity.packageManager.setComponentEnabledSetting(
                component("com.teno.app.MainActivity"),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP,
            )
        } catch (e: Exception) {
            Log.e(TAG, "init fix MainActivity state failed", e)
        }
        // 載入時監測：dump 每個 alias 的系統真實 enabled 狀態
        // F5：DEFAULT 語意按 manifest 條件化（Icon1 manifest=true、其餘=false，一刀切屬誤報）
        val pm = activity.packageManager
        val enabledList = mutableListOf<String>()
        for ((key, name) in aliases) {
            val state = pm.getComponentEnabledSetting(component(name))
            val label = when (state) {
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> "ENABLED"
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED -> "disabled"
                PackageManager.COMPONENT_ENABLED_STATE_DEFAULT ->
                    if (name == DEFAULT_ALIAS) "default(=active)" else "default(=inactive)"
                else -> "unknown($state)"
            }
            Log.i(TAG, "state $key ($name) = $label")
            if (isComponentActive(name, state)) enabledList.add(key)
        }
        // 系統真實答案（resolve LAUNCHER intent）
        val launchIntent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setPackage(activity.packageName)
        val resolvedName = pm.resolveActivity(launchIntent, 0)?.activityInfo?.name
        val currentKey = aliases.firstOrNull { (_, name) -> name == resolvedName }?.first
        Log.i(TAG, "CURRENT_ICON=${currentKey ?: "?"} (resolved=$resolvedName, active=${enabledList.joinToString(",")})")
        // 自癒：全部 alias 都 disabled（異常狀態，例如 launcher 點到 disabled component 後的連鎖反應）
        // → 啟用預設 Icon1（original），確保 launcher 一定有入口，app 不會「開不起來」。
        if (enabledList.isEmpty()) {
            Log.w(TAG, "all aliases disabled — re-enabling default Icon1")
            pm.setComponentEnabledSetting(
                component(DEFAULT_ALIAS),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP,
            )
        }
        // 清理殘留（F5 重構）：切 icon 中途 process 被殺 → target+runningComp 雙 ENABLED →
        // resolve 落 ResolverActivity。舊實作以「resolve 是 alias」為清理前置閘＝需求最熾熱時
        // 恰失去信任 → 死鎖環（殘留永不自癒、launcher 永久雙圖示）。改狀態掃描：
        // keep 優先序 = 實際在跑的 alias（user 所見即所留）→ resolve 唯一答案 → 首個 runtime ENABLED；
        // 只動 runtime ENABLED，DEFAULT 絕不 disable（Icon1 的 DEFAULT=active 是系統最後入口）。
        val runningComp = activity.intent?.component?.className
        val runningIsAliasActive = runningComp != null &&
            aliases.any { (_, n) -> n == runningComp } &&
            isComponentActive(runningComp, pm.getComponentEnabledSetting(component(runningComp)))
        val resolvedIsAlias = aliases.any { (_, n) -> n == resolvedName }
        // resolvedIsAlias 僅表「resolve 落在 alias 集」；仍須查 active——防瞬態 resolve
        // 把剛自癒的 Icon1 當殘留回殺（keep 段現讀＝live 模型，與自癒段的系統態變更一致）
        val resolvedActive = resolvedIsAlias && resolvedName != null &&
            isComponentActive(resolvedName, pm.getComponentEnabledSetting(component(resolvedName)))
        val keep: String? = when {
            runningIsAliasActive -> runningComp
            resolvedActive -> resolvedName
            else -> aliases.firstOrNull { (_, n) ->
                pm.getComponentEnabledSetting(component(n)) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            }?.second
        }
        var cleaned = 0
        for ((_, name) in aliases) {
            if (name != keep) {
                val st = pm.getComponentEnabledSetting(component(name))
                if (st == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {
                    Log.i(TAG, "cleanup disable leftover: $name (keep=$keep)")
                    pm.setComponentEnabledSetting(
                        component(name),
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP,
                    )
                    cleaned++
                }
            }
        }
        Log.i(TAG, "cleanup done: keep=${keep ?: "none"} disabled=$cleaned")
        super.load(webView)
    }

    @Command
    fun getCurrentIcon(invoke: Invoke) {
        try {
            val pm = activity.packageManager
            // 系統真實答案：resolve LAUNCHER intent 會啟動哪個 alias
            // 比遍歷 ENABLED 更準 — DEFAULT（manifest 預設 enabled=true）也算 active
            val launchIntent = Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setPackage(activity.packageName)
            val resolved = pm.resolveActivity(launchIntent, 0)
            val resolvedName = resolved?.activityInfo?.name
            var key = aliases.firstOrNull { (_, name) -> name == resolvedName }?.first
            if (key == null) {
                // resolved 非 alias（null=全 disable／系統 ResolverActivity=多 enabled 歧義）。
                // F5 優先序：實際在跑的 alias（使用者所見）→ 首個 runtime ENABLED（resolver
                // 歧義時 aliases 序瞎猜屬實錯）→ DEFAULT 態檢查（Icon1 DEFAULT=active，舊碼漏認
                // 靠 "original" 兜底字串僥傯正確）。
                val runningComp = activity.intent?.component?.className
                key = aliases.firstOrNull { (_, name) ->
                    name == runningComp &&
                        isComponentActive(name, pm.getComponentEnabledSetting(component(name)))
                }?.first
                    ?: aliases.firstOrNull { (_, name) ->
                        pm.getComponentEnabledSetting(component(name)) ==
                            PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    }?.first
                    ?: aliases.firstOrNull { (_, name) ->
                        isComponentActive(name, pm.getComponentEnabledSetting(component(name)))
                    }?.first
            }
            Log.i(TAG, "getCurrentIcon resolved=$resolvedName -> ${key ?: "original"}")
            invoke.resolve(JSObject().put("icon", key ?: "original"))
        } catch (e: Exception) {
            Log.e(TAG, "getCurrentIcon failed", e)
            invoke.reject("getCurrentIcon failed: ${e.message}")
        }
    }

    /**
     * 重置 app-log.db（操作日誌 DB，與 teno.db 學習資料分離）。
     * SQLite 檔案損壞（malformed / code 11）時，JS 端偵測後呼叫，
     * 刪除 DB 相關檔案，下次載入自動重建。teno.db 絕不動。
     */
    @Command
    fun resetAppLog(invoke: Invoke) {
        try {
            val deleted = mutableListOf<String>()
            // Android 標準 SQLite 目錄 databases/
            for (n in activity.databaseList()) {
                if (n.startsWith("app-log")) {
                    val f = activity.getDatabasePath(n)
                    if (f.exists()) {
                        if (f.delete()) deleted.add(n)
                        else Log.e(TAG, "resetAppLog delete failed: $n")
                    }
                }
            }
            Log.i(TAG, "resetAppLog deleted: ${deleted.joinToString()}")
            invoke.resolve(JSObject().put("ok", true).put("deleted", deleted.joinToString(",")))
        } catch (e: Exception) {
            Log.e(TAG, "resetAppLog failed", e)
            invoke.reject("resetAppLog failed: ${e.message}")
        }
    }

    @Command
    fun setIcon(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SetIconArgs::class.java)
            val target = aliases.firstOrNull { it.first == args.name }
                ?: aliases.first()
            val pm = activity.packageManager
            // 當前正在運行的 activity 的 component（例如 MainActivityIcon4）
            // 停用它會被系統 finish（disabled-package）→ app 直接退出。
            // 所以停用其他 alias 時必須跳過它，避免切 icon 時自殺。
            val launchIntent = Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setPackage(activity.packageName)
            val resolvedName = pm.resolveActivity(launchIntent, 0)?.activityInfo?.name
            val runningComp = activity.intent?.component?.className
            Log.i(TAG, "setIcon target=${target.first} resolved=$resolvedName running=$runningComp")
            // 1. 先啟用目標（避免中間狀態完全沒有 launcher entry）
            pm.setComponentEnabledSetting(
                component(target.second),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP,
            )
            // 2. 立即同步停用其他所有 alias（不能延遲！）
            //    延遲停用會在 app 被系統清理時遺漏 → 重開後 getCurrentIcon 讀到舊 enabled 的 alias → 狀態「忘記」
            //    只跳過「實際正在跑的 component」（停用會被系統 finish）；resolveActivity 結果不需跳過
            //    （從 MainActivity 跑時所有 alias 皆可安全停用，避免殘留多個 enabled 造成 ResolverActivity）
            for ((_, name) in aliases) {
                if (name != target.second && name != runningComp) {
                    pm.setComponentEnabledSetting(
                        component(name),
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP,
                    )
                }
            }
            Log.i(TAG, "icon switched to ${target.first} (${target.second})")
            // 3. 若目標 != 當前 alias：需要重啟才能切換 activity 實例的 component（activity-alias 機制限制）。
            //    不能同步 startActivity + finish（CLEAR_TASK destroy/create 併發 → process 被誤判退出 + WebView race）。
            //    改用：AlarmManager 延遲 1.2s 啟動 target ＋ 停用舊 alias（系統 disabled-package
            //    會 finish 它）→ process 死掉後仍會自動開回，launcher resolve 立即指向 target。
            //    從 MainActivity 跑（running 非 alias）時所有 alias 皆已停用，無殘留，不需重啟。
            val runningIsAlias = runningComp != null && aliases.any { (_, n) -> n == runningComp }
            if (target.second != runningComp && runningIsAlias) {
                var restartScheduled = false
                try {
                    val am = activity.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                    // F4：掃蕩舊 restart alarm——PI 意圖帶各別 component，不同目標是不同 PI，
                    // FLAG_UPDATE_CURRENT 蓋不掉舊目標的已排定 alarm（快速連環切 → 連環重啟）。
                    // 舊 alarm 目標無記憶 → 全表 FLAG_NO_CREATE 探測取消（構造經統一 helper 確保匹配）。
                    for ((_, name) in aliases) {
                        // FLAG_IMMUTABLE 一併帶：與排程 PI 同 mutability，零成本防禦對齊
                        val old = restartPending(name, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
                        if (old != null) {
                            am.cancel(old)
                            old.cancel()
                        }
                    }
                    val pending = restartPending(
                        target.second,
                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                    )
                    // setExact 需要 SCHEDULE_EXACT_ALARM 權限（Android 12+，未宣告會 SecurityException）；
                    // setAndAllowWhileIdle 是 non-exact、不需權限，Doze 下也會觸發，對 1.2s 延遲足夠。
                    // F4：單調時鐘——RTC 牆鐘在使用者改系統時間/時區同步時偏移，
                    // restart alarm 可能永不或立即觸發；elapsedRealtime 不受牆鐘影響。
                    // pending 非 null：FLAG_NO_CREATE 才回 null，此處為排程構造。
                    am.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        SystemClock.elapsedRealtime() + 1200,
                        pending!!,
                    )
                    restartScheduled = true
                    Log.i(TAG, "scheduled restart to ${target.second} in 1200ms (elapsed-based)")
                } catch (e: Exception) {
                    Log.e(TAG, "scheduled restart after icon switch failed — rolling back", e)
                    // F4：回滾——此時 target 已 enabled、其他 alias 已全 disabled、runningComp 仍
                    // enabled = 雙 enabled → launcher resolve 歧義（ResolverActivity）。把 target
                    // 關回，回到切換前唯一 enabled 乾淨態（使用者看到舊圖示＝如實反映切換失敗）。
                    try {
                        pm.setComponentEnabledSetting(
                            component(target.second),
                            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                            PackageManager.DONT_KILL_APP,
                        )
                    } catch (e2: Exception) {
                        Log.e(TAG, "rollback target enable failed", e2)
                    }
                }
                if (restartScheduled) {
                    invoke.resolve(JSObject().put("icon", target.first).put("ok", true).put("restart", true))
                    try {
                        // 停用舊 alias：系統會 finish 它（disabled-package），反正要重啟；
                        // 這樣重啟後 enabled 只剩 target，resolve 唯一、launcher 立即正確。
                        pm.setComponentEnabledSetting(
                            component(runningComp!!),
                            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                            PackageManager.DONT_KILL_APP,
                        )
                        activity.finish()
                    } catch (e: Exception) {
                        Log.e(TAG, "disable running alias after restart scheduled failed", e)
                    }
                } else {
                    // 排程失敗且已回滾（icon 實際未切換）→ reject：JS 端 catch 如實 toast 錯誤，
                    // 不得 resolve ok:true（settings.js 消費者 resolve 即 toast「重新啟動中…」會說謊）。
                    invoke.reject("restart scheduling failed — icon switch rolled back")
                }
            } else {
                // 不需重啟（running 非 alias／目標即在跑）：切換已完成，如實 resolve。
                invoke.resolve(JSObject().put("icon", target.first).put("ok", true).put("restart", false))
            }
        } catch (e: Exception) {
            Log.e(TAG, "setIcon failed", e)
            invoke.reject("setIcon failed: ${e.message}")
        }
    }
}
