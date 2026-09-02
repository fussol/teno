package com.teno.app

import android.app.Activity
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "TtsPlugin"

@InvokeArg
class SpeakArgs {
    lateinit var text: String
    var voice: String = ""
    var speed: Double = 1.0
}

// F17：不可變語音索引快照（index + 建立時間單欄原子發佈；main thread 讀取零鎖零撕裂）
private class VoiceIndexSnapshot(val index: Map<String, Voice>, val at: Long)

@InvokeArg
class SaveExportFileArgs {
    lateinit var filename: String
    lateinit var data: String  // base64
    var mime: String = "application/octet-stream"
}

@InvokeArg
class CopyUriToCacheArgs {
    lateinit var uri: String
}

@TauriPlugin
class TtsPlugin(private val activity: Activity) : Plugin(activity) {
    private var tts: TextToSpeech? = null
    private var webView: WebView? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var isSpeaking = false
    @Volatile private var destroyed = false
    // F3：app 背景化 pause 時標記、回前台 onResume 條件化恢復 audio focus（不無條件 request，避免佔用壓制其他 app 音訊）
    private var focusNeedsRestore = false

    // F2 事件契約：utteranceId 提升為 plugin 欄位；stopRequested 防 stop/pause 後引擎回調雙重 emit；
    // utteranceTexts 為 id→text 對應表（各 emit 終態點 remove，防無界成長）
    @Volatile private var currentUtteranceId: String? = null
    @Volatile private var stopRequested = false
    private val utteranceTexts = ConcurrentHashMap<String, String>()

    // F17 stale-while-revalidate 語音索引：main thread 只讀不可變快照，絕不觸碰引擎 voice 集合
    // （引擎忙碌時 getVoices 等內部 lock → 呼叫緒讀 = ANR，見 listVoices 註解）。
    // 過期/空快照 → 非阻塞觸發背景刷新（單飛去重），本次照常回傳舊快照（舊 Voice 對已連線引擎仍有效）。
    @Volatile private var voiceIndex = VoiceIndexSnapshot(emptyMap(), 0L)
    private val voiceRefreshInFlight = AtomicBoolean(false)
    private val VOICE_INDEX_TTL = 60_000L

    private val pollingHandler = Handler(Looper.getMainLooper())
    private var pollingRunnable: Runnable? = null
    private var lastSpeakTime = 0L

    override fun load(webView: WebView) {
        Log.d(TAG, "load() called")
        this.webView = webView
        audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= 26) {
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener { }
                .build()
        }
        tts = TextToSpeech(activity.applicationContext) { status ->
            Log.d(TAG, "TTS init callback: status=$status")
            if (status == TextToSpeech.SUCCESS) {
                Log.d(TAG, "TTS initialized successfully, engine=${tts?.defaultEngine}")
                // F17 暖機：init callback 於背景 binder 執行緒，於此啟動索引刷新（findVoice 永不碰引擎）
                startVoiceIndexRefresh()
            } else {
                Log.e(TAG, "TTS init failed: $status")
            }
        }
        // listener 建立一次（F2：比對欄位 currentUtteranceId，不再每次 speak replace）
        setupListener()
    }

    @Command
    fun speak(invoke: Invoke) {
        Log.d(TAG, "speak() called")
        val tts = this.tts
        if (tts == null) {
            Log.e(TAG, "speak() - TTS not initialized")
            invoke.reject("TTS not initialized"); return
        }
        val args = invoke.parseArgs(SpeakArgs::class.java)
        Log.d(TAG, "speak() args: text='${args.text}' voice='${args.voice}' speed=${args.speed}")

        val text = args.text
        if (text.isBlank()) {
            Log.e(TAG, "speak() - empty text")
            invoke.reject("Empty text"); return
        }
        val speed = args.speed.toFloat().coerceIn(0.1f, 5.0f)

        requestAudioFocus()
        tts.setSpeechRate(speed)
        tts.setPitch(1.0f)

        if (args.voice.isNotBlank()) {
            val v = findVoice(args.voice)
            if (v != null) {
                tts.voice = v
                Log.d(TAG, "speak() set voice to ${v.name}")
            } else {
                Log.w(TAG, "speak() voice '${args.voice}' not found")
            }
        }

        // F2：utteranceId 提升為欄位（事件契約：所有 emit 帶 id+reason）
        val id = UUID.randomUUID().toString()
        currentUtteranceId = id
        stopRequested = false
        utteranceTexts[id] = text

        val bundle = if (Build.VERSION.SDK_INT >= 21) {
            Bundle().apply { putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id) }
        } else {
            null
        }

        val result = if (Build.VERSION.SDK_INT >= 21) {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, bundle, id)
        } else {
            @Suppress("DEPRECATION")
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, hashMapOf(
                TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID to id
            ))
        }

        Log.d(TAG, "speak() result=$result, SUCCESS=${TextToSpeech.SUCCESS}")

        if (result == TextToSpeech.SUCCESS) {
            isSpeaking = true
            lastSpeakTime = System.currentTimeMillis()
            startPolling(id, text)
            invoke.resolve()
            emitSpeechEvent("tts://speech:start", id, "", text)
        } else {
            abandonAudioFocus()
            emitSpeechEvent("tts://speech:error", id, "error", text, "Speak failed: $result")
            // 失敗分支清潔：不留下「從未開始的 utterance」狀態（避免後續 stop() 空發 stopped）
            currentUtteranceId = null
            utteranceTexts.remove(id)
            // 保留 invoke.reject：這是 JS 唯一的即時 reject 通道（error 事件因 slot id 未回填必被 ignore）
            invoke.reject("TTS speak failed: $result")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        Log.d(TAG, "stop() called")
        // F2：stop 語意 = stopped(user)，不再 emit done
        stopRequested = true
        tts?.stop()
        isSpeaking = false
        abandonAudioFocus()
        stopPolling()
        val id = currentUtteranceId
        if (id != null) {
            emitSpeechEvent("tts://speech:stopped", id, "user", utteranceTexts.remove(id))
            currentUtteranceId = null
        }
        invoke.resolve()
    }

    // F1：Android back/退出 — JS 層 getCurrentWindow().close() 在 Android WebView 無 Activity finish 語意，
    // 原生路徑在此（v3 定案：PluginHandle 反射單參數 → 必須收 Invoke；JS invoke('finish_app') 取代 close()）。
    // 防重：isFinishing 時直接 resolve 收斂（finishAndRemoveTask 已觸發或系統 finish 流程中 → 冪等 no-op），
    // 與 MainActivity back callback 的 isFinishing guard 構成雙層防重。
    @Command
    fun finishApp(invoke: Invoke) {
        Log.d(TAG, "finishApp() called")
        if (activity.isFinishing) { invoke.resolve(); return }
        activity.finishAndRemoveTask()
        invoke.resolve()
    }

    @Command
    fun listVoices(invoke: Invoke) {
        Log.d(TAG, "listVoices() called")
        val tts = this.tts
        if (tts == null) {
            Log.e(TAG, "listVoices() - TTS not initialized")
            invoke.reject("TTS not initialized"); return
        }
        // 不能在 main thread 直接讀 tts.voices：
        // TTS 引擎忙碌時 getVoices() 會等內部 lock（binder thread 持有）→ main thread 卡死 → ANR → app 被系統關閉
        Thread {
            try {
                val allVoices = tts.voices ?: emptySet<Voice>()
                Log.d(TAG, "listVoices() total=${allVoices.size}")
                val filtered = allVoices
                    .filter { !it.isNetworkConnectionRequired }
                    .filter { v -> v.locale?.let { it.language == "en" && (it.country == "US" || it.country == "GB") } ?: false }
                    .map { voice ->
                        JSObject().apply {
                            put("name", voice.name)
                            put("language", voice.locale?.toLanguageTag() ?: "")
                        }
                    }
                Log.d(TAG, "listVoices() filtered=${filtered.size}")
                val result = JSObject()
                result.put("voices", JSArray.from(filtered.toTypedArray()))
                Handler(Looper.getMainLooper()).post { invoke.resolve(result) }
            } catch (e: Exception) {
                Log.e(TAG, "listVoices error", e)
                Handler(Looper.getMainLooper()).post { invoke.reject("listVoices failed: ${e.message}") }
            }
        }.start()
    }

    @Command
    fun saveExportFile(invoke: Invoke) {
        val args = invoke.parseArgs(SaveExportFileArgs::class.java)
        val filename = args.filename
        val base64 = args.data
        val mime = args.mime

        try {
            val data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            // O3：版本分支 — MediaStore.Downloads 為 API29+ 巢狀靜態欄位類（minSdk=24 裝置載入即
            // NoClassDefFoundError 崩潰）。SDK_INT>=29 走現行 MediaStore 路徑；<29（Android 7-9）
            // 走 legacy 舊路徑，故 <29 裝置永不執行 MediaStore.Downloads 引用（Art 懶解析→類不載入）。
            if (Build.VERSION.SDK_INT >= 29) {
                val resolver = activity.contentResolver
                val contentValues = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Teno")
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
                    ?: throw Exception("Failed to create MediaStore entry")
                resolver.openOutputStream(uri)?.use { it.write(data) }
                    ?: throw Exception("Failed to open output stream")
                Log.d(TAG, "saveExportFile: $filename saved to Downloads/Teno")
            } else {
                // legacy API24-28：舊路徑（getExternalStoragePublicDirectory + FileOutputStream）
                // 全限定 java.io.File/FileOutputStream（此檔無 import，line 294 copyUriToCache 以全限定寫）
                val dir = java.io.File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Teno")
                if (!dir.exists()) dir.mkdirs()
                val outFile = java.io.File(dir, filename)
                java.io.FileOutputStream(outFile).use { s -> s.write(data) }
                Log.d(TAG, "saveExportFile(legacy): $filename saved to Downloads/Teno")
            }
            invoke.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "saveExportFile error: ${e.message}")
            invoke.reject("儲存失敗: ${e.message}")
        }
    }

    @Command
    fun copyUriToCache(invoke: Invoke) {
        val args = invoke.parseArgs(CopyUriToCacheArgs::class.java)
        try {
            val resolver = activity.contentResolver
            val uri = android.net.Uri.parse(args.uri)
            // F10：以真實 DISPLAY_NAME 落地（piper 鏈需真實 .onnx 檔名建語音目錄；
            // 原本固定 import.db 令 piper 匯入仍 100% 敗。.db 匯入 DISPLAY_NAME 照樣 .db，零影響）。
            var name = "import.db"
            resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) {
                    val n = c.getString(0)
                    if (!n.isNullOrBlank()) name = n
                }
            }
            // sanitize：擋路徑穿越（/ \ 分隔符）、控制字元；空/`.`/`..` 兜底 import.db
            name = name.replace(Regex("[/\\\\]"), "_").filter { it.code in 32..126 }.trim()
            if (name.isBlank() || name == "." || name == "..") name = "import.db"
            val input = resolver.openInputStream(uri)
                ?: throw Exception("Cannot open URI")
            val outFile = java.io.File(activity.cacheDir, name)
            outFile.outputStream().use { out -> input.copyTo(out) }
            Log.d(TAG, "copyUriToCache: ${outFile.absolutePath}")
            val res = JSObject()
            res.put("path", outFile.absolutePath)
            invoke.resolve(res)
        } catch (e: Exception) {
            Log.e(TAG, "copyUriToCache error: ${e.message}")
            invoke.reject("無法讀取檔案: ${e.message}")
        }
    }

    // F17：背景刷新語音索引。tts 引用於函式首行捕獲本體（防 onDestroy 置 null 後二次讀取窗口），
    // 讀取全在背景線程內；成功才整體發佈不可變快照（失敗/null 保留舊快照、不續 timestamp，下次自然重試）。
    // 單飛守衛：CAS 失敗即回（去重）；釋放必在背景線程 finally，起線程本身失敗則外層 catch 就地釋放。
    // （已 shutdown 引擎上 getVoices 回 null/拋錯均由 try/catch 兜底；destroyed 檢查僅省線程。）
    private fun startVoiceIndexRefresh() {
        val ttsRef = tts ?: return
        if (destroyed) return
        if (!voiceRefreshInFlight.compareAndSet(false, true)) return
        try {
            Thread {
                try {
                    val voices = ttsRef.voices
                    if (voices != null) {
                        val idx = HashMap<String, Voice>()
                        for (v in voices) { val n = v.name; if (n != null) idx[n] = v }
                        if (!destroyed) voiceIndex = VoiceIndexSnapshot(idx, System.currentTimeMillis())
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "voice index refresh failed: ${e.message}")
                } finally {
                    voiceRefreshInFlight.set(false)
                }
            }.start()
        } catch (e: Exception) {
            voiceRefreshInFlight.set(false)
            Log.e(TAG, "voice refresh thread start failed: ${e.message}")
        }
    }

    // F17：只讀不可變快照（單次讀取 latch，零鎖零引擎觸碰）。空/過期/miss → 非阻塞觸發背景刷新，
    // 本次回傳快照現有可能是舊值或 null——代價遠小於在呼叫緒讀引擎（ANR 殺 app）。
    // miss 也觸發＝新下載語音一條 utterance 內可見（單飛去重，無閃爍）。snapshot 名稱為驗證錨點。
    private fun findVoice(name: String): Voice? {
        val state = voiceIndex
        val snapshot = state.index
        if (snapshot.isEmpty() || snapshot[name] == null ||
            System.currentTimeMillis() - state.at > VOICE_INDEX_TTL) {
            startVoiceIndexRefresh()
        }
        return snapshot[name]
    }

    private fun setupListener() {
        val listener = object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {
                if (utteranceId != currentUtteranceId) return
                Log.d(TAG, "onStart: $utteranceId")
                isSpeaking = true
            }

            override fun onDone(utteranceId: String) {
                if (utteranceId != currentUtteranceId) return
                Log.d(TAG, "onDone: $utteranceId")
                // stop/pause 後引擎回調 → 只清狀態不 emit（stop/pause 已 emit stopped）
                if (stopRequested) {
                    isSpeaking = false
                    stopPolling()
                    return
                }
                isSpeaking = false
                stopPolling()
                abandonAudioFocus()
                currentUtteranceId = null
                emitSpeechEvent("tts://speech:done", utteranceId, "finish", utteranceTexts.remove(utteranceId))
            }

            @Suppress("DEPRECATION")
            override fun onError(utteranceId: String) {
                if (utteranceId != currentUtteranceId) return
                Log.e(TAG, "onError(deprecated): $utteranceId")
                if (stopRequested) {
                    isSpeaking = false
                    stopPolling()
                    return
                }
                isSpeaking = false
                stopPolling()
                abandonAudioFocus()
                currentUtteranceId = null
                emitSpeechEvent("tts://speech:error", utteranceId, "error", utteranceTexts.remove(utteranceId), "TTS error")
            }

            override fun onError(utteranceId: String, errorCode: Int) {
                if (utteranceId != currentUtteranceId) return
                Log.e(TAG, "onError: $utteranceId code=$errorCode")
                if (stopRequested) {
                    isSpeaking = false
                    stopPolling()
                    return
                }
                isSpeaking = false
                stopPolling()
                abandonAudioFocus()
                currentUtteranceId = null
                emitSpeechEvent("tts://speech:error", utteranceId, "error", utteranceTexts.remove(utteranceId), "TTS error code: $errorCode")
            }
        }
        tts?.setOnUtteranceProgressListener(listener)
    }

    private fun startPolling(utteranceId: String, text: String) {
        stopPolling()
        pollingRunnable = Runnable {
            val tts = this.tts ?: run {
                Log.d(TAG, "polling: tts null, emitting done")
                isSpeaking = false
                abandonAudioFocus()
                if (currentUtteranceId == utteranceId) currentUtteranceId = null
                emitSpeechEvent("tts://speech:done", utteranceId, "finish", utteranceTexts.remove(utteranceId))
                return@Runnable
            }
            if (tts.isSpeaking) {
                lastSpeakTime = System.currentTimeMillis()
                pollingHandler.postDelayed(pollingRunnable!!, 100)
            } else {
                val elapsed = System.currentTimeMillis() - lastSpeakTime
                if (elapsed > 1500) {
                    Log.d(TAG, "polling: isSpeaking=false, elapsed=$elapsed > 1500, emitting done")
                    isSpeaking = false
                    abandonAudioFocus()
                    if (currentUtteranceId == utteranceId) currentUtteranceId = null
                    emitSpeechEvent("tts://speech:done", utteranceId, "finish", utteranceTexts.remove(utteranceId))
                } else {
                    pollingHandler.postDelayed(pollingRunnable!!, 100)
                }
            }
        }
        pollingHandler.postDelayed(pollingRunnable!!, 100)
    }

    private fun stopPolling() {
        pollingRunnable?.let { pollingHandler.removeCallbacks(it) }
        pollingRunnable = null
    }

    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            audioFocusRequest?.let { audioManager?.requestAudioFocus(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            audioFocusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager?.abandonAudioFocus(null)
        }
    }

    // F2 事件契約：統一 emit 帶 utteranceId + reason（reason 預設空字串供 start 使用）
    private fun emitSpeechEvent(event: String, utteranceId: String?, reason: String = "", text: String? = null, error: String? = null) {
        val payload = JSObject().apply {
            put("utteranceId", utteranceId ?: "")
            put("reason", reason)
            if (text != null) put("text", text)
            if (error != null) put("error", error)
        }
        emitJsEvent(event, payload)
    }

    private fun emitJsEvent(event: String, payload: JSObject) {
        if (destroyed || webView == null) return
        val js = "window.__TAURI_INTERNALS__.emit('$event', ${payload.toString()})"
        try {
            webView?.post {
                // post 延遲執行時 activity 可能已 destroy → WebView 已銷毀，再 evaluateJavascript 會 native crash
                if (destroyed || webView == null) return@post
                try {
                    webView?.evaluateJavascript(js, null)
                } catch (e: Exception) {
                    Log.w(TAG, "emitJsEvent evaluate failed (webview destroyed?): ${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "emitJsEvent post failed: ${e.message}")
        }
    }

    // F3：lifecycle 三事件（TauriLifecycleObserver 註冊於 MainActivity.onCreate 後接通）。
    // 語意：app 整體背景化（ProcessLifecycleOwner 無可見 activity）才觸發 — 通知列下拉/系統對話框不停。

    /** 背景化 pause 共用路徑（onPause/onStop 都會來，冪等：第二次 id 已 null → no-op，只 emit 一次 stopped(pause)）。 */
    private fun pauseTts() {
        val id = currentUtteranceId
        if (id == null && !isSpeaking) return  // 無進行中 → no-op（防 onPause/onStop 雙觸發重複 emit）
        stopRequested = true                    // 在 tts?.stop() 之前設（引擎回調必在 stop 之後 → listener 的 stopRequested 檢查防雙重 emit，無 race）
        tts?.stop()
        isSpeaking = false
        abandonAudioFocus()
        stopPolling()
        if (id != null) {
            emitSpeechEvent("tts://speech:stopped", id, "pause", utteranceTexts.remove(id))
            currentUtteranceId = null
            focusNeedsRestore = true
        }
    }

    override fun onPause() {
        Log.d(TAG, "onPause()")
        pauseTts()
    }

    override fun onStop() {
        Log.d(TAG, "onStop()")
        pauseTts()
    }

    override fun onResume() {
        Log.d(TAG, "onResume()")
        // 不自動 resume（F3 定案：回前台不重播，用戶重新觸發 speak() 自身會 requestAudioFocus）；
        // 條件化 focus 恢復：僅背景化 pause 過才重新 request，避免無條件佔用 focus 壓制其他 app 音訊。
        if (focusNeedsRestore) {
            requestAudioFocus()
            focusNeedsRestore = false
        }
    }

    /** activity 銷毀：停掉 polling、斷開 WebView，避免 destroy race（pthread mutex crash）。 */
    override fun onDestroy(activity: AppCompatActivity) {
        Log.d(TAG, "onDestroy()")
        destroyed = true
        stopRequested = true
        stopPolling()
        webView = null
        tts?.stop()
        tts?.shutdown()
        tts = null
        abandonAudioFocus()
        utteranceTexts.clear()
        currentUtteranceId = null
    }
}
