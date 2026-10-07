package com.teno.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.TimeZone

/**
 * 桌面 Widget 核心（狀態／抽字兩顆獨立 widget）。JS 設計時器在背景不可靠（WebView 節流）
 * → 這裡擁有計時（AlarmManager）＋直讀 DB（teno.db = Tauri app_config_dir = dataDir）。
 * 到期口徑 1:1 鏡像 src/core/scheduler.js getDueCards（flip 模式）：
 *   新 = 無卡或 state=0（扣 buried/suspended）且未滿 cardsPerDay（扣 ratedNewToday）
 *   學 = state∈{1,3}、due < 十日界線；復 = state=2（同），復受 simParams.maxReviewsPerDay 上限
 *   日界線 = scheduler.nextDayAtMs（dayCutoff 分鐘、timezoneOffset 分鐘 local-UTC）
 * 顏色 = theme.js 同口徑（ACCENTS → hexToHSL → generateAccentVars），隨使用者主題設定走。
 */
object TenoWidget {
    const val ACTION_ROTATE = "com.teno.app.action.WIDGET_ROTATE"
    const val ACTION_DAY = "com.teno.app.action.WIDGET_DAY"
    const val ACTION_NOTIFY = "com.teno.app.action.WIDGET_NOTIFY"
    const val NOTIFY_ID = 1001
    const val NOTIFY_CHANNEL = "teno_remind"
    private const val DAY_MS = 86_400_000L

    data class Cfg(
        val rotateMin: Int,      // 抽字 widget 換字間隔（分鐘）
        val notifyOn: Boolean,
        val notifyIntervalSec: Int,  // 定時通知間隔（秒；下限 1 秒，小時無上限如 100）
        val notifyDue: Boolean,      // 內容池：今日到期
        val notifyWord: Boolean,     // 內容池：隨機字卡
        val notifyGoal: Boolean,     // 內容池：今日進度
        val notifyFields: List<String> = emptyList(),  // 通知字卡可開關欄位（10 欄白名單；與 widget wordFields 完全分開）
        val notifyDecks: List<String> = emptyList(),  // 通知抽字字本（複選；空＝全部；只影響通知）
        val residentOn: Boolean,
        val wordFields: List<String> = emptyList(),  // 抽字 widget 額外顯示欄位（words 欄名）
    ) {
        val periodMs: Long get() = rotateMin * 60_000L
        val notifyIntervalMs: Long get() = notifyIntervalSec.coerceAtLeast(1) * 1000L
        val notifyPool: List<String>
            get() = buildList {
                if (notifyDue) add("due")
                if (notifyWord) add("word")
                if (notifyGoal) add("goal")
            }
    }

    data class Counts(
        val newQ: Int,
        val learn: Int,
        val review: Int,
        val ratedNew: Int,
        val cardsPerDay: Int,
        val boundary: Long,
        val goalDone: Int = -1,   // goal_streak.current（今日已完成）
        val goalTotal: Int = -1,  // goal_streak.daily_goal（缺表 → -1 = 不顯示進度）
        val goalBest: Int = -1,   // goal_streak.best（最佳連勝天數）
        val learned: Int = -1,    // 已學卡數（cards 總數；缺表 → -1 不顯示）
    ) {
        /** 新卡今日額度 = getDueCards newQueue 扣 ratedNewToday（不負、超過額度歸 0）。 */
        val newToday: Int
            get() {
                var nt = if (ratedNew > 0) ratedNew else 0
                var added = 0
                while (added < newQ && nt < cardsPerDay) { nt++; added++ }
                return added
            }
    }

    data class PickedWord(val word: String, val def: String, val pron: String, val pos: String, val example: String, val id: String = "",
                          val extra: Map<String, String> = emptyMap())

    /**
     * 抽字 widget 額外可顯示欄位白名單（key = words 欄名 = 設定值；value = 卡片標籤）。
     * 只收這 6 個：覆蓋率高的欄位才值得佔卡片空間（syllables 97.7%、deck 100%、
     * related 92.8%、forms 89.7%、synonym 72.8%、antonym 57.6%）；etymology 太長、
     * examples/phrases 是 0% 死欄位，不開放。
     */
    val WORD_FIELD_LABEL = mapOf(
        "syllables" to "音節",
        "deck" to "字本",
        "related" to "相關",
        "forms" to "變化",
        "synonym" to "同",
        "antonym" to "反",
    )

    /**
     * 通知字卡可開關欄位白名單（key＝存值；前5＝固定欄位＝PickedWord 自有欄，後5＝words 動態欄位）。
     * deck 不在此列：字本＝抽字來源（notifyDecks 複選），不在通知裡顯示。
     */
    val NOTIFY_FIELD_LABEL = mapOf(
        "word" to "單字",
        "pron" to "音標",
        "pos" to "詞性",
        "def" to "翻譯",
        "example" to "例句",
        "syllables" to "音節",
        "related" to "相關",
        "forms" to "變化",
        "synonym" to "同",
        "antonym" to "反",
    )

    /**
     * 欄位值 → 卡片顯示文字。related/forms 存的是 JSON 陣列字串（'["a","b"]'），
     * 直接印會看到括號引號，故拆成逗號列；單欄截 60 字避免撐爆卡片。
     */
    internal fun wordFieldText(raw: String): String {
        val t = raw.trim()
        if (t.isEmpty()) return ""
        val s = if (t.startsWith("[")) {
            t.trim('[', ']').split(",").map { it.trim().trim('"') }
                .filter { it.isNotEmpty() }.joinToString(", ")
        } else t
        return if (s.length > 60) s.take(59) + "…" else s
    }

    /** 例句多行只抽一行（通知用；空/無例句 → null）。 */
    internal fun randomSentence(example: String): String? {
        val lines = example.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
        return if (lines.isEmpty()) null else lines[kotlin.random.Random.nextInt(lines.size)]
    }

    /** 發音統一 `/.../` 包覆 — db.js normPron 同口徑（舊資料裸音標/已包過都收斂；[ ] ( ) 界定保留）。 */
    internal fun normPron(raw: String): String {
        val t = raw.trim()
        if (t.isEmpty()) return ""
        if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("(") && t.endsWith(")"))) return t
        return "/" + t.trim('/') + "/"
    }

    /** widget 用色（theme.js generateAccentVars 同口徑）。 */
    data class ThemeColors(
        val surface: Int,   // 卡片底（accent-bg 同色：h, aSat*0.3, 深14/淺92）
        val text2: Int,     // 次要文字
        val accent: Int,    // 新／字
        val accent2: Int,   // 學（h+45）
        val accent3: Int,   // 復（h-35）
        val track: Int,     // 進度條底槽
    )

    fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences("teno_widget", Context.MODE_PRIVATE)

    fun cfg(ctx: Context): Cfg {
        val p = prefs(ctx)
        return Cfg(
            rotateMin = p.getInt("rotateMin", 60),
            notifyOn = p.getBoolean("notifyOn", false),
            // 秒制；舊版只存 notifyIntervalMin（分）→ 首次升級 ×60 遷移
            notifyIntervalSec = (if (p.contains("notifyIntervalSec")) p.getInt("notifyIntervalSec", 3600)
                else p.getInt("notifyIntervalMin", 60) * 60).coerceAtLeast(1),
            notifyDue = p.getBoolean("notifyDue", true),
            notifyWord = p.getBoolean("notifyWord", true),
            notifyGoal = p.getBoolean("notifyGoal", true),
            // V2 鍵存完整10欄；缺＝舊版（僅動態5欄）或首裝 → 固定5欄預設開＋搬舊動態勾選
            notifyFields = (if (p.contains("notifyFields2")) p.getString("notifyFields2", "") ?: ""
                else "word,pron,pos,def,example," + (p.getString("notifyFields", "") ?: ""))
                .split(",").map { it.trim() }.filter { it in NOTIFY_FIELD_LABEL },
            // 複選字本（JSON 陣列）；舊版單一 notifyDeck 字串 → 一元素
            notifyDecks = if (p.contains("notifyDecks")) parseJsonList(p.getString("notifyDecks", "[]") ?: "[]")
                else listOf(p.getString("notifyDeck", "") ?: "").filter { it.isNotEmpty() },
            residentOn = p.getBoolean("residentOn", false),
            wordFields = (p.getString("wordFields", "") ?: "").split(",")
                .map { it.trim() }.filter { it in WORD_FIELD_LABEL },
        )
    }

    fun saveCfg(ctx: Context, c: Cfg) {
        val old = cfg(ctx)
        val resetNext = c.notifyOn && (!old.notifyOn || c.notifyIntervalSec != old.notifyIntervalSec)
        prefs(ctx).edit()
            .putInt("rotateMin", c.rotateMin)
            .putBoolean("notifyOn", c.notifyOn)
            .putInt("notifyIntervalSec", c.notifyIntervalSec.coerceAtLeast(1))
            .putBoolean("notifyDue", c.notifyDue)
            .putBoolean("notifyWord", c.notifyWord)
            .putBoolean("notifyGoal", c.notifyGoal)
            .putString("notifyFields2", c.notifyFields.filter { it in NOTIFY_FIELD_LABEL }.joinToString(","))
            .putString("notifyDecks", org.json.JSONArray(c.notifyDecks).toString())
            .putBoolean("residentOn", c.residentOn)
            .putString("wordFields", c.wordFields.filter { it in WORD_FIELD_LABEL }.joinToString(","))
            .apply()
        // 開啟或改間隔 → 下一期從現在重算（關→開不沿用舊排程）
        if (resetNext) {
            prefs(ctx).edit().putLong("notifyNextAt", System.currentTimeMillis() + c.notifyIntervalMs).apply()
        }
    }

    // ─── 日期工具（scheduler.js 鏡像） ───────────────────────────

    /** JS Date.prototype.toISOString() 等價 — review_log 字串比較與 JS 同口徑。 */
    private val ISO_MS: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    internal fun isoUtc(ms: Long): String = ISO_MS.format(Instant.ofEpochMilli(ms))

    /** scheduler.nextDayAtMs 鏡像：now 之後的下一個 teno 日界線（ms）。tz = 分鐘 local-UTC。 */
    internal fun nextDayAtMs(dayCutoff: Int, tz: Int, now: Long): Long {
        val cutoff = if (dayCutoff > 0) dayCutoff else 0
        val l = Instant.ofEpochMilli(now + tz * 60000L).atZone(ZoneOffset.UTC)
        val mins = l.hour * 60 + l.minute
        val todayRoll = ZonedDateTime.of(l.year, l.monthValue, l.dayOfMonth, 0, 0, 0, 0, ZoneOffset.UTC)
            .toInstant().toEpochMilli() + cutoff * 60000L
        val next = if (mins < cutoff) todayRoll else todayRoll + DAY_MS
        return next - tz * 60000L
    }

    /** JS new Date(s) 解析；無效 → null（JS 端 NaN → 該卡不計入，同口徑）。 */
    internal fun parseMs(s: String?): Long? {
        if (s.isNullOrEmpty()) return null
        try { return Instant.parse(s).toEpochMilli() } catch (_: Exception) {}
        try { return OffsetDateTime.parse(s).toInstant().toEpochMilli() } catch (_: Exception) {}
        try { return LocalDate.parse(s).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() } catch (_: Exception) {}
        return null
    }

    // ─── DB 讀取 ─────────────────────────────────────────────────

    private fun dbFile(ctx: Context) = File(ctx.dataDir, "teno.db")

    fun dbOk(ctx: Context): Boolean = dbFile(ctx).exists()

    private fun openDb(ctx: Context): SQLiteDatabase? {
        val f = dbFile(ctx)
        if (!f.exists()) return null
        return SQLiteDatabase.openDatabase(f.path, null, SQLiteDatabase.OPEN_READONLY)
    }

    private fun idSet(raw: String?): Set<String> {
        if (raw.isNullOrEmpty()) return emptySet()
        return try {
            val a = JSONArray(raw)
            val out = HashSet<String>(a.length())
            for (i in 0 until a.length()) out.add(a.optString(i))
            out
        } catch (_: Exception) { emptySet() }
    }

    /** settings 表（key→value），JSON 解析失敗當原文（db.getSetting 同口徑）。 */
    private fun readSettings(db: SQLiteDatabase): Map<String, String> {
        val out = mutableMapOf<String, String>()
        db.rawQuery("SELECT key, value FROM settings", null).use { c ->
            while (c.moveToNext()) out[c.getString(0)] = c.getString(1)
        }
        return out
    }

    /** 今日到期口徑鏡像 store.refreshDerived／getDueCards（flip 模式）。null = DB 尚不可讀。 */
    internal fun readCounts(ctx: Context): Counts? {
        return try {
            val db = openDb(ctx) ?: return null
            db.use {
                val st = readSettings(db)
                val now = System.currentTimeMillis()
                val dayCutoff = st["dayCutoff"]?.toIntOrNull() ?: 0
                val anki = st["ankiSettings"]?.let { s -> try { JSONObject(s) } catch (_: Exception) { null } }
                val cardsPerDay = if (anki != null && anki.has("cardsPerDay") && !anki.isNull("cardsPerDay"))
                    anki.optInt("cardsPerDay", 20) else 20
                // JS -getTimezoneOffset（分）= local-UTC = Java TimeZone.getOffset 同義
                val tzDefault = TimeZone.getDefault().getOffset(now) / 60000
                val tz = if (anki != null && anki.has("timezoneOffset") && !anki.isNull("timezoneOffset"))
                    anki.optInt("timezoneOffset", tzDefault) else tzDefault
                val buried = idSet(st["buried"])
                val suspended = idSet(st["suspended"])
                val boundary = nextDayAtMs(dayCutoff, tz, now)
                val dayStartIso = isoUtc(boundary - DAY_MS)
                var rated = 0
                db.rawQuery(
                    "SELECT COUNT(*) FROM review_log WHERE card_state = 0 AND mode = 'flip' AND reviewed_at >= ?",
                    arrayOf(dayStartIso)
                ).use { c -> if (c.moveToFirst()) rated = c.getInt(0) }
                var newQ = 0; var learn = 0; var review = 0
                db.rawQuery(
                    "SELECT w.id, c.state, c.due FROM words w LEFT JOIN cards c ON c.word_id = w.id", null
                ).use { c ->
                    while (c.moveToNext()) {
                        val id = c.getString(0) ?: continue
                        if (id in buried || id in suspended) continue
                        val state = if (c.isNull(1)) -1 else c.getInt(1)
                        if (state < 0 || state == 0) { newQ++; continue }
                        val dueMs = parseMs(if (c.isNull(2)) null else c.getString(2)) ?: continue
                        if (dueMs >= boundary) continue
                        if (state == 2) review++ else learn++
                    }
                }
                val simMax = st["simParams"]?.let { s ->
                    try { JSONObject(s).optInt("maxReviewsPerDay", 0) } catch (_: Exception) { 0 }
                } ?: 0
                if (simMax in 1 until review) review = simMax
                var goalDone = -1; var goalTotal = -1; var goalBest = -1
                db.rawQuery("SELECT daily_goal, current, best FROM goal_streak WHERE id = 1", null).use { c ->
                    if (c.moveToFirst()) { goalTotal = c.getInt(0); goalDone = c.getInt(1); goalBest = c.getInt(2) }
                }
                var learned = -1
                try {
                    db.rawQuery("SELECT COUNT(*) FROM cards", null).use { c ->
                        if (c.moveToFirst()) learned = c.getInt(0)
                    }
                } catch (_: Exception) {}
                Counts(newQ, learn, review, rated, cardsPerDay, boundary, goalDone, goalTotal, goalBest, learned)
            }
        } catch (_: Exception) { null }
    }

    /** JSON 字串陣列 → List<String>（缺/壞 → 空）。 */
    internal fun parseJsonList(s: String): List<String> = try {
        val a = org.json.JSONArray(s)
        (0 until a.length()).map { a.getString(it) }
    } catch (_: Exception) { emptyList() }

    /** 隨機一字（排除上一字避免連續重複）。decks 空 → 全字本；非空 → 複選字本合併池（通知用）；fields 預設 widget 勾選。 */
    internal fun pickWord(ctx: Context, decks: List<String> = emptyList(), fields: List<String> = cfg(ctx).wordFields): PickedWord? {
        return try {
            val db = openDb(ctx) ?: return null
            db.use {
                val last = prefs(ctx).getLong("lastWordId", -1)
                //只撈勾選的額外欄位（未勾不 SELECT，維持原本 7 欄）
                val want = fields.filter { it in WORD_FIELD_LABEL }
                fun q(sql: String, args: Array<String>?): PickedWord? =
                    db.rawQuery(sql, args).use { c ->
                        if (!c.moveToFirst()) return@use null
                        val w = c.getString(0) ?: ""
                        val d = if (c.isNull(1)) "" else c.getString(1)
                        val pron = normPron(if (c.isNull(2)) "" else c.getString(2))
                        val pos = if (c.isNull(3)) "" else c.getString(3)
                        val ex = if (c.isNull(4)) "" else c.getString(4)
                        prefs(ctx).edit().putLong("lastWordId", c.getLong(5)).apply()
                        val wid = if (c.isNull(6)) "" else c.getString(6)
                        val extra = want.mapNotNull { f ->
                            val i = c.getColumnIndex(f)
                            if (i < 0 || c.isNull(i)) null else f to c.getString(i)
                        }.filter { it.second.isNotBlank() }.toMap()
                        PickedWord(w, d, pron, pos, ex, wid, extra)
                    }
                val cols = "word, definition, pronunciation, part_of_speech, example, rowid, id" +
                    want.joinToString("") { ", $it" }
                // decks 為綁定參數（值非識別字串 → 無注入面）
                val deckCond = if (decks.isEmpty()) "" else " AND deck IN (" + decks.joinToString(",") { "?" } + ")"
                val deckArgs = decks.toTypedArray()
                q("SELECT $cols FROM words WHERE word != ''$deckCond AND rowid != ? ORDER BY RANDOM() LIMIT 1",
                    deckArgs + arrayOf(last.toString()))
                    ?: q("SELECT $cols FROM words WHERE word != ''$deckCond ORDER BY RANDOM() LIMIT 1",
                        if (deckArgs.isEmpty()) null else deckArgs)
            }
        } catch (_: Exception) { null }
    }

    // ─── 主題色（theme.js 鏡像：ACCENTS → hexToHSL → generateAccentVars） ───

    /** src/lib/theme.js ACCENTS 表同值（改色表兩邊一起改）。 */
    private val ACCENTS = mapOf(
        "lemonChiffon" to "#FFFACD", "skyBlue" to "#87CEEB", "peach" to "#FFDAB9",
        "mintGreen" to "#98FF98", "lavender" to "#E6E6FA", "coralPink" to "#F08080",
        "springGreen" to "#00FF7F", "sunshineYellow" to "#FFD700", "babyBlue" to "#89CFF0",
        "apricot" to "#FBCEB1", "turquoise" to "#40E0D0", "candyPink" to "#FF91AF",
        "limePunch" to "#D0F0C0", "periwinkle" to "#CCCCFF", "creamyOrange" to "#FFCC99",
        "aquamarine" to "#7FFFD4", "orchid" to "#DA70D6", "buttercup" to "#F3E5AB",
        "seafoam" to "#93E9BE", "skyMagenta" to "#CF71AF",
        "sage" to "#8A9A5B", "sand" to "#C2B280", "mist" to "#BCC6CC", "clay" to "#B47E70",
        "slate" to "#708090", "peachFuzz" to "#FFBE98", "olive" to "#808000", "cloud" to "#F5F5F5",
        "dustyRose" to "#DCAE96", "midnight" to "#191970", "forestMoss" to "#6B705C",
        "parchment" to "#F4EBD9", "stormySky" to "#778DA9", "terracotta" to "#A47148",
        "lavenderMist" to "#B7B7A4", "oceanTeal" to "#4A7C59", "warmTaupe" to "#9C8975",
        "eveningGlow" to "#C9ADA7", "steelBlue" to "#4682B4", "winterPine" to "#2F3E46",
    )

    /** theme.js hexToHSL 鏡像 → [h(0..360), s(0..100), l(0..100)]。 */
    internal fun hexToHsl(hex: String): FloatArray {
        val r = hex.substring(1, 3).toInt(16) / 255f
        val g = hex.substring(3, 5).toInt(16) / 255f
        val b = hex.substring(5, 7).toInt(16) / 255f
        val max = maxOf(r, g, b); val min = minOf(r, g, b)
        var h = 0f; var s = 0f; val l = (max + min) / 2f
        if (max != min) {
            val d = max - min
            s = if (l > 0.5f) d / (2f - max - min) else d / (max + min)
            h = when (max) {
                r -> ((g - b) / d + (if (g < b) 6f else 0f)) / 6f
                g -> ((b - r) / d + 2f) / 6f
                else -> ((r - g) / d + 4f) / 6f
            }
        }
        return floatArrayOf(h * 360f, s * 100f, l * 100f)
    }

    /** theme.js hslToRgb 鏡像 → 不透明 ARGB（s/l 為百分比）。 */
    internal fun hslToColor(h: Float, s: Float, l: Float): Int {
        val hh = ((h % 360f) + 360f) % 360f
        val ss = s / 100f; val ll = l / 100f
        val c = (1f - kotlin.math.abs(2f * ll - 1f)) * ss
        val x = c * (1f - kotlin.math.abs((hh / 60f) % 2f - 1f))
        val m = ll - c / 2f
        val (r1, g1, b1) = when {
            hh < 60f -> Triple(c, x, 0f)
            hh < 120f -> Triple(x, c, 0f)
            hh < 180f -> Triple(0f, c, x)
            hh < 240f -> Triple(0f, x, c)
            hh < 300f -> Triple(x, 0f, c)
            else -> Triple(c, 0f, x)
        }
        val r = ((r1 + m) * 255f).toInt().coerceIn(0, 255)
        val g = ((g1 + m) * 255f).toInt().coerceIn(0, 255)
        val b = ((b1 + m) * 255f).toInt().coerceIn(0, 255)
        return -0x1000000 or (r shl 16) or (g shl 8) or b
    }

    /** 讀 settings（themeMode/themeAccent/themeAccentIntensity）→ widget 用色；DB 缺 → 深色 skyBlue。 */
    internal fun themeColors(ctx: Context): ThemeColors {
        var mode = "dark"; var name = "skyBlue"; var intensity = 0.5f
        try {
            openDb(ctx)?.use { db ->
                val st = readSettings(db)
                st["themeMode"]?.let { mode = it }
                st["themeAccent"]?.let { if (ACCENTS.containsKey(it)) name = it }
                st["themeAccentIntensity"]?.toFloatOrNull()?.let { intensity = it.coerceIn(0f, 1f) }
            }
        } catch (_: Exception) {}
        return colorsFor(mode, name, intensity)
    }

    /** theme.js generateAccentVars 的 aL/aSat 公式鏡像（intensity 0..1）。 */
    internal fun colorsFor(mode: String, accentName: String, intensity: Float): ThemeColors {
        val dark = mode != "light"
        val hs = hexToHsl(ACCENTS[accentName] ?: ACCENTS.getValue("skyBlue"))
        val h = hs[0]
        val aSat = minOf(hs[1] * 1.2f, 100f)
        var aL = if (dark) minOf(maxOf(hs[2] + 12f, 55f), 78f)
                 else minOf(maxOf(hs[2] - 12f, 36f), 55f)
        aL += if (dark) (intensity - 0.5f) * 40f else -(intensity - 0.5f) * 40f
        aL = aL.coerceIn(25f, 92f)
        // 淺底文字用 accent-deep（aL-24；JS --accent-deep 同口徑），深底直接用 accent
        val tL = if (dark) aL else aL - 24f
        return ThemeColors(
            surface = hslToColor(h, aSat * 0.3f, if (dark) 14f else 92f),
            text2 = if (dark) Color.parseColor("#9A9AA6") else Color.parseColor("#5A5A66"),
            accent = hslToColor(h, aSat, tL),
            accent2 = hslToColor((h + 45f) % 360f, aSat, tL),
            accent3 = hslToColor((h - 35f + 360f) % 360f, aSat, tL),
            track = hslToColor(h, aSat * 0.3f, if (dark) 26f else 84f),
        )
    }

    // ─── 渲染 ───────────────────────────────────────────────────

    /** route≠null → extras teno_route/teno_arg 帶進 MainActivity（singleTask → onNewIntent /
     *  冷啟 onCreate → evaluateJavascript 推 window.__widgetRoute）。requestCode 分顆避免互相覆蓋
     *  （filterEquals 不比 extras → 同 code 的 extras 由 UPDATE_CURRENT 原地更新，不累積 PI）。 */
    private fun launchPending(ctx: Context, route: String? = null, arg: String? = null, code: Int = 0): PendingIntent? {
        val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (route != null) {
            i.putExtra("teno_route", route)
            if (arg != null) i.putExtra("teno_arg", arg)
        } else {
            i.removeExtra("teno_route")
            i.removeExtra("teno_arg")
        }
        return PendingIntent.getActivity(ctx, code, i,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** 分別推送兩顆 widget（沒實例的那顆 no-op）。 */
    fun renderAll(ctx: Context) {
        val mgr = AppWidgetManager.getInstance(ctx)
        val t = themeColors(ctx)
        val sIds = mgr.getAppWidgetIds(ComponentName(ctx, TenoStatusWidgetProvider::class.java))
        if (sIds.isNotEmpty()) mgr.updateAppWidget(sIds, statusViews(ctx, t))
        val wIds = mgr.getAppWidgetIds(ComponentName(ctx, TenoWordWidgetProvider::class.java))
        if (wIds.isNotEmpty()) mgr.updateAppWidget(wIds, wordViews(ctx, t))
        val kIds = mgr.getAppWidgetIds(ComponentName(ctx, TenoWeeklyWidgetProvider::class.java))
        if (kIds.isNotEmpty()) mgr.updateAppWidget(kIds, weeklyViews(ctx, t))
        val cIds = mgr.getAppWidgetIds(ComponentName(ctx, TenoCaptureWidgetProvider::class.java))
        if (cIds.isNotEmpty()) mgr.updateAppWidget(cIds, captureViews(ctx, t))
    }

    private fun statusViews(ctx: Context, t: ThemeColors): RemoteViews {
        val rv = RemoteViews(ctx.packageName, R.layout.widget_status)
        rv.setInt(R.id.wsBg, "setColorFilter", t.surface)
        rv.setInt(R.id.wsTitle, "setTextColor", t.text2)
        rv.setInt(R.id.wsGoal, "setTextColor", t.accent)
        rv.setInt(R.id.wsNewNum, "setTextColor", t.accent)
        rv.setInt(R.id.wsNewLabel, "setTextColor", t.text2)
        rv.setInt(R.id.wsLearnNum, "setTextColor", t.accent2)
        rv.setInt(R.id.wsLearnLabel, "setTextColor", t.text2)
        rv.setInt(R.id.wsReviewNum, "setTextColor", t.accent3)
        rv.setInt(R.id.wsReviewLabel, "setTextColor", t.text2)
        val counts = readCounts(ctx)
        if (counts == null) {
            rv.setTextViewText(R.id.wsTitle, "開啟 Teno 同步資料")
            rv.setTextViewText(R.id.wsNewNum, "–")
            rv.setTextViewText(R.id.wsLearnNum, "–")
            rv.setTextViewText(R.id.wsReviewNum, "–")
            rv.setTextViewText(R.id.wsGoal, "")
            rv.setViewVisibility(R.id.wsBar, View.GONE)
            rv.setViewVisibility(R.id.wsCaption, View.GONE)
        } else {
            rv.setTextViewText(R.id.wsTitle, "Teno · 今日到期")
            rv.setTextViewText(R.id.wsNewNum, counts.newToday.toString())
            rv.setTextViewText(R.id.wsLearnNum, counts.learn.toString())
            rv.setTextViewText(R.id.wsReviewNum, counts.review.toString())
            if (counts.goalTotal > 0) {
                rv.setViewVisibility(R.id.wsBar, View.VISIBLE)
                rv.setTextViewText(R.id.wsGoal, "${counts.goalDone}/${counts.goalTotal}")
                val pct = (counts.goalDone.toFloat() / counts.goalTotal).coerceIn(0f, 1f)
                rv.setFloat(R.id.wsFill, "setPivotX", 0f)
                rv.setFloat(R.id.wsFill, "setScaleX", pct)
                rv.setInt(R.id.wsTrack, "setColorFilter", t.track)
                rv.setInt(R.id.wsFill, "setColorFilter", t.accent)
            } else {
                rv.setViewVisibility(R.id.wsBar, View.GONE)
                rv.setTextViewText(R.id.wsGoal, "")
            }
            val caps = buildList {
                if (counts.goalBest >= 0) add("連勝 ${counts.goalBest} 天")
                if (counts.learned >= 0) add("已學 ${counts.learned} 字")
            }
            if (caps.isEmpty()) rv.setViewVisibility(R.id.wsCaption, View.GONE)
            else {
                rv.setViewVisibility(R.id.wsCaption, View.VISIBLE)
                rv.setTextViewText(R.id.wsCaption, caps.joinToString("　·　"))
            }
        }
        launchPending(ctx, "review", null, 10)?.let { rv.setOnClickPendingIntent(R.id.widgetRoot, it) }
        return rv
    }

    private fun wordViews(ctx: Context, t: ThemeColors): RemoteViews {
        val rv = RemoteViews(ctx.packageName, R.layout.widget_word)
        rv.setInt(R.id.wgBg, "setColorFilter", t.surface)
        rv.setInt(R.id.wwWord, "setTextColor", t.accent)
        rv.setInt(R.id.wwPron, "setTextColor", t.accent2)
        rv.setInt(R.id.wwMeta, "setTextColor", t.text2)
        rv.setInt(R.id.wwDef, "setTextColor", t.text2)
        rv.setInt(R.id.wwEx, "setTextColor", t.text2)
        rv.setInt(R.id.wwExtra, "setTextColor", t.text2)
        rv.setInt(R.id.wwRefresh, "setColorFilter", t.accent)
        val w = pickWord(ctx)
        rv.setTextViewText(R.id.wwWord, w?.word ?: "—")
        rv.setTextViewText(R.id.wwDef, w?.def ?: "開啟 Teno 匯入字庫")
        val pron = w?.pron ?: ""
        if (pron.isEmpty()) rv.setViewVisibility(R.id.wwPron, View.GONE)
        else {
            rv.setViewVisibility(R.id.wwPron, View.VISIBLE)
            rv.setTextViewText(R.id.wwPron, pron)
        }
        val pos = w?.pos ?: ""
        if (pos.isEmpty()) rv.setViewVisibility(R.id.wwMeta, View.GONE)
        else {
            rv.setViewVisibility(R.id.wwMeta, View.VISIBLE)
            rv.setTextViewText(R.id.wwMeta, pos)
        }
        val ex = w?.example ?: ""
        if (ex.isEmpty()) rv.setViewVisibility(R.id.wwEx, View.GONE)
        else {
            rv.setViewVisibility(R.id.wwEx, View.VISIBLE)
            rv.setTextViewText(R.id.wwEx, ex)
        }
        // 額外欄位：設定頁勾選的欄位逐行顯示（一欄沒值就跳過；全空 = GONE，維持原樣）
        val extra = cfg(ctx).wordFields.filter { it in WORD_FIELD_LABEL }.mapNotNull { f ->
            val v = wordFieldText(w?.extra?.get(f) ?: "")
            if (v.isEmpty()) null else "${WORD_FIELD_LABEL[f]} $v"
        }.joinToString("\n")
        if (extra.isEmpty()) rv.setViewVisibility(R.id.wwExtra, View.GONE)
        else {
            rv.setViewVisibility(R.id.wwExtra, View.VISIBLE)
            rv.setTextViewText(R.id.wwExtra, extra)
        }
        rv.setOnClickPendingIntent(R.id.wwRefresh, pi(ctx, ACTION_ROTATE))
        launchPending(ctx, "word", w?.id?.ifEmpty { null }, 20)
            ?.let { rv.setOnClickPendingIntent(R.id.widgetRoot, it) }
        return rv
    }

    // ─── 本週複習 widget（review_log 近7日；[0]=6天前 … [6]=今天） ───

    /** 每日複習次數（本地日曆日；dayCutoff 鏡像若要極準再升級 — widget 圖表用日曆日已足）。 */
    internal fun readWeekly(ctx: Context): IntArray? {
        return try {
            val db = openDb(ctx) ?: return null
            db.use {
                val out = IntArray(7)
                val today = LocalDate.now()
                db.rawQuery(
                    "SELECT reviewed_at FROM review_log WHERE reviewed_at >= ?",
                    arrayOf(isoUtc(System.currentTimeMillis() - 7L * DAY_MS))
                ).use { c ->
                    while (c.moveToNext()) {
                        val ms = parseMs(if (c.isNull(0)) null else c.getString(0)) ?: continue
                        val d = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()
                        val off = (today.toEpochDay() - d.toEpochDay()).toInt()
                        if (off in 0..6) out[6 - off]++
                    }
                }
                out
            }
        } catch (_: Exception) { null }
    }

    /** 柱狀圖 bitmap（固定畫布 540×144 → fitCenter 等比縮放不變形；遠端視圖封包 <1MB）。
     *  今日 t.accent 實色＋粗體計數；過去日 accent 半透明；0 日 track 短樁＋基線。 */
    internal fun weeklyChart(t: ThemeColors, w: IntArray): Bitmap {
        val bw = 540; val bh = 144
        val bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val d = 24f                                   // 左右留白
        val baseY = 112f                              // 柱底基線
        val colW = (bw - 2 * d) / 7f
        val barW = colW * 0.46f
        val maxV = w.max().coerceAtLeast(1)
        val maxBar = 80f
        val areaL = d; val areaR = bw - d

        fun alphaOf(color: Int, a: Int) = (color and 0x00FFFFFF) or (a shl 24)
        val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = alphaOf(t.track, 170); strokeWidth = 2f }
        c.drawLine(areaL, baseY + 1f, areaR, baseY + 1f, line)

        val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        val countPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = Paint.Align.CENTER; textSize = 17f
        }
        val dayPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = Paint.Align.CENTER; textSize = 16f
        }
        val cnDay = arrayOf("一", "二", "三", "四", "五", "六", "日")
        val today = LocalDate.now()
        for (i in 0..6) {
            val v = w[i].coerceAtLeast(0)
            val isToday = i == 6
            val date = today.minusDays((6 - i).toLong())
            val x = d + i * colW + colW / 2f
            val barH = if (v == 0) 5f else (v.toFloat() / maxV * maxBar).coerceAtLeast(6f)
            barPaint.color = when {
                v == 0 -> t.track
                isToday -> t.accent
                else -> alphaOf(t.accent, 105)
            }
            val r = RectF(x - barW / 2f, baseY - barH, x + barW / 2f, baseY)
            c.drawRoundRect(r, 8f, 8f, barPaint)
            if (v > 0) {
                countPaint.color = if (isToday) t.accent else t.text2
                countPaint.typeface = if (isToday) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                c.drawText(v.toString(), x, baseY - barH - 6f, countPaint)
            }
            dayPaint.color = if (isToday) t.accent else t.text2
            dayPaint.typeface = if (isToday) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            c.drawText(cnDay[date.dayOfWeek.value - 1], x, baseY + 24f, dayPaint)
        }
        return bmp
    }

    private fun weeklyViews(ctx: Context, t: ThemeColors): RemoteViews {
        val rv = RemoteViews(ctx.packageName, R.layout.widget_weekly)
        rv.setInt(R.id.wkBg, "setColorFilter", t.surface)
        rv.setInt(R.id.wkTitle, "setTextColor", t.text2)
        rv.setInt(R.id.wkCaption, "setTextColor", t.text2)
        val w = readWeekly(ctx)
        if (w == null) {
            rv.setTextViewText(R.id.wkTitle, "開啟 Teno 同步資料")
            rv.setViewVisibility(R.id.wkChart, View.GONE)
            rv.setViewVisibility(R.id.wkCaption, View.GONE)
        } else {
            rv.setTextViewText(R.id.wkTitle, "Teno · 本週複習")
            rv.setViewVisibility(R.id.wkChart, View.VISIBLE)
            rv.setImageViewBitmap(R.id.wkChart, weeklyChart(t, w))
            val sum = w.sum()
            rv.setViewVisibility(R.id.wkCaption, View.VISIBLE)
            rv.setTextViewText(R.id.wkCaption, if (sum == 0) "還沒有複習紀錄"
                else "本週 ${sum} 次　·　日均 ${(sum + 6) / 7} 次")
        }
        launchPending(ctx, null, null, 30)?.let { rv.setOnClickPendingIntent(R.id.widgetRoot, it) }
        return rv
    }

    // ─── 快速收詞 widget（靜態 +，點擊 → 字庫新增 modal） ───

    private fun captureViews(ctx: Context, t: ThemeColors): RemoteViews {
        val rv = RemoteViews(ctx.packageName, R.layout.widget_capture)
        rv.setInt(R.id.wcBg, "setColorFilter", t.surface)
        rv.setInt(R.id.wcPlus, "setTextColor", t.accent)
        rv.setInt(R.id.wcLabel, "setTextColor", t.text2)
        launchPending(ctx, "add", null, 40)?.let { rv.setOnClickPendingIntent(R.id.widgetRoot, it) }
        return rv
    }

    // ─── 鬧鐘 ───────────────────────────────────────────────────

    private fun pi(ctx: Context, action: String): PendingIntent {
        val i = Intent(ctx, TenoRefreshReceiver::class.java).setAction(action)
        return PendingIntent.getBroadcast(ctx, action.hashCode(), i,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun sched(am: AlarmManager, at: Long, p: PendingIntent) {
        try { am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p) }
        catch (_: SecurityException) {
            try { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p) } catch (_: Exception) {}
        }
    }

    /** 武裝（或重武裝）所有鬧鐘 — PendingIntent 同 action 會取代，重複呼叫安全。 */
    fun armAlarms(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val c = cfg(ctx)
        val now = System.currentTimeMillis()
        // 換字鬧鐘只在抽字 widget 有實例時武裝（狀態 widget 獨立不受影響）
        val hasWord = AppWidgetManager.getInstance(ctx)
            .getAppWidgetIds(ComponentName(ctx, TenoWordWidgetProvider::class.java)).isNotEmpty()
        if (hasWord) sched(am, now + c.periodMs, pi(ctx, ACTION_ROTATE))
        else am.cancel(pi(ctx, ACTION_ROTATE))
        val boundary = readCounts(ctx)?.boundary ?: nextDayAtMs(0, TimeZone.getDefault().getOffset(now) / 60000, now)
        sched(am, boundary, pi(ctx, ACTION_DAY))
        // 定時通知：照 notifyNextAt 排（重入不重排計時；fire 後寫入下一期）
        if (c.notifyOn && c.notifyPool.isNotEmpty()) {
            var next = prefs(ctx).getLong("notifyNextAt", -1L)
            if (next <= now) {
                next = now + c.notifyIntervalMs
                prefs(ctx).edit().putLong("notifyNextAt", next).apply()
            }
            sched(am, next, pi(ctx, ACTION_NOTIFY))
        } else am.cancel(pi(ctx, ACTION_NOTIFY))
    }

    fun cancelAlarms(ctx: Context, includeNotify: Boolean = true) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        am.cancel(pi(ctx, ACTION_ROTATE))
        am.cancel(pi(ctx, ACTION_DAY))
        if (includeNotify) am.cancel(pi(ctx, ACTION_NOTIFY))
    }

    // ─── 通知 ───────────────────────────────────────────────────

    /** 定時通知：從勾選的內容池隨機抽一則顯示，並寫入下一期的 notifyNextAt。 */
    fun postNotification(ctx: Context) {
        val c = cfg(ctx)
        if (!c.notifyOn) return
        val pool = c.notifyPool
        if (pool.isEmpty()) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                android.app.NotificationChannel(NOTIFY_CHANNEL, "定時提醒",
                    android.app.NotificationManager.IMPORTANCE_DEFAULT))
        }
        val counts = readCounts(ctx)
        val pick = pool[kotlin.random.Random.nextInt(pool.size)]
        val (title, body) = when (pick) {
            "word" -> {
                // 抽字來源＝notifyDecks 複選字本合併池（空＝全部）；欄位吃通知專屬勾選；渲染按白名單固定序
                val w = pickWord(ctx, c.notifyDecks, c.notifyFields)
                // 各件 enter 分行；空欄跳過；例句多行隨機抽一句
                "Teno" to (if (w == null) "開啟 Teno 匯入字庫" else run {
                    val lines = mutableListOf<String>()
                    for (f in NOTIFY_FIELD_LABEL.keys) {
                        if (f !in c.notifyFields) continue
                        when (f) {
                            "word" -> lines += w.word
                            "pron" -> if (w.pron.isNotEmpty()) lines += w.pron
                            "pos" -> if (w.pos.isNotEmpty()) lines += w.pos
                            "def" -> if (w.def.isNotEmpty()) lines += w.def
                            "example" -> randomSentence(w.example)?.let { lines += it }
                            else -> {
                                val v = w.extra[f]?.let { wordFieldText(it) }
                                if (!v.isNullOrEmpty()) lines += "${NOTIFY_FIELD_LABEL[f]} $v"
                            }
                        }
                    }
                    if (lines.isEmpty()) lines += w.word   // 全數關閉 → 兜底單字
                    lines.joinToString("\n")
                })
            }
            "goal" -> "Teno 今日進度" to (if (counts != null && counts.goalTotal > 0)
                "今日 ${counts.goalDone.coerceAtLeast(0)}/${counts.goalTotal}" +
                    (if (counts.goalBest >= 0) "　連勝 ${counts.goalBest} 天" else "")
                else "開啟 Teno 設定每日目標")
            else -> "Teno 今日到期" to (if (counts != null)
                "新 ${counts.newToday} · 學 ${counts.learn} · 復 ${counts.review}" else "打開 Teno 看看")
        }
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(ctx, NOTIFY_CHANNEL)
                else android.app.Notification.Builder(ctx)
        val n = b
            .setSmallIcon(R.drawable.ic_stat_teno)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(android.app.Notification.BigTextStyle().bigText(body))
            .setContentIntent(launchPending(ctx))
            .setAutoCancel(true)
            .build()
        try { nm.notify(NOTIFY_ID, n) } catch (_: Exception) {}
        // 下一期（receiver 隨後 armAlarms 會照這個值武裝，重入不重排）
        prefs(ctx).edit()
            .putLong("notifyNextAt", System.currentTimeMillis() + c.notifyIntervalMs)
            .apply()
    }

    // ─── 常駐服務（前台服務；使用者預設關） ──────────────────────

    fun syncResident(ctx: Context) {
        val want = cfg(ctx).residentOn
        val running = TenoResidentService.running
        if (want && !running) {
            try {
                val i = Intent(ctx, TenoResidentService::class.java)
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (_: Exception) {}
        } else if (!want && running) {
            try { ctx.stopService(Intent(ctx, TenoResidentService::class.java)) } catch (_: Exception) {}
        }
    }
}
