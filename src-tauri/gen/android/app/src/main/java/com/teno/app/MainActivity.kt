package com.teno.app

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ProcessLifecycleOwner

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  // WIDGETROUTE：桌面 widget 點擊路由 — intent extras → 待送 pendingRoute →
  // evaluateJavascript 推 window.__widgetRoute(route, arg)（JS 回 1 才清除；
  // JS 未就緒 → 300ms 重試，冷啟 splash 期由重試兜住，100 次(30s) 放棄）。
  private var pendingRoute: String? = null
  private var pendingArg: String? = null
  private var flushTries = 0
  private val flushHandler = Handler(Looper.getMainLooper())
  private val flushTick = object : Runnable {
    override fun run() {
      val r = pendingRoute ?: return
      val wv = webViewRef
      if (wv == null) { flushHandler.postDelayed(this, 300); return }
      if (flushTries >= 100) { pendingRoute = null; pendingArg = null; flushTries = 0; return }
      flushTries++
      val js = "window.__widgetRoute?window.__widgetRoute(" +
        JSONObject.quote(r) + "," + JSONObject.quote(pendingArg ?: "") + "):0"
      wv.evaluateJavascript(js) { res ->
        if (res?.trim() == "1") {
          pendingRoute = null; pendingArg = null; flushTries = 0
        } else {
          flushHandler.postDelayed(this, 300)
        }
      }
    }
  }

  private fun readRoute() {
    val i = intent ?: return
    val r = i.getStringExtra("teno_route") ?: return
    i.removeExtra("teno_route")   // 重建（singleTask 再進）不重放同一路由
    pendingArg = i.getStringExtra("teno_arg")
    i.removeExtra("teno_arg")
    pendingRoute = r
    flushTries = 0
    flushHandler.removeCallbacks(flushTick)
    flushHandler.post(flushTick)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    readRoute()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    readRoute()   // 冷啟：pending 先立好，webViewRef 起來後由 flushTick 送達

    // F3：接通 plugin lifecycle 橋（v3 盲點修正）。
    // TauriLifecycleObserver（generated/TauriActivity.kt:17，同 package）onPause/onStop/onResume
    // → PluginManager 遍歷 plugins → TtsPlugin.onPause/onStop/onResume。
    // 官方模板只定義不註冊；在此註冊為唯一最小正確點（WryActivity 為 generated 不可改）。
    // 註冊時機：super.onCreate 鏈（PluginManager.onActivityCreate）已跑完，無 race；
    // ProcessLifecycleOwner 當下狀態 CREATED，addObserver 只快進 onCreate 回呼（無 override → 無操作）。
    ProcessLifecycleOwner.get().lifecycle.addObserver(TauriLifecycleObserver)

    // Android back：優先交給 SPA 導覽。JS 有 __handleAndroidBack（view stack 有上一頁）
    // 就返回；JS 沒定義或沒上一頁才退出 app。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (isFinishing) return   // F1：exit 流程中（finishAndRemoveTask 已觸發）不再重入 back
        val wv = webViewRef
        if (wv != null) {
          wv.evaluateJavascript("typeof window.__handleAndroidBack") { res ->
            val t = res?.trim()?.trim('"')
            if (t == "function") {
              wv.evaluateJavascript("window.__handleAndroidBack()", null)
            } else {
              fallbackExit()
            }
          }
        } else {
          fallbackExit()
        }
      }

      private fun fallbackExit() {
        isEnabled = false
        this@MainActivity.onBackPressed()
        isEnabled = true
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
    flushHandler.post(flushTick)   // 暖路徑：onNewIntent 先於 webview 建立時也在這裡補送
  }
}
