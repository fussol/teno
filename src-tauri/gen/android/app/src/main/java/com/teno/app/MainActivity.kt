package com.teno.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ProcessLifecycleOwner

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

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
  }
}
