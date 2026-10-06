package com.teno.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipFile

// BOOTDIAG：黑畫面時唯一的原生觀測窗。
// webview 死了 → JS 面什麼都出不來，所以診斷必須活在原生層：蓋在 webview 上、
// 長按可選字、標題列點一下複製全部。只在 .test 出現（主力包不帶）。
object BootDiag {
  private const val TAG = "BOOT-DIAG"
  private const val ROUNDS = 30
  private const val TICK_MS = 1000L

  private val handler = Handler(Looper.getMainLooper())
  private val lines = mutableListOf<String>()
  private val stamp = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
  private var root: LinearLayout? = null
  private var body: TextView? = null
  private var wv: WebView? = null
  private var round = 0
  private var ticking = false
  private var responded = false
  private var lastHref = ""
  private var file: File? = null

  fun enabled(ctx: Context): Boolean = ctx.packageName.endsWith(".test")

  // 必須在 super.onCreate 之前掛：WryActivity.onCreate 裡那顆 WryLifecycleObserver
  // 是靠同一個 ProcessLifecycleOwner 派發的，onCreate/onFirstActivityCreate（＝tauri 主程式
  // 與 MAIN_PIPE looper）全繫於它。這顆觀測器與它同一起跑點，它沒收到＝它也沒收到。
  fun preCreate(ctx: Context) {
    if (!enabled(ctx)) return
    if (file == null) file = File(ctx.filesDir, "boot-diag.log")
    runCatching { file?.writeText("") }
    add("preCreate：ProcessLifecycle currentState=${plcState()}")
    runCatching {
      ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
        override fun onCreate(owner: LifecycleOwner) {
          add("★ PLC onCreate → WryLifecycleObserver 應同批收到 → onFirstActivityCreate(\$main=tauri 主程式) 會跑")
        }
        override fun onStart(owner: LifecycleOwner) { add("PLC onStart  state=${owner.lifecycle.currentState}") }
        override fun onResume(owner: LifecycleOwner) { add("PLC onResume state=${owner.lifecycle.currentState}") }
        override fun onPause(owner: LifecycleOwner) { add("PLC onPause") }
        override fun onStop(owner: LifecycleOwner) { add("PLC onStop") }
      })
      add("PLC 觀測器已掛，currentState=${plcState()}")
    }.onFailure { add("PLC 掛觀測器失敗: ${it.javaClass.simpleName}: ${it.message}") }
  }

  private fun plcState(): String = runCatching {
    ProcessLifecycleOwner.get().lifecycle.currentState.name
  }.getOrNull() ?: "(取不到)"

  fun start(ctx: Context) {
    if (!enabled(ctx) || root != null) return
    if (file == null) file = File(ctx.filesDir, "boot-diag.log").apply { delete() }
    add("$TAG 啟動  pkg=${ctx.packageName}  v=${versionOf(ctx)}")
    add(nativeInfo(ctx))
    installCrashHook()
    mount(ctx)
    handler.postDelayed({ at("+600ms") { earlyProbes(ctx) } }, 600)
    handler.postDelayed({ at("+3s") { lateProbes(ctx) } }, 3000)
    handler.postDelayed({ at("+8s") { lastProbes(ctx) } }, 8000)
    startTicker()
  }

  // setWebView 由 wry main_pipe 執行緒觸發，可能早於 start()（super.onCreate 內）
  fun attach(webView: WebView) {
    if (wv === webView) return
    val early = root == null
    wv = webView
    val st = runCatching {
      "url=${webView.url} progress=${webView.progress}% js=${webView.settings.javaScriptEnabled}" +
        " children=${webView.childCount} h=${webView.height} shown=${webView.isShown}"
    }.getOrDefault("(讀 webview 狀態時掛了)")
    add("onWebViewCreate 觸發${if (early) "（早於浮層，已補記）" else ""}  ${webView.javaClass.simpleName}  $st")
    startTicker()
  }

  // lifecycle 標記（MainActivity.onStart/onResume 呼叫）
  fun mark(what: String) {
    if (root == null) return
    add("lifecycle: $what")
  }

  private fun startTicker() {
    if (ticking || wv == null) return
    ticking = true
    handler.post(ticker)
  }

  private fun at(when_: String, probe: () -> Unit) {
    if (root == null) return
    add("── $when_ ──")
    runCatching(probe).onFailure { add("probe 掛了: ${it.javaClass.simpleName}: ${it.message}") }
  }

  private fun versionOf(ctx: Context): String = runCatching {
    ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
  }.getOrNull() ?: "?"

  // ── 原生側靜態資訊 ───────────────────────────────────────────────
  private fun nativeInfo(ctx: Context): String {
    val sb = StringBuilder()
    sb.append("sdk=").append(Build.VERSION.SDK_INT)
      .append("(").append(Build.VERSION.RELEASE).append(")")
      .append("  dev=").append(Build.MANUFACTURER).append("/").append(Build.MODEL)
      .append("  abi=").append(Build.SUPPORTED_ABIS.joinToString(","))
      .append("\nwv=").append(webViewVersion())
      .append("\nsrc=").append(ctx.applicationInfo.sourceDir)
      .append("\nfiles=").append(ctx.filesDir.absolutePath)
    return sb.toString()
  }

  private fun webViewVersion(): String = runCatching {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" }
    } else null
  }.getOrNull() ?: "(取不到 WebView 版本)"

  private fun earlyProbes(ctx: Context) {
    runCatching {
      add("apk assets 根目錄=" + (ctx.assets.list("")?.joinToString(",") ?: "(空)"))
      ctx.assets.open("tauri.conf.json").use {
        val j = JSONObject(it.readBytes().toString(Charsets.UTF_8))
        add("tauri.conf.json ok  id=${j.optString("identifier")} v=${j.optString("version")}")
      }
    }.onFailure { add("apk assets 讀取失敗: ${it.javaClass.simpleName}: ${it.message}") }

    runCatching {
      val z = ZipFile(ctx.applicationInfo.sourceDir)
      z.use { f ->
        val libs = f.entries().asSequence()
          .filter { !it.isDirectory && it.name.startsWith("lib/") }
          .joinToString(" ") { "${it.name.removePrefix("lib/")}=${it.size / 1024}KB" }
        add("安裝 APK 內的 native lib: ${libs.ifEmpty { "(無!)" }}")
        val sof = f.entries().asSequence()
          .filter { it.name.endsWith("libteno_lib.so") }
          .toList()
        sof.forEach {
          add("  ${it.name} 壓縮=${it.compressedSize / 1024}KB 未壓=${it.size / 1024}KB")
        }
      }
    }.onFailure { add("讀安裝 APK 失敗: ${it.javaClass.simpleName}: ${it.message}") }

    add("viewTree=${viewTree(ctx)}")
    add("webViewRef=${if (wv != null) "已建立" else "尚未建立"}")
    add("PLC state=${plcState()}")
  }

  private fun lateProbes(ctx: Context) {
    add("viewTree=${viewTree(ctx)}")
    add("webViewRef=${if (wv != null) "已建立" else "⚠ 尚未建立"}")
    add("PLC state=${plcState()}")

    runCatching { allThreads().forEach { add("  th $it") } }
      .onFailure { add("threads 掛: ${it.message}") }

    dumpLogcat()

    // .so 到底有沒有被 mmap 進來
    runCatching {
      val all = File("/proc/self/maps").readText().lineSequence().toList()
      val hit = all.filter { it.contains("teno_lib") }
      add("/proc/self/maps 共 ${all.size} 行，含 teno_lib ${hit.size} 區、含 .apk ${all.count { it.contains(".apk") }} 區")
      hit.take(3).forEach { add("  " + it.take(200)) }
      if (hit.isEmpty()) all.filter { it.contains(".apk") }.take(2).forEach { add("  apk: " + it.take(200)) }
    }.onFailure { add("讀 maps 失敗: ${it.message}") }

    // 資產走哪條路：非 null = WebViewAssetLoader 從 APK assets 取（根目錄沒有 index.html！）
    //                null   = 走 Rust.handleRequest 自訂協定（資產在 .so 裡）
    runCatching {
      val d = Rust.assetLoaderDomain("bootdiag-probe")
      add("assetLoaderDomain(probe) = ${d ?: "null"}")
      if (d != null) add("  ⚠ 走 APK assets 路 → 根目錄沒有 index.html，頁面會 404 黑畫面")
    }.onFailure { add("assetLoaderDomain 掛了: ${it.javaClass.simpleName}: ${it.message}") }

    if (wv == null) add("⚠ +3s：onWebViewCreate 仍沒觸發 → wry main_pipe 從未送出/處理 CreateWebView")
    if (!responded) add("⚠ +3s：evaluateJavascript 從未回應")
    dumpLogcat()
  }

  private fun lastProbes(ctx: Context) {
    add("viewTree=${viewTree(ctx)}")
    add("webViewRef=${if (wv != null) "已建立" else "⚠ +8s 仍未建立"}")
    add("PLC state=${plcState()}")
    if (!responded) add("⚠ +8s：evaluateJavascript 從未回應")
    dumpLogcat()
    add("── 診斷尾聲（共 ${lines.size} 行；黃條點一下複製）──")
  }

  // 全部執行緒（名字＋前三層幀）—— tauri/tokio 起沒起來一看便知
  private fun allThreads(): List<String> =
    Thread.getAllStackTraces().entries
      .sortedBy { it.key.name }
      .map { e ->
        val frames = e.value.take(3).joinToString(" <- ") { it.className.substringAfterLast('.') + "." + it.methodName }
        "${e.key.name} #${e.key.id} ${if (e.key.isAlive) "run" else "dead"} :: $frames"
      }

  // decorView 內所有 View 類別（黑畫面時「webview 到底有沒有被建出來」就看這）
  private fun viewTree(ctx: Context): String {
    val decor = (ctx as? MainActivity)?.window?.decorView ?: return "(無 decorView)"
    val seen = LinkedHashSet<String>()
    fun walk(v: View, d: Int) {
      if (d > 6) return
      seen.add("| ".repeat(d) + v.javaClass.simpleName)
      if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i), d + 1)
    }
    walk(decor, 0)
    return seen.joinToString(" ")
  }

  // logcat 完整轉儲 —— wry 的 eprintln!("no activity found ...") 與 Rust panic 只在這裡。
  // 前一版 takeLast(80) 把 onCreate 時間點的頭幾行丟掉，正好是最關鍵的，這版頭尾都留。
  private fun dumpLogcat() {
    val pid = android.os.Process.myPid()
    for (buf in listOf("main", "crash")) {
      runCatching {
        val p = Runtime.getRuntime()
          .exec(arrayOf("logcat", "-d", "-v", "brief", "-b", buf, "-t", "2000"))
        val all = p.inputStream.bufferedReader().readText()
          .lineSequence().filter { it.isNotBlank() }.toList()
        if (all.isEmpty()) {
          add("logcat[$buf] 空")
        } else if (buf == "crash") {
          add("logcat[crash] ${all.size} 行（全印，上限 60）")
          all.take(60).forEach { add("  " + it.take(240)) }
        } else {
          val mine = all.filter { it.contains("($pid)") }
          add("logcat[$buf] 全 ${all.size} 行 / 本 pid ${mine.size} 行 → 頭 60 + 尾 60")
          if (mine.isEmpty()) {
            add("  本 pid 無行，印 buffer 頭 30：")
            all.take(30).forEach { add("  " + it.take(240)) }
          } else {
            mine.take(60).forEach { add("  H " + it.take(240)) }
            mine.takeLast(60).forEach { add("  T " + it.take(240)) }
          }
        }
      }.onFailure { add("logcat[$buf] 讀取失敗: ${it.javaClass.simpleName}: ${it.message}") }
    }
  }

  // ── JS 面輪詢 ───────────────────────────────────────────────────
  private val ticker = object : Runnable {
    override fun run() = tick()
  }

  private fun tick() {
    val view = wv
    if (view == null) { ticking = false; return }
    if (round >= ROUNDS) { add("探測結束（$ROUNDS 輪）"); ticking = false; return }
    round++
    view.evaluateJavascript(JS) { raw ->
      if (raw == null) {
        add("#$round null — evaluateJavascript 無回應")
      } else {
        responded = true
        val s = raw.removeSurrounding("\"")
          .replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", " ")
        try {
          val j = JSONObject(s)
          if (j.has("probeEx")) {
            add("#$round 探測例外: ${j.optString("probeEx")}")
            return@evaluateJavascript
          }
          add(
            "#$round ready=${j.optString("ready")} html=${j.optInt("htmlLen")}" +
              " app=${j.optString("appKids")} scripts=${j.optInt("scripts")}" +
              " css=${j.optString("css")} tauri=${j.optString("tauriInt")}" +
              " res=${j.optInt("res")} err=${j.optString("err").ifEmpty { "-" }}"
          )
          val href = j.optString("href")
          if (href != lastHref) { lastHref = href; add("    href=$href") }
        } catch (e: Exception) {
          add("#$round raw=$s")
        }
      }
      if (round < ROUNDS && wv != null) handler.postDelayed(ticker, TICK_MS) else ticking = false
    }
  }

  // ── 原生未捕捉例外 ───────────────────────────────────────────────
  private fun installCrashHook() {
    val prev = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { t, e ->
      runCatching {
        add("FATAL ${e.javaClass.name}: ${e.message}")
        e.stackTrace.take(6).forEach { add("    at $it") }
        add("    thread=${t.name}")
      }
      prev?.uncaughtException(t, e)
    }
  }

  // ── 浮層 ─────────────────────────────────────────────────────────
  private fun mount(ctx: Context) {
    val decor = (ctx as? MainActivity)?.window?.decorView as? FrameLayout ?: run {
      add("⚠ 取不到 DecorView，浮層放不上去"); return
    }
    val pad = (12 * ctx.resources.displayMetrics.density).toInt()
    val h = ctx.resources.displayMetrics.heightPixels * 2 / 5

    body = TextView(ctx).apply {
      typeface = Typeface.MONOSPACE
      textSize = 10.5f
      setTextColor(Color.WHITE)
      setBackgroundColor(0xE6000000.toInt())
      setPadding(pad, pad / 2, pad, pad)
      setTextIsSelectable(true)
      isVerticalScrollBarEnabled = true
      gravity = Gravity.TOP
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, h)
    }
    val head = TextView(ctx).apply {
      typeface = Typeface.MONOSPACE
      textSize = 11f
      setTextColor(Color.BLACK)
      setBackgroundColor(Color.YELLOW)
      setPadding(pad, pad / 2, pad, pad)
      text = "$TAG ▸ 點一下複製全部"
      setOnClickListener { copyAll(ctx) }
    }
    root = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      addView(head)
      addView(body)
    }
    decor.addView(
      root,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM
      )
    )
    render()
  }

  private fun copyAll(ctx: Context) {
    val text = lines.joinToString("\n")
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(TAG, text))
    add("已複製 ${lines.size} 行到剪貼簿")
  }

  private fun add(line: String) {
    handler.post {
      val l = "${stamp.format(Date())}  $line"
      lines.add(l)
      runCatching { file?.appendText(l + "\n") }
      render()
    }
  }

  private fun render() { body?.text = lines.joinToString("\n") }

  private val JS = """
    (function(){
      try{
        if(!window.__bdHooked){
          window.__bdHooked=1; window.__bdErr=null;
          addEventListener('error',function(e){
            window.__bdErr=(e.message||'err')+' @'+(e.filename||'').split('/').pop()+':'+(e.lineno||0);
          });
          addEventListener('unhandledrejection',function(e){
            var r=e.reason; window.__bdErr='unhandled: '+(r&&r.message?r.message:String(r));
          });
        }
        var app=document.getElementById('app');
        var s=document.scripts.length?document.scripts[0]:null;
        var l=document.querySelector('link[rel=stylesheet]');
        return JSON.stringify({
          href:location.href,
          ready:document.readyState,
          htmlLen:(document.documentElement.outerHTML||'').length,
          scripts:document.scripts.length,
          s0:s?((s.src||'inline').split('/').pop()):'none',
          css:l?((l.href||'').split('/').pop()):'none',
          appKids:app?(app.childElementCount):'NO#app',
          tauriInt:(typeof window.__TAURI_INTERNALS__),
          err:window.__bdErr||'',
          res:(performance.getEntriesByType('resource')||[]).length
        });
      }catch(ex){ return JSON.stringify({probeEx:String(ex)}); }
    })();
  """.trimIndent()
}
