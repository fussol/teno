// ═══════════════════════════════════════════════════════════════
// Store — Single source of truth for all app state.
// Reactive: subscribe to changes, dispatch actions to mutate.
// ═══════════════════════════════════════════════════════════════

import * as db from './db.js';
import { startAutoBackup } from './backup-scheduler.js';
import { FSRS, AGAIN, HARD, GOOD, EASY, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING, generateFuzzFactor, parseStepsStr } from '../core/fsrs.js';
import { mulberry32 } from './rng.js';
import { DEFAULT_BLACKLIST, normalizeBlackWord } from './ocr-blacklist.js';

/**
 * A9: 作答時間 cap — 對齊 Anki rslib `cap_answer_time_to_secs`（預設 60s，
 * deckconfig/mod.rs:65，合法範圍 1~9999）。Anki answering/mod.rs:60 cap_answer_secs 行為：
 * `milliseconds_taken = min(milliseconds_taken, max_secs * 1000)`，於 revlog 寫入前套用，
 * 避免單筆 outlier（使用者放著卡片很久）扭曲 FSRS 優化。teno duration 單位為 ms
 * （呼叫端 Date.now() - shownAt），故 cap = 60 * 1000 ms。
 */
const CAP_ANSWER_TIME_MS = 60 * 1000;

/** learnAheadLimit clamp（L1）：NaN/undefined/null → 20（預設），0 保留（關閉提前），超限夾 [0,20] */
export function clampLearnAhead(v) {
  return Number.isFinite(v) ? Math.min(20, Math.max(0, v)) : 20;
}

let _idCounter = 0;
function nextWordId() {
  return 'w_' + Date.now().toString(36) + '_' + (++_idCounter).toString(36) + Math.random().toString(36).slice(2, 4);
}

/** Default Anki settings */
const DEFAULT_ANKI = {
  maxIvl: 365,
  cardsPerDay: 20,
  leechThreshold: 8,
  desiredRetention: 0.9,
  fsrsWeights: null,
  learnSteps: '1,10',      // minutes, comma-separated
  relearnSteps: '10',       // minutes, comma-separated
  reviewMix: 2,             // 0=AfterReviews, 1=BeforeReviews, 2=MixWithReviews
  timezoneOffset: null,     // minutes from UTC (e.g. 480 = UTC+8), null = system local
  learnAheadLimit: 20,      // minutes, Anki default
  easyDaysPercentages: [1, 1, 1, 1, 1, 1, 1],  // 週一~週日 0/0.5/1（對齊 Anki EasyDay，模擬 load balancer 用）
};

/** Default sim params — matching Anki/fsrs-rs SimulatorConfig::default() */
const DEFAULT_SIM = {
  maxReviewsPerDay: 1000,
  maxCostPerDay: 99999,
  newCardsIgnoreReviewLimit: true,
  learningStepCount: 2,
  relearningStepCount: 1,
  humanMode: false,
  humanSkipRate: 8,
  humanJitter: 30,
  humanWeekendMod: 90,
  humanAccRange: 15,
  humanFatigueProb: 0.003,
  first_rating_prob: [0.24, 0.094, 0.495, 0.171],
  review_rating_prob: [0.224, 0.631, 0.145],
  learningStepTransitions: [
    [0.3686, 0.0628, 0.5108, 0.0577],
    [0.0442, 0.4553, 0.4457, 0.0549],
    [0.0519, 0.047, 0.8462, 0.055],
  ],
  relearningStepTransitions: [
    [0.2157, 0.0643, 0.6595, 0.0604],
    [0.05, 0.4638, 0.4475, 0.0387],
    [0.1057, 0.1434, 0.7266, 0.0244],
  ],
  state_rating_costs: [
    [19.58, 18.79, 13.78, 10.71],
    [19.38, 17.59, 12.38, 8.94],
    [16.44, 15.25, 12.32, 8.03],
  ],
  reviewMix: 2,
  timezoneOffset: null,
};

/**
 * Create the app store.
 * @returns {import('./store.js').AppStore}
 */
export function createStore() {
  /** @type {Set<Function>} */
  const listeners = new Set();

  /** @type {object} */
  const state = {
    ready: false,
    words: [],
    cards: new Map(),     // word_id → card object (flip mode)
    cardsMc: new Map(),   // word_id → card object (multiple choice)
    cardsSpell: new Map(),// word_id → card object (spelling)
    decks: [],
    folders: {},
    additions: [],
    reviewLog: [],
    _undoSnapshots: {},   // C1: 多槽 undo 快照（key = mode: flip/mc/spell），每槽只存/只還原自己 mode 的狀態
    _dirty: false,
    examHistory: [],
    goalStreak: { dailyGoal: 20, current: 0, best: 0, dates: {} },
    ankiSettings: { ...DEFAULT_ANKI },
    ankiSettingsMc: { ...DEFAULT_ANKI },
    ankiSettingsSpell: { ...DEFAULT_ANKI },
    simParams: { ...DEFAULT_SIM },
    logRetentionDays: 14,
    devMode: false,           // developer mode (tap version 10× in Settings → unlock CLI tools)
    blacklist: DEFAULT_BLACKLIST.slice(),   // OCR 錄入黑名單（含預設：簡單字＋草漯 100/基礎/初級詞，devMode 可增刪）
    graylist: [],                            // OCR 灰名單：使用者 OCR「取消勾選淘汰」的字，同黑名單排除，devMode 可增刪＋CSV 匯入
    ocrMode: 'scan',                       // OCR 模式：scan（全掃描·一般辨識）/ highlight（螢光筆·高信心）
    ocrRestoreModel: '',                      // 可選 AI 還原模型（進階/devMode；空=純離線 edit-distance 還原，不呼叫 LLM）
    ocrCambridgeVerify: true,  // OCR 錄入 Cambridge 查證開關（查得到才入；devMode 可關）
    buried: new Set(),
    suspended: new Set(),
    buriedMc: new Set(),
    suspendedMc: new Set(),
    buriedSpell: new Set(),
    suspendedSpell: new Set(),
    buriedAt: {},        // A5: wordId → 'YYYY-MM-DD' 埋卡日（平行日期字串，不動既有 Set）
    buriedAtMc: {},
    buriedAtSpell: {},
    examples: new Map(),
    systemTags: [         // built-in tags, always present
      { id: 'tag_correct',    name: 'correct',    color: '#4ade80', builtIn: true, role: 'correct',    desc: '測驗答對時自動貼上此標籤' },
      { id: 'tag_wrong',      name: 'wrong',      color: '#f87171', builtIn: true, role: 'wrong',      desc: '測驗答錯時自動貼上此標籤' },
      { id: 'tag_leech-flip',  name: 'leech-flip',  color: '#f87171', builtIn: true, role: 'leech-flip',  desc: '翻卡學習超過水蛭門檻時自動貼上' },
      { id: 'tag_leech-mc',    name: 'leech-mc',    color: '#fb9d52', builtIn: true, role: 'leech-mc',    desc: '多選學習超過水蛭門檻時自動貼上' },
      { id: 'tag_leech-spell', name: 'leech-spell', color: '#a78bfa', builtIn: true, role: 'leech-spell', desc: '拼字學習超過水蛭門檻時自動貼上' },
    ],
    tags: [],             // [{ id, name, color }] — user-created tags only
    tagConfig: {},        // { tagName: hexColor } — deprecated, kept for migration
    dayCutoff: 0,
    newRatedToday: 0,
    newRatedTodayMc: 0,
    newRatedTodaySpell: 0,
    ttsSpeed: 0.9,        // speech rate multiplier (0.5 = slow, 2.0 = fast)
    ttsVoice: 'en_US-ryan-high',
    ttsPitch: 50,         // espeak-ng pitch 0..99 (50 = default)
    themeMode: 'dark',    // 'dark' | 'light' (theme-d)
    themeAccent: 'skyBlue',  // accent preset name
    themeAccentIntensity: 0.5,  // 0..1, accent overlay opacity strength
    launcherIcon: 'original',  // Android dynamic launcher icon key
    dueCards: [],
    dueCount: 0,
    dueCountMc: 0,
    dueCountSpell: 0,
    stats: { total: 0, learned: 0, new: 0, due: 0, mature: 0, young: 0, avgDifficulty: 0 },
    retention: { rate: 0, total: 0, correct: 0 },
    // UI state
    currentPage: 'dashboard',
    pageHistory: [],         // Android back 用的 view stack（navigate 時 push 前一頁）
    reviewDeckFilter: null,   // deck name to filter review queue, or null for all
    browserDeckFilter: null,  // deck name to filter browser view, set before navigate('browser')
    browserDeckLock: false,   // when true, browser hides deck filter chips & locks to that deck
    filteredDecks: [],        // filtered deck definitions
    activeFilteredDeck: null, // currently active filtered deck id
    examSessions: [],         // saved exam progress sessions (resumable)
    maxExamSessions: 5,       // max number of saved sessions
    colorPalette: null,        // custom color palette array, null = use defaults
    backgroundTasks: [],       // [{ id, label, done, total, status: 'running'|'done'|'failed', error? }]
  };

  function notify() {
    for (const fn of listeners) { try { fn(state); } catch (e) { console.warn('[store] notify listener error:', e); } }
  }

  /** 學習數據分離：依 mode 取 bury/suspend 的 state key 與 cardMap（flip/mc/spell 各自獨立） */
  function modeKey(kind, mode) {
    const isMc = mode === 'mc';
    const isSpell = mode === 'spell';
    return {
      stateKey: kind + (isMc ? 'Mc' : isSpell ? 'Spell' : ''),
      atKey: kind + 'At' + (isMc ? 'Mc' : isSpell ? 'Spell' : ''),   // A5: 'buried'→'buriedAt'/'buriedAtMc'/'buriedAtSpell'
      cardMap: isMc ? state.cardsMc : isSpell ? state.cardsSpell : state.cards,
    };
  }

  /** A5: 各 mode 的 timezoneOffset（flip 用 ankiSettings；mc/spell 各自設定，缺省回退 flip） */
  function modeTz(mode) {
    const flipTz = state.ankiSettings?.timezoneOffset;
    return mode === 'mc' ? state.ankiSettingsMc?.timezoneOffset ?? flipTz
         : mode === 'spell' ? state.ankiSettingsSpell?.timezoneOffset ?? flipTz
         : flipTz;
  }

  /** A5: mc/spell saveCard 承接 container 的 mcData/spellData（rateCard :662-667 pattern —
   *  cardMap 值是展開副本，直接 saveCard 會把 mc_data/spell_data 寫 NULL 抹掉） */
  async function saveModeCard(wordId, mode, card) {
    if (mode === 'flip') {
      try { await db.saveCard(wordId, card); } catch (e) { console.warn('[store] saveModeCard saveCard error:', e); }
      return;
    }
    const dataKey = mode === 'mc' ? 'mcData' : 'spellData';
    const container = state.cards.get(wordId);
    const base = container
      ? { ...container, [dataKey]: { ...(container[dataKey] || {}), ...card } }
      : { due: '', stability: 0, difficulty: 5, elapsedDays: 0, scheduledDays: 0,
          reps: 0, lapses: 0, state: 0, step: 0, lastReview: null,
          buried: false, suspended: false, interval: 0, [dataKey]: { ...card } };
    try { await db.saveCard(wordId, base); } catch (e) { console.warn('[store] saveModeCard saveCard error:', e); }
  }

  /** A5: 老資料 migration — 在 buried Set 但 buriedAt 無記錄的卡補寫 today（明天日界線後解除，Anki next-day 語意） */
  async function migrateBuriedAt() {
    const { getToday } = requireScheduler();
    for (const mode of ['flip', 'mc', 'spell']) {
      const { stateKey, atKey } = modeKey('buried', mode);
      const at = state[atKey];
      if (!at) continue;
      const today = getToday(state.dayCutoff, modeTz(mode));
      let changed = false;
      for (const wordId of state[stateKey]) {
        if (at[wordId] == null) { at[wordId] = today; changed = true; }
      }
      if (changed) {
        try { await db.setSetting(atKey, at); } catch (e) { console.warn('[store] migrateBuriedAt setSetting:', e); }
      }
    }
  }

  let _lastUnburyCheckDay = null;   // A5: 每日一次 guard（掃描成功後才設；失敗當天可重試）

  /** A5: 每日自動解除 — buriedAt < 當日（跨過 dayCutoff 日界線）的卡從 buried/buriedAt 原地移除 + DB 同步。
   *  now 參數僅供測試/跨日模擬（getToday 既有支援），production 不傳。 */
  async function autoUnburyIfNewDay(now) {
    const { getToday } = requireScheduler();
    const today = getToday(state.dayCutoff, modeTz('flip'), now);
    if (_lastUnburyCheckDay === today) return;
    try {
      for (const mode of ['flip', 'mc', 'spell']) {
        const { stateKey, cardMap, atKey } = modeKey('buried', mode);
        const at = state[atKey];
        if (!at) continue;
        const modeToday = getToday(state.dayCutoff, modeTz(mode), now);
        for (const [wordId, dayStr] of Object.entries(at)) {
          if (dayStr < modeToday) {
            state[stateKey].delete(wordId);          // 原地 delete 保住 session Set 引用
            delete at[wordId];
            const card = cardMap.get(wordId);
            if (card) {
              card.buried = false;
              await saveModeCard(wordId, mode, card);
            }
          }
        }
        try {
          await db.setSetting(stateKey, [...state[stateKey]]);
          await db.setSetting(atKey, at);
        } catch (e) { console.warn('[store] autoUnbury setSetting:', e); }
      }
      _lastUnburyCheckDay = today;   // 掃描成功後才設 guard
    } catch (e) { console.warn('[store] autoUnbury error:', e); }
  }

  /** Load all data from DB and populate the store. */
  async function loadAll() {
    const [words, cards, decks, folders, settings, additions, reviewLog, examHistory, goalStreak, filteredDecks] =
      await Promise.all([
        db.getAllWords().catch(e => { console.warn('[store] load words failed:', e); return []; }),
        db.getAllCards().catch(e => { console.warn('[store] load cards failed:', e); return []; }),
        db.getAllDecks().catch(e => { console.warn('[store] load decks failed:', e); return []; }),
        db.getAllFolders().catch(e => { console.warn('[store] load folders failed:', e); return []; }),
        (async () => {
          const s = {
            ankiSettings: await db.getSetting('ankiSettings'),
            ankiSettingsMc: await db.getSetting('ankiSettingsMc'),
            ankiSettingsSpell: await db.getSetting('ankiSettingsSpell'),
            simParams: await db.getSetting('simParams'),
            buried: await db.getSetting('buried'),
            suspended: await db.getSetting('suspended'),
            buriedMc: await db.getSetting('buriedMc'),
            suspendedMc: await db.getSetting('suspendedMc'),
            buriedSpell: await db.getSetting('buriedSpell'),
            suspendedSpell: await db.getSetting('suspendedSpell'),
            buriedAt: await db.getSetting('buriedAt'),          // A5: 平行日期字串
            buriedAtMc: await db.getSetting('buriedAtMc'),
            buriedAtSpell: await db.getSetting('buriedAtSpell'),
            examples: await db.getSetting('examples'),
            edits: await db.getSetting('edits'),
            tags: await db.getAllTags(),
            tagConfig: await db.getSetting('tagConfig'),
            dayCutoff: await db.getSetting('dayCutoff'),
            ttsSpeed: await db.getSetting('ttsSpeed'),
            ttsVoice: await db.getSetting('ttsVoice'),
            ttsPitch: await db.getSetting('ttsPitch'),
            themeMode: await db.getSetting('themeMode'),
            themeAccent: await db.getSetting('themeAccent'),
            launcherIcon: await db.getSetting('launcherIcon'),
            examSessions: await db.getSetting('examSessions'),
            maxExamSessions: await db.getSetting('maxExamSessions'),
            deckOrder: await db.getSetting('deckOrder'),
            exampleDisplayMax: await db.getSetting('exampleDisplayMax'),
            colorPalette: await db.getSetting('colorPalette'),
            logRetentionDays: await db.getSetting('logRetentionDays'),
            devMode: await db.getSetting('devMode'),
            blacklist: await db.getSetting('blacklist'),
            ocrCambridgeVerify: await db.getSetting('ocrCambridgeVerify'),
          };
          // Android：以系統實際 enabled 的 alias 為準（DB 可能因 crash 沒寫到）
          try {
            const { getLauncherIcon } = await import('../lib/api.js');
            const real = await getLauncherIcon();
            if (real) {
              s.launcherIcon = real;
              await db.setSetting('launcherIcon', real);
            }
          } catch { /* 非 Android 或 plugin 未註冊：保持 DB 值 */ }
          return s;
        })(),
        db.getAllAdditions(),
        db.getAllReviewLogs(),
        db.getAllExamHistory(),
        db.getGoalStreak(),
        db.getAllFilteredDecks(),
      ]);

    state.words = words;
    state.cards = cards;
    // Build per-mode card maps from mcData/spellData
    state.cardsMc = new Map();
    state.cardsSpell = new Map();
    for (const [wid, c] of cards) {
      if (c.mcData) state.cardsMc.set(wid, { ...c.mcData });
      if (c.spellData) state.cardsSpell.set(wid, { ...c.spellData });
    }
    // Remove container-only cards from flip mode map:
    // cards created solely as a DB container for mcData/spellData (never reviewed in flip mode)
    for (const [wid, c] of state.cards) {
      if (c.reps === 0 && c.lapses === 0 && c.state === 0 && !c.lastReview && (c.mcData || c.spellData)) {
        state.cards.delete(wid);
      }
    }
    state.decks = decks;
    // Apply saved deck order
    const deckOrder = settings.deckOrder;
    if (Array.isArray(deckOrder) && deckOrder.length > 0) {
      const orderMap = new Map(deckOrder.map((id, i) => [id, i]));
      state.decks.sort((a, b) => (orderMap.get(a.id) ?? Infinity) - (orderMap.get(b.id) ?? Infinity));
    }
    state.folders = folders;
    state.additions = additions;
    state.reviewLog = reviewLog;
    state.examHistory = examHistory;
    state.goalStreak = goalStreak;
    state.filteredDecks = filteredDecks;
    state.buried = new Set(settings.buried || []);
    state.suspended = new Set(settings.suspended || []);
    state.buriedMc = new Set(settings.buriedMc || []);
    state.suspendedMc = new Set(settings.suspendedMc || []);
    state.buriedSpell = new Set(settings.buriedSpell || []);
    state.suspendedSpell = new Set(settings.suspendedSpell || []);
    // A5: 平行日期字串載入（防禦：舊資料若是 array/null 一律歸 {}）
    state.buriedAt = settings.buriedAt && typeof settings.buriedAt === 'object' && !Array.isArray(settings.buriedAt) ? settings.buriedAt : {};
    state.buriedAtMc = settings.buriedAtMc && typeof settings.buriedAtMc === 'object' && !Array.isArray(settings.buriedAtMc) ? settings.buriedAtMc : {};
    state.buriedAtSpell = settings.buriedAtSpell && typeof settings.buriedAtSpell === 'object' && !Array.isArray(settings.buriedAtSpell) ? settings.buriedAtSpell : {};
    state.examples = new Map(settings.examples || []);
    state.ankiSettings = settings.ankiSettings ? { ...DEFAULT_ANKI, ...settings.ankiSettings } : { ...DEFAULT_ANKI };
    // Auto-detect timezone offset if not set
    if (state.ankiSettings.timezoneOffset == null) {
      state.ankiSettings.timezoneOffset = -new Date().getTimezoneOffset();
    }
    state.ankiSettingsMc = settings.ankiSettingsMc ? { ...DEFAULT_ANKI, ...settings.ankiSettingsMc } : { ...DEFAULT_ANKI };
    if (state.ankiSettingsMc.timezoneOffset == null) {
      state.ankiSettingsMc.timezoneOffset = -new Date().getTimezoneOffset();
    }
    state.ankiSettingsSpell = settings.ankiSettingsSpell ? { ...DEFAULT_ANKI, ...settings.ankiSettingsSpell } : { ...DEFAULT_ANKI };
    if (state.ankiSettingsSpell.timezoneOffset == null) {
      state.ankiSettingsSpell.timezoneOffset = -new Date().getTimezoneOffset();
    }
    state.simParams = settings.simParams ? { ...DEFAULT_SIM, ...settings.simParams } : { ...DEFAULT_SIM };
    state.examSessions = Array.isArray(settings.examSessions) ? settings.examSessions : [];
    state.maxExamSessions = parseInt(settings.maxExamSessions) || 5;
    state.launcherIcon = settings.launcherIcon || 'original'; // Android dynamic launcher icon key
    // ── System tags: always seeded; load persisted name/color overrides ──
    const savedSystem = await db.getSetting('systemTags');
    if (Array.isArray(savedSystem) && savedSystem.length > 0) {
      for (const st of state.systemTags) {
        const saved = savedSystem.find(s => s.id === st.id);
        if (saved) { st.name = saved.name || st.name; st.color = saved.color || st.color; st.desc = saved.desc || st.desc; }
      }
    }
    // ── User tags: load from DB; always strip any that belong to system tags ──
    let userTags = settings.tags;
    if (!Array.isArray(userTags)) userTags = [];
    if (userTags.length === 0) {
      const oldConfig = settings.tagConfig && typeof settings.tagConfig === 'object' ? settings.tagConfig : {};
      userTags = Object.entries(oldConfig).map(([name, color]) => ({
        id: 'tag_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        name,
        color: color || '#a78bfa',
      }));
      if (userTags.length > 0) db.setAllTags(userTags).catch(() => {});
    }
    // Unconditional filter: remove any tag that belongs to a known system tag
    const sysIds = new Set(state.systemTags.map(t => t.id));
    const sysNames = new Set(state.systemTags.map(t => t.name));
    const sysRoles = new Set(state.systemTags.map(t => t.role));
    const filtered = userTags.filter(t =>
      !t.builtIn && !sysIds.has(t.id) && !sysNames.has(t.name) && !sysRoles.has(t.name)
    );
    if (filtered.length !== userTags.length) {
      userTags = filtered;
      db.setAllTags(userTags).catch(() => {});
    }
    state.tags = userTags;
    // Build tagConfig from system + user tags for backward compat
    state.tagConfig = {};
    for (const t of state.systemTags) {
      state.tagConfig[t.name] = t.color;
      if (t.role && t.role !== t.name) state.tagConfig[t.role] = t.color;
    }
    for (const t of state.tags) state.tagConfig[t.name] = t.color;
    state.dayCutoff = typeof settings.dayCutoff === 'number' ? settings.dayCutoff : 0;
    state.ttsSpeed = typeof settings.ttsSpeed === 'number' ? settings.ttsSpeed : 0.9;
    state.ttsVoice = typeof settings.ttsVoice === 'string' ? settings.ttsVoice : 'en_US-ryan-high';
    state.ttsPitch = typeof settings.ttsPitch === 'number' ? settings.ttsPitch : 50;
    state.themeMode = settings.themeMode === 'light' ? 'light' : 'dark';
    state.themeAccent = typeof settings.themeAccent === 'string' ? settings.themeAccent : 'skyBlue';
    state.themeAccentIntensity = typeof settings.themeAccentIntensity === 'number' ? settings.themeAccentIntensity : 0.5;
    window.__maxExampleLines = Math.max(0, parseInt(settings.exampleDisplayMax, 10) || 0);
    // ── 操作日誌: 保留天數 (0 = 不記錄, 預設 14) ──
    const logDays = parseInt(settings.logRetentionDays, 10);
    state.logRetentionDays = Number.isFinite(logDays) && logDays >= 0 ? logDays : 14;
    state.devMode = !!settings.devMode;
    // 黑名單：預設 ⊎ db 自訂（小寫去重）。null → 全預設。
    state.blacklist = Array.from(new Set([
      ...DEFAULT_BLACKLIST,
      ...(Array.isArray(settings.blacklist) ? settings.blacklist.map(normalizeBlackWord).filter(Boolean) : []),
    ])).map(normalizeBlackWord);
    // 灰名單：純使用者自訂（無預設），小寫去重
    state.graylist = Array.from(new Set(
      (Array.isArray(settings.graylist) ? settings.graylist.map(normalizeBlackWord) : [])
    )).map(normalizeBlackWord);
    state.ocrMode = (typeof settings.ocrMode === 'string' && ['scan', 'highlight'].includes(settings.ocrMode)) ? settings.ocrMode : 'scan';
    state.ocrRestoreModel = typeof settings.ocrRestoreModel === 'string' ? settings.ocrRestoreModel : '';
    state.ocrCambridgeVerify = typeof settings.ocrCambridgeVerify === 'boolean'
      ? settings.ocrCambridgeVerify : true;
    try {
      const { initAppLog } = await import('./app-log.js');
      initAppLog(state.logRetentionDays);
    } catch (e) { console.warn('[store] initAppLog 失敗:', e); }
    await migrateBuriedAt();      // A5: 老埋卡補 today（buried Set 有、buriedAt 無記錄的舊資料）
    await autoUnburyIfNewDay();   // A5: 啟動即檢查跨日解除（guard 一天一次）
    await refreshDerived();
    state.ready = true;
    notify();
  }

  function computeCombinedStats(words, cardsFlip, cardsMc, cardsSpell, buried, suspended, buriedMc, suspendedMc, buriedSpell, suspendedSpell, newPerDay, dayCutoff, timezoneOffset, ratedNewToday, mcNewPerDay, spellNewPerDay, mcRatedNewToday, spellRatedNewToday) {
    const { getToday, toLocalDateStr } = requireScheduler();
    const today = getToday(dayCutoff, timezoneOffset);
    let learned = 0, due = 0, mature = 0, young = 0;
    let diffSum = 0, diffCount = 0;
    let newCount = 0;
    for (const word of words) {
      // 學習數據分離：各模式獨立 bury/suspend — 三模式全部被隱藏才從合計統計排除
      const hiddenAll = (buried.has(word.id) || suspended.has(word.id))
        && (buriedMc.has(word.id) || suspendedMc.has(word.id))
        && (buriedSpell.has(word.id) || suspendedSpell.has(word.id));
      if (hiddenAll) continue;
      const cFlip = cardsFlip.get(word.id);
      const cMc = cardsMc.get(word.id);
      const cSpell = cardsSpell.get(word.id);
      const hasAny = cFlip || cMc || cSpell;
      if (!hasAny) { newCount++; continue; }
      learned++;
      for (const card of [cFlip, cMc, cSpell]) {
        if (!card || !card.due || card.state === 0) continue;
        if (toLocalDateStr(new Date(card.due), timezoneOffset, dayCutoff) <= today) { due++; break; }
      }
      let matureFound = false, youngFound = false;
      for (const card of [cFlip, cMc, cSpell]) {
        if (!card) continue;
        const ivl = card.scheduledDays ?? card.interval ?? 0;
        if (card.state === STATE_REVIEW && ivl >= 21) { matureFound = true; }
        else if (card.state >= 1) { youngFound = true; }
      }
      if (matureFound) mature++;
      else if (youngFound) young++;
      const best = cFlip || cMc || cSpell;
      if (best && best.difficulty != null) { diffSum += best.difficulty; diffCount++; }
    }
    due += Math.max(0, Math.min(newCount,
      (newPerDay - (ratedNewToday || 0)) +
      ((mcNewPerDay ?? newPerDay) - (mcRatedNewToday || 0)) +
      ((spellNewPerDay ?? newPerDay) - (spellRatedNewToday || 0))
    ));
    return {
      total: words.length, learned, new: words.length - learned,
      due, mature, young,
      avgDifficulty: diffCount > 0 ? diffSum / diffCount : 0,
    };
  }

  /** Recompute derived state (due cards, stats, retention). */
  async function refreshDerived() {
    await autoUnburyIfNewDay();   // A5: 當天第一次任何操作觸發跨日解除（guard 擋重複）
    const { getDueCards, computeRetention, getToday } = requireScheduler();
    const tzOffset = state.ankiSettings?.timezoneOffset;
    const today = getToday(state.dayCutoff, tzOffset);
    const cutoff = state.dayCutoff;
    // G7: one GROUP BY round-trip replaces three per-mode COUNT queries
    const ratedAll = await db.getNewRatedTodayAll(today, cutoff, tzOffset);
    state.newRatedToday = ratedAll.flip;
    state.newRatedTodayMc = ratedAll.mc;
    state.newRatedTodaySpell = ratedAll.spell;
    const due = getDueCards(
      state.words, state.cards, state.buried, state.suspended,
      state.ankiSettings.cardsPerDay, state.dayCutoff, tzOffset, state.newRatedToday,
      null, state.simParams?.maxReviewsPerDay ?? 0
    );
    state.dueCards = due.due;
    state.dueCount = due.due.length;
    // G7: mc/spell badges only need counts → countsOnly skips word spreads
    const dueMc = getDueCards(
      state.words, state.cardsMc, state.buriedMc, state.suspendedMc,
      state.ankiSettingsMc.cardsPerDay, state.dayCutoff, state.ankiSettingsMc?.timezoneOffset ?? tzOffset, state.newRatedTodayMc,
      null, state.simParamsMc?.maxReviewsPerDay ?? state.simParams?.maxReviewsPerDay ?? 0, true
    );
    state.dueCountMc = dueMc.count;
    const dueSpell = getDueCards(
      state.words, state.cardsSpell, state.buriedSpell, state.suspendedSpell,
      state.ankiSettingsSpell.cardsPerDay, state.dayCutoff, state.ankiSettingsSpell?.timezoneOffset ?? tzOffset, state.newRatedTodaySpell,
      null, state.simParamsSpell?.maxReviewsPerDay ?? state.simParams?.maxReviewsPerDay ?? 0, true
    );
    state.dueCountSpell = dueSpell.count;
    state.stats = computeCombinedStats(state.words, state.cards, state.cardsMc, state.cardsSpell, state.buried, state.suspended, state.buriedMc, state.suspendedMc, state.buriedSpell, state.suspendedSpell, state.ankiSettings.cardsPerDay, state.dayCutoff, tzOffset, state.newRatedToday, state.ankiSettingsMc.cardsPerDay, state.ankiSettingsSpell.cardsPerDay, state.newRatedTodayMc, state.newRatedTodaySpell);
    state.retention = computeRetention(state.reviewLog);
  }

  // Lazy import to avoid circular deps at module level
  let _schedulerExports = null;
  let _simulatorExports = null;
  let _filterEngineExports = null;
  function requireScheduler() {
    if (!_schedulerExports) throw new Error('Scheduler not loaded yet');
    return _schedulerExports;
  }
  function requireSimulator() {
    if (!_simulatorExports) throw new Error('Simulator not loaded yet');
    return _simulatorExports;
  }
  function requireFilterEngine() {
    if (!_filterEngineExports) throw new Error('Filter engine not loaded yet');
    return _filterEngineExports;
  }
  async function loadScheduler() {
    _schedulerExports = await import('../core/scheduler.js');
  }
  async function loadSimulator() {
    _simulatorExports = await import('../core/simulator.js');
  }
  async function loadFilterEngine() {
    _filterEngineExports = await import('../core/filterEngine.js');
  }

  function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

/** Persist current deck order to settings. */
  async function saveDeckOrder() {
    try {
      await db.setSetting('deckOrder', state.decks.map(d => d.id));
    } catch (e) { console.warn('[store] saveDeckOrder error:', e); }
  }

  /** Actions — the only way to mutate state. */
  /** BH-02/03: 把指定單字從 memory 端所有掛載結構抹除（reviewLog/examHistory/六 Set/三 buriedAt/examples）。
   *  DB 端已由 db.deleteWord / deleteWordsByDeck 清乾淨，此處同步 memory 防分歧（保留率等 stats 不吃已刪字）。 */
  function deleteWordFromMemory(id) {
    state.reviewLog = state.reviewLog.filter(l => l.wordId !== id);
    state.examHistory = state.examHistory.filter(x => x.word !== id);   // exam_history.word 語意已統一為 word_id（B4）
    for (const k of ['buried', 'suspended', 'buriedMc', 'suspendedMc', 'buriedSpell', 'suspendedSpell']) state[k].delete(id);
    for (const k of ['buriedAt', 'buriedAtMc', 'buriedAtSpell']) if (state[k]) delete state[k][id];
    state.examples.delete(id);
  }

  const actions = {
    /** Initialize: connect DB, load everything */
    async init() {
      try {
        await Promise.all([loadScheduler(), loadSimulator(), loadFilterEngine()]);
        await db.initDB();
        await this.seedIfEmpty();
        await loadAll();

        // Restore human-data backup from DB to localStorage after DB import
        try {
          const ev = await db.getSetting('_backup_humanEvents');
          if (ev && !localStorage.getItem('humanEvents')) {
            localStorage.setItem('humanEvents', ev);
            await db.setSetting('_backup_humanEvents', null);
          }
          const pf = await db.getSetting('_backup_humanProfile');
          if (pf && !localStorage.getItem('humanProfile')) {
            localStorage.setItem('humanProfile', pf);
            await db.setSetting('_backup_humanProfile', null);
          }
        } catch (_) { /* silently */ }

        startAutoBackup();
      } catch (e) {
        console.error('[store] init error:', e);
        state.ready = true;  // still mark ready so UI renders
        notify();
      }
    },

    /** Seed DB with CSV data if empty */
    async seedIfEmpty() {
      if (localStorage.getItem('teno_no_seed') === '1') return;
      let count;
      try {
        count = await db.getWordCount();
      } catch (e) {
        console.warn('[store] seedIfEmpty getWordCount error:', e);
        return;
      }
      if (count > 0) return;

      try {
        const resp = await fetch('/seed-data.csv');
        if (!resp.ok) return;
        const text = await resp.text();
        const { parseCSV } = await import('../core/import.js');
        const parsed = parseCSV(text);
        if (parsed.length === 0) return;

        const words = parsed.map((w, i) => ({
          id: 'seed_' + (i + 1),
          word: w.word,
          definition: w.definition || '',
          pos: w.pos || '',
          pron: w.pron || '',
          example: w.example || '',
          deck: w.deck || 'Default',
          tags: w.tags || [],
          image: w.image || '',
          description: w.description || '',
          related: w.related || [],
          forms: w.forms || [],
          synonym: w.synonym || '',
          antonym: w.antonym || '',
          derivative: w.derivative || '',
          examples: w.examples || [],
          createdAt: new Date().toISOString(),
        }));
        await db.bulkSaveWords(words);

        // Derive decks from unique deck names so the dashboard has something to show.
        const palette = ['#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#fb7185', '#fb923c', '#f0ecf5'];
        const deckNames = [...new Set(words.map(w => w.deck || 'Default'))];
        for (let i = 0; i < deckNames.length; i++) {
          const name = deckNames[i];
          const id = 'deck_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_');
          await db.saveDeck({ id, name, color: palette[i % palette.length] });
        }

        console.log(`[seed] Imported ${words.length} words across ${deckNames.length} decks`);
      } catch (e) {
        console.warn('[seed] Error:', e);
      }
    },

    /** Rate a card during review */
    async rateCard(wordId, rating, duration, mode = 'flip') {
      const { computeFutureDueCounts, getToday, toLocalDateStr, isLeech, computeDueIso } = requireScheduler();
      const now = new Date().toISOString();
      // A9: 無上限截斷 bug — duration 單位為 ms（呼叫端 Date.now()-shownAt）；
      // 對齊 Anki cap_answer_time_to_secs（預設 60s → 60_000ms），超 cap 截斷防
      // 單筆 outlier 扭曲 FSRS 優化。負值/非數字維持既有防護 → null。
      const durationMs = (typeof duration === 'number' && duration >= 0) ? Math.min(Math.round(duration), CAP_ANSWER_TIME_MS) : null;

      const word = state.words.find(w => w.id === wordId);
      if (!word) return;

      // Select the right card map and settings for this mode
      const cardMap = mode === 'mc' ? state.cardsMc : mode === 'spell' ? state.cardsSpell : state.cards;
      const ankiCfg = mode === 'mc' ? state.ankiSettingsMc : mode === 'spell' ? state.ankiSettingsSpell : state.ankiSettings;
      const fsrs = new FSRS(
        ankiCfg.fsrsWeights ? (() => { try { const w = ankiCfg.fsrsWeights.replace(/^\[|\]$/g, '').trim(); return w ? JSON.parse('[' + w + ']') : null; } catch { return null; } })() : null,
        Math.max(0.7, Math.min(0.99, ankiCfg.desiredRetention ?? 0.9)),
        true,
        Math.max(1, ankiCfg.maxIvl ?? 365)
      );

      let card = cardMap.get(wordId);
      // Save snapshot for undo (before any mutation) — CLI 同款完整快照機制
      // C1: 多槽快照 — 依 mode 選槽（_undoSnapshots[mode]），每槽只存自己 mode 的計數器與 log baseline
      const baseCardForSnapshot = state.cards.get(wordId);
      let maxLogId = 0;
      try { maxLogId = await db.getMaxReviewLogId(); } catch (e) { console.warn('[store] getMaxReviewLogId error:', e); }
      (state._undoSnapshots ||= {})[mode] = {
        wordId, mode,
        logId: maxLogId,
        // 該 mode 在 memory reviewLog 的 entry 數（baseline）— undo 只把該 mode 還原到此數
        modeLogCount: state.reviewLog.filter(l => (l.mode || 'flip') === mode).length,
        // 只存自己 mode 的計數器（v3 定案：flip→newRatedToday、mc→newRatedTodayMc、spell→newRatedTodaySpell）
        ratedToday: mode === 'mc' ? state.newRatedTodayMc
          : mode === 'spell' ? state.newRatedTodaySpell
          : state.newRatedToday,
        hadCard: !!card,
        prevCard: card ? { ...card } : null,
        hadBaseCard: !!baseCardForSnapshot,
        // C2: 任何模式（含 flip）都捕獲 cardsMc/cardsSpell — flip undo 也具備「該卡為他 mode 資料載體」的快照依據
        prevBaseCardMcData: state.cardsMc.get(wordId) ? { ...state.cardsMc.get(wordId) } : null,
        prevBaseCardSpellData: state.cardsSpell.get(wordId) ? { ...state.cardsSpell.get(wordId) } : null,
        // 該 mode 的 leech tag 是否存在 — undo 只增刪自己的 'leech-<mode>' tag（不整陣列覆蓋）
        leechTagBefore: !!word.tags?.includes('leech-' + mode),
        // goal 每日進度：評分時 incrementGoal 會 push today + 更新 current/best
        goalStreakBefore: JSON.parse(JSON.stringify(state.goalStreak)),
      };
      const lastTs = card?.lastReview ? new Date(card.lastReview).getTime() : null;
      const todayStr = getToday(state.dayCutoff, ankiCfg?.timezoneOffset);
      const lastDay = lastTs != null ? toLocalDateStr(new Date(lastTs), ankiCfg?.timezoneOffset, state.dayCutoff) : null;
      const elapsed = lastDay != null ? daysBetween(lastDay, todayStr) : 0;

      const currentState = card ? {
        stability: card.stability ?? 0,
        difficulty: card.difficulty ?? 5,
        state: card.state ?? STATE_NEW,
        reps: card.reps ?? 0,
        lapses: card.lapses ?? 0,
        step: card.step ?? 0,
        elapsedDays: elapsed,
        scheduledDays: card.scheduledDays ?? 0,
      } : {
        stability: 0,
        difficulty: 5,
        state: STATE_NEW,
        reps: 0,
        lapses: 0,
        step: 0,
        elapsedDays: 0,
        scheduledDays: 0,
      };

      const fuzzFactor = generateFuzzFactor(wordId + '_' + mode, currentState.reps);
      
      const learnSteps = parseStepsStr(ankiCfg.learnSteps, '1,10');
      const relearnSteps = parseStepsStr(ankiCfg.relearnSteps, '10');
      
      let futureCounts = null;
      if (currentState.state === STATE_REVIEW || currentState.state === STATE_RELEARNING) {
        futureCounts = computeFutureDueCounts(cardMap, 90, state.dayCutoff, ankiCfg?.timezoneOffset);
      }
      
      const result = fsrs.review(currentState, rating, fuzzFactor, learnSteps, relearnSteps, futureCounts);
      console.log('[fsrs]', wordId, mode, 'in_state=', currentState.state, 'in_ivl=', currentState.scheduledDays ?? currentState.interval ?? 0, 'rating=', rating, '-> out_state=', result.state, 'out_ivl=', result.dueDays, 'stability=', result.stability.toFixed(3), 'difficulty=', result.difficulty.toFixed(2), 'lapses=', result.lapses, 'step=', result.step);

      const newCard = {
        // A10: due 錨定 Anki 日界線（next_day_at），非作答時刻 — 23:50/00:10 同日界線
        // 作答得到相同 due；日界線錨定後 due 到期日 == getToday + scheduledDays 恆成立
        // （Anki rslib answering/review.rs:20 due = days_elapsed + scheduled_days）。
        // Review/日級 step → 日界線錨定；sub-day 學習 step → intraday now+step（不變）。
        due: computeDueIso(result.dueDays, result.state, state.dayCutoff, ankiCfg?.timezoneOffset, now),
        stability: result.stability,
        difficulty: result.difficulty,
        elapsedDays: elapsed,
        scheduledDays: result.state === STATE_REVIEW ? Math.round(result.dueDays) : result.dueDays,
        reps: result.reps,
        lapses: result.lapses,
        state: result.state,
        step: result.step ?? 0,
        lastReview: now,
        buried: false,
        suspended: false,
        interval: result.state === STATE_REVIEW ? Math.round(result.dueDays) : result.dueDays,
      };
      console.log('[store.rate]', wordId, mode, 'rating=', rating, '-> state=', result.state, 'dueDays=', result.dueDays, 'due=', newCard.due, 'step=', newCard.step, 'interval=', newCard.interval);

      // Preserve mcData/spellData from old card before overwriting.
      // Fall back to mode-specific maps in case the container card is not in state.cards
      // (e.g. word was first studied in MC/Spell mode and never in flip mode).
      const oldMcData = mode === 'flip'
        ? (cardMap.get(wordId)?.mcData ?? state.cardsMc.get(wordId))
        : null;
      const oldSpellData = mode === 'flip'
        ? (cardMap.get(wordId)?.spellData ?? state.cardsSpell.get(wordId))
        : null;

      // Persist: update the base card's mcData/spellData, then save
      const hadBaseCard = state.cards.has(wordId);

      cardMap.set(wordId, newCard);

      if (oldMcData) newCard.mcData = oldMcData;
      if (oldSpellData) newCard.spellData = oldSpellData;
      const baseCard = hadBaseCard ? state.cards.get(wordId) : {
        due: '', stability: 0, difficulty: 5, elapsedDays: 0, scheduledDays: 0,
        reps: 0, lapses: 0, state: 0, step: 0, lastReview: null,
        buried: false, suspended: false, interval: 0,
        // Preserve data already stored in mode-specific maps (e.g. word was
        // studied in MC then Spell before any flip review).
        mcData: state.cardsMc.get(wordId) || undefined,
        spellData: state.cardsSpell.get(wordId) || undefined,
      };
      if (mode === 'mc') {
        baseCard.mcData = { ...newCard };
        try { await db.saveCard(wordId, baseCard); } catch (e) { console.warn('[store] rateCard saveCard error:', e); }
      } else if (mode === 'spell') {
        baseCard.spellData = { ...newCard };
        try { await db.saveCard(wordId, baseCard); } catch (e) { console.warn('[store] rateCard saveCard error:', e); }
      } else {
        try { await db.saveCard(wordId, newCard); } catch (e) { console.warn('[store] rateCard saveCard error:', e); }
      }
      if (!hadBaseCard && mode === 'flip') state.cards.set(wordId, newCard);

      // ponytail: auto-tag leech on threshold cross, suspension deferred
      const threshold = ankiCfg.leechThreshold || 8;
      if (rating === AGAIN && isLeech(result.lapses, threshold)) {
        const leechTag = 'leech-' + mode;
        if (!word.tags || !word.tags.includes(leechTag)) {
          if (!word.tags) word.tags = [];
          word.tags.push(leechTag);
          try { await db.saveWord(word); } catch (e) { console.warn('[store] leech tag saveWord error:', e); }
        }
      }

      try {
        await db.addReviewLog({
          wordId, rating, duration: durationMs,
          elapsedDays: currentState.elapsedDays,
          scheduledDays: Math.round(result.dueDays),
          stability: result.stability,
          difficulty: result.difficulty,
          mode,
          state: currentState.state,
          newState: result.state,
        });
      } catch (e) {
        console.warn('[store] rateCard addReviewLog error:', e);
      }

      state.reviewLog.push({
        wordId, rating, duration: durationMs,
        elapsedDays: currentState.elapsedDays,
        scheduledDays: Math.round(result.dueDays),
        stability: result.stability,
        difficulty: result.difficulty,
        reviewed_at: now,
        state: currentState.state,
        newState: result.state,
        ivl: Math.round(result.dueDays),
        mode,
      });

      await refreshDerived();
      notify();
    },

    /** Undo the last rating of a given mode, restoring card state and review log（C1: 多槽按 mode 隔離） */
    async undoLastRating(mode = 'flip') {
      const snap = (state._undoSnapshots || {})[mode];
      if (!snap) return;
      // 快照內 mode 為準（與選槽 key 必然一致；防呆）
      const m = snap.mode;

      const { wordId, prevCard, hadCard, prevBaseCardMcData, prevBaseCardSpellData } = snap;
      // C1 合併保護：liveFlipCard 必須在 cardMap 還原之前讀取（flip undo 時 cardMap === state.cards，
      // 還原後讀取會拿到 prevCard 自身 → 保護靜默失效）
      const liveFlipCard = state.cards.get(wordId);
      const cardMap = m === 'mc' ? state.cardsMc : m === 'spell' ? state.cardsSpell : state.cards;

      if (hadCard && prevCard) {
        cardMap.set(wordId, prevCard);
      } else {
        cardMap.delete(wordId);
      }

      if (m !== 'flip') {
        const baseCard = state.cards.get(wordId);
        if (baseCard) {
          if (prevBaseCardMcData) baseCard.mcData = prevBaseCardMcData;
          else delete baseCard.mcData;
          if (prevBaseCardSpellData) baseCard.spellData = prevBaseCardSpellData;
          else delete baseCard.spellData;
          try { await db.saveCard(wordId, baseCard); } catch (e) { console.warn('[store] undo saveCard error:', e); }
        } else if (prevBaseCardMcData || prevBaseCardSpellData) {
          // No flip card, but prior mode-specific data exists — preserve it
          const restore = {
            due: '', stability: 0, difficulty: 5,
            elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0,
            step: 0, lastReview: null, buried: false, suspended: false, interval: 0,
            mcData: prevBaseCardMcData || undefined,
            spellData: prevBaseCardSpellData || undefined,
          };
          try { await db.saveCard(wordId, restore); } catch (e) { console.warn('[store] undo saveCard error:', e); }
        } else {
          try { await db.deleteCard(wordId); } catch (e) { console.warn('[store] undo deleteCard error:', e); }
        }
      } else {
        if (hadCard && prevCard) {
          // C1 合併保護：flip undo 只還原 flip 造成的變化 — 保留現有卡身上的 mcData/spellData（他 mode 評分寫入的資料）
          const merged = { ...prevCard };
          if (liveFlipCard && (liveFlipCard.mcData || liveFlipCard.spellData)) {
            merged.mcData = liveFlipCard.mcData ?? prevCard.mcData;
            merged.spellData = liveFlipCard.spellData ?? prevCard.spellData;
          }
          state.cards.set(wordId, merged);   // memory 同步（防 memory/DB 分歧）
          try { await db.saveCard(wordId, merged); } catch (e) { console.warn('[store] undo saveCard error:', e); }
        } else if (prevBaseCardMcData || prevBaseCardSpellData || (liveFlipCard && (liveFlipCard.mcData || liveFlipCard.spellData))) {
          // C2: 快照捕獲（flip 也捕獲）+ live 雙重判斷 — 該卡為他 mode 資料載體 → restore 承接不刪
          const restore = {
            due: '', stability: 0, difficulty: 5,
            elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0,
            step: 0, lastReview: null, buried: false, suspended: false, interval: 0,
            // live 優先（undo 時刻他 mode 最新值，不回滾他 mode 後續評分）、快照補缺（同源 fallback）
            mcData: liveFlipCard?.mcData ?? prevBaseCardMcData ?? undefined,
            spellData: liveFlipCard?.spellData ?? prevBaseCardSpellData ?? undefined,
          };
          state.cards.set(wordId, restore);   // memory 同步（:728 cardMap.delete 已先行，需補回）
          try { await db.saveCard(wordId, restore); } catch (e) { console.warn('[store] undo saveCard error:', e); }
        } else {
          // C2 (v3 補充)：undo delete 前查 DB — 防 saveCard 失敗的 memory/DB 分歧：
          // memory 無他 mode 資料但 DB 卡帶 mc_data/spell_data → 不整卡刪，restore 承接（DB 資料為準）
          let dbCard = null;
          try { dbCard = await db.getCard(wordId); } catch (e) { console.warn('[store] undo getCard error:', e); }
          if (dbCard && (dbCard.mcData || dbCard.spellData)) {
            const restore = {
              due: '', stability: 0, difficulty: 5,
              elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0,
              step: 0, lastReview: null, buried: false, suspended: false, interval: 0,
              mcData: dbCard.mcData ?? undefined,
              spellData: dbCard.spellData ?? undefined,
            };
            state.cards.set(wordId, restore);   // memory 同步
            try { await db.saveCard(wordId, restore); } catch (e) { console.warn('[store] undo saveCard error:', e); }
          } else {
            try { await db.deleteCard(wordId); } catch (e) { console.warn('[store] undo deleteCard error:', e); }
          }
        }
      }

      // C1: DB log 只刪該 mode（COALESCE(mode,'flip') = 目標 mode — NULL 舊資料視為 flip）
      try { await db.deleteReviewLogsAfter(snap.logId, m); } catch (e) { console.warn('[store] undo deleteReviewLog error:', e); }
      // C1: memory log 只移除該 mode 的 entry 至該模式 baseline（他 mode entry 保留）
      let mcount = state.reviewLog.filter(l => (l.mode || 'flip') === m).length;
      for (let i = state.reviewLog.length - 1; i >= 0 && mcount > (snap.modeLogCount ?? 0); i--) {
        if ((state.reviewLog[i].mode || 'flip') === m) { state.reviewLog.splice(i, 1); mcount--; }
      }
      // C1: 計數器只還原自己 mode（他 mode 計數器不動）
      if (m === 'mc') state.newRatedTodayMc = snap.ratedToday;
      else if (m === 'spell') state.newRatedTodaySpell = snap.ratedToday;
      else state.newRatedToday = snap.ratedToday;

      // C1: leech tag 精準還原 — 只增刪該 mode 的 'leech-<mode>' tag（不整陣列覆蓋，避免誤動他 mode/exam 加的 tag）
      const undoWord = state.words.find(w => w.id === wordId);
      if (undoWord) {
        const tag = 'leech-' + m;
        const has = undoWord.tags?.includes(tag);
        if (snap.leechTagBefore && !has) {
          if (!undoWord.tags) undoWord.tags = [];
          undoWord.tags.push(tag);
        } else if (!snap.leechTagBefore && has) {
          undoWord.tags = undoWord.tags.filter(t => t !== tag);
        }
        try { await db.saveWord(undoWord); } catch (e) { console.warn('[store] undo saveWord error:', e); }
      }

      // C1: goalStreak 只還原該 mode 的 dates 子陣列 + 重算 current/best（不動他 mode 進度）
      if (snap.goalStreakBefore) {
        const gs = state.goalStreak;
        const dates = gs.dates || {};
        const beforeDates = snap.goalStreakBefore.dates?.[m];
        dates[m] = beforeDates ? [...beforeDates] : [];
        const tzOffset = m === 'mc' ? state.ankiSettingsMc?.timezoneOffset
          : m === 'spell' ? state.ankiSettingsSpell?.timezoneOffset
          : state.ankiSettings?.timezoneOffset;
        const { computeStreak, computeBestStreak } = requireScheduler();
        const current = computeStreak(dates[m], state.dayCutoff, tzOffset);
        const best = Math.max(gs.best || 0, computeBestStreak(dates[m], state.dayCutoff, tzOffset));
        state.goalStreak = { ...gs, current, best, dates };
        try { await db.saveGoalStreak(state.goalStreak); } catch (e) { console.warn('[store] undo saveGoalStreak error:', e); }
      }

      delete state._undoSnapshots[m];

      await refreshDerived();
      notify();
    },

    /** Bury a card（mode: flip/mc/spell — 各模式獨立） */
    async bury(wordId, mode = 'flip') {
      const { stateKey, cardMap, atKey } = modeKey('buried', mode);
      const newBuried = new Set(state[stateKey]);
      newBuried.add(wordId);
      state[stateKey] = newBuried;
      // A5: 平行日期字串 — 埋卡日（mode 本地日 + dayCutoff 對齊；午夜/時區無邊界問題）
      (state[atKey] ||= {})[wordId] = requireScheduler().getToday(state.dayCutoff, modeTz(mode));
      // Also mark in DB
      const card = cardMap.get(wordId);
      if (card) {
        card.buried = true;
        await saveModeCard(wordId, mode, card);
      }
      try { await db.setSetting(stateKey, [...newBuried]); } catch (e) { console.warn('[store] bury setSetting error:', e); }
      try { await db.setSetting(atKey, state[atKey]); } catch (e) { console.warn('[store] bury setSetting buriedAt error:', e); }
      await refreshDerived();
      notify();
    },

    /** Suspend a card（mode: flip/mc/spell — 各模式獨立） */
    async suspend(wordId, mode = 'flip') {
      const { stateKey, cardMap } = modeKey('suspended', mode);
      const newSuspended = new Set(state[stateKey]);
      newSuspended.add(wordId);
      state[stateKey] = newSuspended;
      // A5: suspend 隱含 unbury（Anki 語意）— 同步從 buried/buriedAt 移除
      const { stateKey: bKey, atKey } = modeKey('buried', mode);
      if (state[bKey].has(wordId)) {
        state[bKey].delete(wordId);
        const at = state[atKey];
        if (at) delete at[wordId];
        try { await db.setSetting(bKey, [...state[bKey]]); } catch (e) { console.warn('[store] suspend clear buried setSetting error:', e); }
        try { await db.setSetting(atKey, state[atKey] || {}); } catch (e) { console.warn('[store] suspend clear buriedAt setSetting error:', e); }
      }
      const card = cardMap.get(wordId);
      if (card) {
        card.suspended = true;
        card.buried = false;   // A5: suspend 隱含 unbury
        await saveModeCard(wordId, mode, card);
      }
      try { await db.setSetting(stateKey, [...newSuspended]); } catch (e) { console.warn('[store] suspend setSetting error:', e); }
      await refreshDerived();
      notify();
    },

    /** Unbury a card（mode: flip/mc/spell — 各模式獨立） */
    async unbury(wordId, mode = 'flip') {
      const { stateKey, cardMap, atKey } = modeKey('buried', mode);
      const newBuried = new Set(state[stateKey]);
      newBuried.delete(wordId);
      state[stateKey] = newBuried;
      // A5: 平行日期字串同步移除
      const at = state[atKey];
      if (at) delete at[wordId];
      const card = cardMap.get(wordId);
      if (card) {
        card.buried = false;
        await saveModeCard(wordId, mode, card);
      }
      try { await db.setSetting(stateKey, [...newBuried]); } catch (e) { console.warn('[store] unbury setSetting error:', e); }
      try { await db.setSetting(atKey, state[atKey] || {}); } catch (e) { console.warn('[store] unbury setSetting buriedAt error:', e); }
      await refreshDerived();
      notify();
    },

    /** Unsuspend a card（mode: flip/mc/spell — 各模式獨立） */
    async unsuspend(wordId, mode = 'flip') {
      const { stateKey, cardMap } = modeKey('suspended', mode);
      const newSuspended = new Set(state[stateKey]);
      newSuspended.delete(wordId);
      state[stateKey] = newSuspended;
      const card = cardMap.get(wordId);
      if (card) {
        card.suspended = false;
        try { await db.saveCard(wordId, card); } catch (e) { console.warn('[store] unsuspend saveCard error:', e); }
      }
      try { await db.setSetting(stateKey, [...newSuspended]); } catch (e) { console.warn('[store] unsuspend setSetting error:', e); }
      await refreshDerived();
      notify();
    },

    /** Update Anki settings (flip mode) */
    async updateAnkiSettings(settings) {
      state.ankiSettings = { ...state.ankiSettings, ...settings };
      try { await db.setSetting('ankiSettings', state.ankiSettings); } catch (e) { console.warn('[store] updateAnkiSettings setSetting error:', e); }
      await refreshDerived();
      notify();
    },

    /** Update Anki settings (multiple choice mode) */
    async updateAnkiSettingsMc(settings) {
      state.ankiSettingsMc = { ...state.ankiSettingsMc, ...settings };
      try { await db.setSetting('ankiSettingsMc', state.ankiSettingsMc); } catch (e) { console.warn('[store] updateAnkiSettingsMc setSetting error:', e); }
      await refreshDerived();
      notify();
    },

    /** Update Anki settings (spelling mode) */
    async updateAnkiSettingsSpell(settings) {
      state.ankiSettingsSpell = { ...state.ankiSettingsSpell, ...settings };
      try { await db.setSetting('ankiSettingsSpell', state.ankiSettingsSpell); } catch (e) { console.warn('[store] updateAnkiSettingsSpell setSetting error:', e); }
      await refreshDerived();
      notify();
    },

    /** Update sim params */
    async updateSimParams(params) {
      state.simParams = { ...state.simParams, ...params };
      try { await db.setSetting('simParams', state.simParams); } catch (e) { console.warn('[store] updateSimParams setSetting error:', e); }
      notify();
    },

    async updateColorPalette(palette) {
      state.colorPalette = palette;
      try { await db.setSetting('colorPalette', palette); } catch (e) { console.warn('[store] updateColorPalette setSetting error:', e); }
      notify();
    },

    /** 操作日誌保留天數 (0 = 不記錄) */
    async setLogRetention(days) {
      const d = parseInt(days, 10);
      state.logRetentionDays = Number.isFinite(d) && d >= 0 ? d : 0;
      try { await db.setSetting('logRetentionDays', state.logRetentionDays); } catch (e) { console.warn('[store] setLogRetention setSetting error:', e); }
      try {
        const { setLogRetention } = await import('./app-log.js');
        setLogRetention(state.logRetentionDays);
      } catch (e) { console.warn('[store] setLogRetention app-log error:', e); }
      notify();
    },

    /** Update goal streak */
    async updateGoalStreak(data) {
      state.goalStreak = { ...state.goalStreak, ...data };
      state.goalStreak.dates ??= { flip: [], mc: [], spell: [] };
      try { await db.saveGoalStreak(state.goalStreak); } catch (e) { console.warn('[store] updateGoalStreak saveGoalStreak error:', e); }
      await refreshDerived();
      notify();
    },

    /** Increment today's review count（只在 review 時呼叫）。
     *  以 mode 專屬 dates 陣列為真實來源，重算 current 連續天數與 best 紀錄。 */
    async incrementGoal(mode = 'flip') {
      const { getToday } = requireScheduler();
      // G4: 累加生涯總評分數（成就系統讀取；JSON 編碼與讀端對齊、isFinite 防污染、try/catch 隔離無 localStorage）
      try {
        const raw = localStorage.getItem('_totalRated') || '0';
        const rated = Number.parseInt(raw, 10);
        const next = Number.isFinite(rated) ? rated + 1 : 1;
        localStorage.setItem('_totalRated', JSON.stringify(next));
      } catch { /* 無 localStorage（node harness）→ 忽略計數 */ }
      const tzOffset = mode === 'mc' ? state.ankiSettingsMc?.timezoneOffset
        : mode === 'spell' ? state.ankiSettingsSpell?.timezoneOffset
        : state.ankiSettings?.timezoneOffset;
      const today = getToday(state.dayCutoff, tzOffset);
      const dates = state.goalStreak.dates || {};
      if (!dates[mode]) dates[mode] = [];
      if (!dates[mode].includes(today)) dates[mode].push(today);
      const { computeStreak, computeBestStreak } = requireScheduler();
      const current = computeStreak(dates[mode], state.dayCutoff, tzOffset);
      const best = Math.max(state.goalStreak.best || 0, computeBestStreak(dates[mode], state.dayCutoff, tzOffset));
      await this.updateGoalStreak({ current, best, dates });
    },

    /** Navigate to a page */
    navigate(page) {
      const prev = state.currentPage;
      if (prev && prev !== page) {
        const h = state.pageHistory;
        if (h[h.length - 1] !== prev) h.push(prev);
      }
      state.currentPage = page;
      notify();
    },

    /** Android back：回到上一頁；沒有上一頁回 false（呼叫端決定退出） */
    goBack() {
      const prev = state.pageHistory.pop();
      if (prev) {
        state.currentPage = prev;
        notify();
        return true;
      }
      return false;
    },

    /** Set (or toggle off) the deck filter for review and navigate to review */
    setReviewDeckFilter(deckName) {
      // G3：跳 study-v4 前 push 現頁進 pageHistory（同 navigate 語意）——
      // 原直接改 currentPage 不入棧 → Android back 無上一頁可回、直接退出 app
      const prev = state.currentPage;
      if (prev && prev !== 'study-v4') {
        const h = state.pageHistory;
        if (h[h.length - 1] !== prev) h.push(prev);
      }
      state.reviewDeckFilter = state.reviewDeckFilter === deckName ? null : deckName;
      state.currentPage = 'study-v4';
      notify();
    },

    /** Clear the review deck filter */
    clearReviewDeckFilter() {
      state.reviewDeckFilter = null;
      notify();
    },

    /** Start a background task */
    startBackgroundTask(id, label, total) {
      state.backgroundTasks = state.backgroundTasks.filter(t => t.id !== id);
      state.backgroundTasks.push({ id, label, done: 0, total, status: 'running' });
      notify();
    },
    /** Update background task progress */
    updateBackgroundTask(id, done, total) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.done = done; t.total = total; notify(); }
    },
    /** Complete a background task successfully */
    completeBackgroundTask(id, result) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.status = 'done'; t.done = t.total; t.result = result; notify(); }
    },
    /** Mark a background task as failed */
    failBackgroundTask(id, error) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.status = 'failed'; t.error = error; notify(); }
    },
    /** Remove a background task from the list */
    dismissBackgroundTask(id) {
      state.backgroundTasks = state.backgroundTasks.filter(t => t.id !== id);
      notify();
    },

    /** Add a new word */
    async addWord(wordData) {
      const word = {
        id: nextWordId(),
        word: wordData.word.toLowerCase().trim(),
        definition: wordData.definition || '',
        pos: wordData.pos || '',
        pron: wordData.pron || '',
        example: wordData.example || '',
        deck: wordData.deck || 'Default',
        tags: wordData.tags || [],
        image: wordData.image || '',
        description: wordData.description || '',
        related: wordData.related || [],
        forms: wordData.forms || [],
        synonym: wordData.synonym || '',
        antonym: wordData.antonym || '',
        derivative: wordData.derivative || '',
        examples: wordData.examples || [],
        createdAt: new Date().toISOString(),
      };
      state.words.push(word);
      try { await db.saveWord(word); } catch (e) { console.warn('[store] addWord saveWord error:', e); }
      await refreshDerived();
      notify();
      return word;
    },

    /** word 是否在黑名單？ */
    isBlacklisted(word) {
      const w = normalizeBlackWord(word);
      return !!w && state.blacklist.includes(w);
    },

    /** 黑名單管理（devMode UI 用）。回傳當前黑名單。 */
    async addBlacklistWord(word) {
      const w = normalizeBlackWord(word);
      if (!w || state.blacklist.includes(w)) return state.blacklist.slice();
      state.blacklist = [...state.blacklist, w];
      try { await db.setSetting('blacklist', state.blacklist); } catch (e) { console.warn('[store] setBlacklist add error:', e); }
      notify();
      return state.blacklist.slice();
    },
    async removeBlacklistWord(word) {
      const w = normalizeBlackWord(word);
      state.blacklist = state.blacklist.filter(x => x !== w);
      try { await db.setSetting('blacklist', state.blacklist); } catch (e) { console.warn('[store] setBlacklist remove error:', e); }
      notify();
      return state.blacklist.slice();
    },

    /** word 是否在灰名單？ */
    isGraylisted(word) {
      const w = normalizeBlackWord(word);
      return !!w && state.graylist.includes(w);
    },

    /** 灰名單管理（devMode UI + OCR 淘汰用）。回傳當前灰名單。 */
    async addToGraylist(word) {
      const w = normalizeBlackWord(word);
      if (!w || state.graylist.includes(w)) return state.graylist.slice();
      state.graylist = [...state.graylist, w];
      try { await db.setSetting('graylist', state.graylist); } catch (e) { console.warn('[store] setGraylist add error:', e); }
      notify();
      return state.graylist.slice();
    },
    async removeFromGraylist(word) {
      const w = normalizeBlackWord(word);
      state.graylist = state.graylist.filter(x => x !== w);
      try { await db.setSetting('graylist', state.graylist); } catch (e) { console.warn('[store] setGraylist remove error:', e); }
      notify();
      return state.graylist.slice();
    },

    /**
     * 從 CSV 文字匯入灰名單（純單字一行一個，或逗號/雜項分隔都吃）。
     * 回傳 { imported, skipped, total }。
     */
    async importGraylistCsv(text) {
      const words = String(text || '')
        .split(/[\n,;\t]+/)
        .map(x => normalizeBlackWord(x).replace(/^["']|["']$/g, ''))
        .filter(w => w && /^[a-z][a-z'-]{1,30}$/i.test(w));
      let imported = 0, skipped = 0;
      for (const w of words) {
        if (state.graylist.includes(w)) { skipped++; continue; }
        state.graylist = [...state.graylist, w];
        imported++;
      }
      if (imported) { try { await db.setSetting('graylist', state.graylist); } catch (e) { console.warn('[store] setGraylist csv error:', e); } notify(); }
      return { imported, skipped, total: words.length };
    },
    async toggleOcrCambridgeVerify() {
      state.ocrCambridgeVerify = !state.ocrCambridgeVerify;
      try { await db.setSetting('ocrCambridgeVerify', state.ocrCambridgeVerify); } catch (e) { console.warn('[store] toggle verify error:', e); }
      notify();
      return state.ocrCambridgeVerify;
    },

    /**
     * 背景補欄位：對指定的（已入庫）單字查 Cambridge，填齊 pos/pron/
     * definition/examples/example。OCR 錄入後 await 執行（D′：UI 同步看到填好的卡）。
     * @param {string[]} wordIds
     * @param {boolean} [overwrite] - true=覆寫已有 definition/examples；預設 false 保守只填空欄
     * @returns {Promise<number>} 填過的欄位數
     */
    async enrichOcrWords(wordIds, overwrite = false) {
      if (!Array.isArray(wordIds) || wordIds.length === 0) return 0;
      const targets = state.words.filter(w => wordIds.includes(w.id));
      let filled = 0;
      // V2（2026-09-01）：逐字串行 → 分批併發（ENRICH_CONC=5）。
      // 實測：幾百字匯入 = 幾百次串行網路往返 = 數分鐘；併發 5 徑約除以 5。
      // 單字內容處理（state 合併/存檔）保持同步順序，無競態。
      const ENRICH_CONC = 5;
      const queue = [...targets];
      const enrichOne = async (w) => {
        try {
          const { lookupCambridge } = await import('./api.js');
          const raw = await lookupCambridge(w.word, 'en');
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!data || !Array.isArray(data.senses) || data.senses.length === 0) return;   // V2: for-continue → 函式 return
          // 多 sense 合併（D′.2 §3）：不只 senses[0]，把各 sense 的 definition/examples 匯總
          const defs = [];
          const exs = [];
          let pos = '';
          for (const sense of data.senses) {
            if (sense.definition && !defs.includes(sense.definition)) defs.push(sense.definition);
            for (const s of (sense.examples || [])) {
              const t = String(s).trim();
              if (t && !exs.includes(t)) exs.push(t);
            }
            if (!pos && sense.part_of_speech) pos = sense.part_of_speech;
          }
          const updates = {};
          // pos/pron 保守：不覆寫已有（填補空缺）——配合完整單字卡需求
          if (!w.pos && pos) updates.pos = pos;
          if (!w.pron && (data.uk_ipa || data.us_ipa)) updates.pron = [data.uk_ipa, data.us_ipa].filter(Boolean).join(' / ');
          // definition/examples：overwrite 開啟覆寫殘缺；否則只填空欄
          if (overwrite || !w.definition) updates.definition = defs.join('；');
          if ((overwrite || !w.examples || w.examples.length === 0) && exs.length) updates.examples = exs.slice(0, 3);
          if (!w.example && exs[0]) updates.example = exs[0];
          // 例：複合欄位若 sense0 有而合併後空，兜底補
          if (overwrite && !updates.definition && !w.definition && data.senses[0].definition) updates.definition = defs.join('；');
          if (Object.keys(updates).length === 0) return;   // V2: for-continue → 函式 return
          const merged = { ...w, ...updates };
          state.words = state.words.map(x => x.id === w.id ? merged : x);
          try { await db.saveWord(merged); } catch (e) { console.warn('[store] enrich saveWord error:', e); }
          return true;
        } catch (e) { console.warn('[store] enrichOcrWords', w.word, e.message || e); }
        return false;
      };
      const workers = Array.from({ length: Math.min(ENRICH_CONC, queue.length) }, async () => {
        while (queue.length) { const w = queue.shift(); if (await enrichOne(w)) filled++; }
      });
      await Promise.all(workers);
      if (filled) notify();
      return filled;
    },

    /**
     * Bulk import word objects. Skips duplicates (by lowercased word),
     * auto-creates any missing decks, and only notifies once at the end.
     * @param {object[]} words - parsed word objects
     * @param {(p:{done:number,total:number,added:number,skipped:number})=>void} [onProgress]
     * @param {{override?:Set<string>}} [options] - 黑灰 override（一次性授權，列入的字跳過黑灰剔除）
     * @returns {Promise<{added:number,skipped:number,decksCreated:string[],blacklisted:number,addedIds:string[]}>}
     */
    async importWords(words, onProgress, options) {
      const palette = ['#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#fb7185', '#fb923c', '#f0ecf5'];
      const existing = new Set(state.words.map(w => w.word.toLowerCase()));
      const deckByName = new Map(state.decks.map(d => [d.name, d]));
      const decksCreated = [];
      let added = 0, skipped = 0;
      const total = words.length;
      const now = new Date().toISOString();

      const newWords = [];
      let blacklisted = 0;
      const addedIds = [];

      for (let i = 0; i < total; i++) {
        const src = words[i];
        const w = (src.word || '').toLowerCase().trim();
        if (!w) { skipped++; continue; }
        // 黑灰名單擋（is/she/cat/草漯詞…）——options.override 列出者為一次性授權，跳過剔除（C 段）
        const isOverride = options?.override?.has(w);
        if (!isOverride && (state.blacklist.includes(w) || state.graylist.includes(w))) { blacklisted++; continue; }
        if (existing.has(w)) { skipped++; if (onProgress) onProgress({ done: i + 1, total, added, skipped }); continue; }

        // Ensure deck exists
        const deckName = src.deck || 'Default';
        if (!deckByName.has(deckName)) {
          const color = palette[state.decks.length % palette.length];
          const deck = await this.createDeck(deckName, color);
          deckByName.set(deck.name, deck);
          decksCreated.push(deck.name);
        }

        const word = {
          id: nextWordId(),
          word: w,
          definition: src.definition || '',
          pos: src.pos || '',
          pron: src.pron || '',
          example: src.example || '',
          deck: deckName,
          tags: src.tags || [],
          image: src.image || '',
          description: src.description || '',
          related: src.related || [],
          forms: src.forms || [],
          synonym: src.synonym || '',
          antonym: src.antonym || '',
          derivative: src.derivative || '',
          examples: src.examples || [],
          createdAt: now,
        };
        state.words.push(word);
        existing.add(w);
        newWords.push(word);
        added++;
        addedIds.push(word.id);
        if (onProgress && (i % 3 === 0 || i === total - 1)) {
          onProgress({ done: i + 1, total, added, skipped });
        }
      }

      // ponytail: single transaction for bulk insert
      if (newWords.length) {
        let txFailed = false;
        try { await db.executeSQL('BEGIN TRANSACTION'); } catch (_) {}
        try {
          for (const w of newWords) await db.saveWord(w);
          await db.executeSQL('COMMIT');
        } catch (e) {
          await db.executeSQL('ROLLBACK');
          txFailed = true;
          console.warn('[store] importWords bulk insert error:', e);
        }
        if (txFailed) {
          // D15/G4: tx 失敗時，不僅 added 歸零，連 in-memory state.words 也要回滾
          // 這批已 push 的新字（否則 UI 顯示已入庫、DB 其實 0 顆 → 重開即失蹤）。
          const newIds = new Set(newWords.map(w => w.id));
          state.words = state.words.filter(w => !newIds.has(w.id));
          added = 0;
        }
      }

      await refreshDerived();
      notify();
      try { await db.addAudit('import-words', `GUI 匯入 ${added} 詞 (skip ${skipped}, 黑灰 ${blacklisted})`); } catch (_) {}
      return { added, skipped, decksCreated, blacklisted, addedIds };
    },

    /**
     * Import OCR-recognized raw tokens: whitelist-filter (§5), normalize,
     * then route through importWords (dedupe + auto-deck + single tx).
     * @param {string[]} rawWords
     * @param {string} [deckName]
     * @param {{override?:Set<string>}} [options] - 黑灰 override（一次性授權；兩層都要傳避免半路被吃回）
     * @returns {Promise<{added:number,skipped:number,decksCreated:string[],blacklisted:number,notFound:number,cambridgeSkipped:number}>}
     */
    async importOcrText(rawWords, deckName = 'OCR Inbox', options) {
      const valid = rawWords
        .map(w => String(w).toLowerCase().trim())
        .filter(w => /^[a-z][a-z'-]{1,30}$/i.test(w));
      // 黑名單＋灰名單＋重複先同步剔除計數（避免對垃圾/既有字發網路查詢），只有乾淨字走查證＋入庫
      const blSet = new Set([...state.blacklist, ...state.graylist]);
      const existingSet = new Set(state.words.map(x => x.word.toLowerCase()));
      const override = options?.override || new Set();
      let blacklisted = 0, dupSkipped = 0;
      const ok = [];
      for (const w of valid) {
        if (!override.has(w) && blSet.has(w)) { blacklisted++; continue; }
        if (existingSet.has(w)) { dupSkipped++; continue; }
        ok.push(w);
      }
      let notFound = 0;
      let filtered = [];
      if (state.ocrCambridgeVerify && ok.length) {
        // Cambridge 查證開：查得到的才入庫（逐字串行，避免爆連線）
        for (const w of ok) {
          try {
            const { lookupCambridge } = await import('./api.js');
            const raw = await lookupCambridge(w, 'en');
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (data && Array.isArray(data.senses) && data.senses.length > 0) filtered.push(w);
            else notFound++;
          } catch (e) {
            // 查證失敗不擋——離線/斷線時降級為放行（黑名單/重複已擋，不會海量垃圾）
            console.warn('[store] importOcrText cambridge verify err', w, e.message || e);
            filtered.push(w);
          }
        }
      } else {
        filtered = ok;
      }
      const parsed = filtered.map(w => ({ word: w, definition: '', deck: deckName }));
      // 第二道也傳 override——避免 override 字在 importWords 又被黑灰吃回（plan C.6 高風險）
      const res = await this.importWords(parsed, undefined, { override });
      res.blacklisted = (res.blacklisted || 0) + blacklisted;
      res.skipped = (res.skipped || 0) + dupSkipped;
      res.notFound = notFound;
      res.cambridgeSkipped = filtered.length - res.added; // 入庫階段額外排除（重複 race）
      // 補欄位（D′.1：fire-and-forget→await，UI 同步看到填好的卡）。overwrite=true
      // 填齊 OCR 入庫的殘缺欄位（配合完整單字卡需求）；Network 失敗→catch 不卡流程
      // res.enriched = 實際補齊數（離線/查無 sense 時可能 < added，UI 據此不虛報）
      res.enriched = 0;
      if (res.added > 0 && res.addedIds.length) {
        try { res.enriched = await this.enrichOcrWords(res.addedIds, true); } catch (e) { console.warn('[store] importOcrText enrich err', e.message || e); }
      }
      return res;
    },

    /** Edit a word */
    async editWord(id, updates) {
      const idx = state.words.findIndex(w => w.id === id);
      if (idx === -1) return;
      state.words[idx] = { ...state.words[idx], ...updates };
      try { await db.saveWord(state.words[idx]); } catch (e) { console.warn('[store] editWord saveWord error:', e); }
      notify();
    },

    /** Assign / update the color of a tag (persisted in settings). */
    async setTagColor(tag, color) {
      const name = String(tag || '').trim();
      if (!name) return;
      state.tagConfig = { ...state.tagConfig, [name]: color || null };
      try { await db.setSetting('tagConfig', state.tagConfig); } catch (e) { console.warn('[store] setTagColor setSetting error:', e); }
      notify();
    },

    /** Delete the config entry for a tag (does NOT touch words). */
    async deleteTagConfig(tag) {
      const next = { ...state.tagConfig };
      delete next[tag];
      state.tagConfig = next;
      try { await db.setSetting('tagConfig', next); } catch (e) { console.warn('[store] deleteTagConfig setSetting error:', e); }
      notify();
    },

    /** Remove a tag from every word. System tags protected. */
    async removeTagFromAll(tag) {
      const isBuiltIn = state.systemTags.some(t => t.name === tag || t.role === tag);
      if (isBuiltIn) { console.warn('[store] cannot remove built-in tag from all words'); notify(); return 0; }
      const touchedWords = [];
      for (const w of state.words) {
        if (w.tags && w.tags.includes(tag)) {
          w.tags = w.tags.filter(t => t !== tag);
          touchedWords.push(w);
        }
      }
      if (touchedWords.length) {
        try { await db.saveWordsInTx(touchedWords); } catch (e) { console.warn('[store] removeTagFromAll batch save error:', e); }
      }
      if (state.tagConfig[tag]) await this.deleteTagConfig(tag);
      else notify();
      return touchedWords.length;
    },

    // ─── Tag CRUD ─────────────────────────────────

    /** Create a new user tag and persist. */
    async createTag(name, color) {
      const n = String(name || '').trim();
      if (!n) return null;
      const existing = state.tags.find(t => t.name === n);
      if (existing) return existing;
      const tag = {
        id: 'tag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: n,
        color: color || '#a78bfa',
      };
      state.tags.push(tag);
      state.tagConfig[tag.name] = tag.color;
      try {
        await db.setAllTags(state.tags);
        await db.setSetting('tagConfig', state.tagConfig);
      } catch (e) { console.warn('[store] createTag error:', e); }
      notify();
      return tag;
    },

    /** Update a user tag's name and/or color. Renames on words too if name changes. */
    async updateTag(id, data) {
      const idx = state.tags.findIndex(t => t.id === id);
      if (idx === -1) return;
      const oldName = state.tags[idx].name;
      const newName = data.name ? String(data.name).trim() : oldName;
      const newColor = data.color || state.tags[idx].color;
      state.tags[idx] = { ...state.tags[idx], name: newName, color: newColor };
      if (newName !== oldName) {
        const touchedWords = [];
        for (const w of state.words) {
          if (w.tags && w.tags.includes(oldName)) {
            w.tags = w.tags.map(t => t === oldName ? newName : t);
            touchedWords.push(w);
          }
        }
        if (touchedWords.length) {
          try { await db.saveWordsInTx(touchedWords); } catch (e) { console.warn('[store] updateTag batch save error:', e); }
        }
        delete state.tagConfig[oldName];
      }
      state.tagConfig[newName] = newColor;
      try {
        await db.setAllTags(state.tags);
        await db.setSetting('tagConfig', state.tagConfig);
      } catch (e) { console.warn('[store] updateTag error:', e); }
      notify();
    },

    /** Delete a user tag. Removes from all words and persists. */
    async deleteTag(id) {
      const idx = state.tags.findIndex(t => t.id === id);
      if (idx === -1) return;
      const tag = state.tags[idx];
      state.tags.splice(idx, 1);
      delete state.tagConfig[tag.name];
      const touchedWords = [];
      for (const w of state.words) {
        if (w.tags && w.tags.includes(tag.name)) {
          w.tags = w.tags.filter(t => t !== tag.name);
          touchedWords.push(w);
        }
      }
      if (touchedWords.length) {
        try { await db.saveWordsInTx(touchedWords); } catch (e) { console.warn('[store] deleteTag batch save error:', e); }
      }
      try {
        await db.setAllTags(state.tags);
        await db.setSetting('tagConfig', state.tagConfig);
      } catch (e) { console.warn('[store] deleteTag error:', e); }
      notify();
    },

    /** Update a system tag's name and/or color. Persists overrides. */
    async updateSystemTag(id, data) {
      const idx = state.systemTags.findIndex(t => t.id === id);
      if (idx === -1) return;
      const oldName = state.systemTags[idx].name;
      const newName = data.name ? String(data.name).trim() : oldName;
      const newColor = data.color || state.systemTags[idx].color;
      const newDesc = data.desc !== undefined ? data.desc : state.systemTags[idx].desc;
      state.systemTags[idx] = { ...state.systemTags[idx], name: newName, color: newColor, desc: newDesc };
      // tagConfig: keep both display name and role name for backward compat
      state.tagConfig[newName] = newColor;
      const role = state.systemTags[idx].role;
      if (role && role !== newName) state.tagConfig[role] = newColor;
      if (newName !== oldName) delete state.tagConfig[oldName];
      try { await db.setSetting('systemTags', state.systemTags.map(t => ({ id: t.id, name: t.name, color: t.color, desc: t.desc }))); } catch (e) { console.warn('[store] updateSystemTag persist error:', e); }
      notify();
    },

    /** Combined array of all tags (system + user). */
    getAllTags() {
      return [...state.systemTags, ...state.tags];
    },

    /** Look up a tag by its role (searches system tags). */
    getTagByRole(role) {
      return (state.systemTags || []).find(t => t.role === role) || null;
    },

    /** Set theme mode (dark/light). Persists and applies. */
    async setThemeMode(mode) {
      state.themeMode = mode === 'light' ? 'light' : 'dark';
      try { await db.setSetting('themeMode', state.themeMode); } catch (e) { console.warn('[store] setThemeMode error:', e); }
      const { applyTheme } = await import('./theme.js');
      applyTheme(state.themeMode, state.themeAccent, state.themeAccentIntensity);
      notify();
    },

    /** Set theme accent intensity (0..1). Persists and applies. */
    async setThemeAccentIntensity(val) {
      state.themeAccentIntensity = Math.max(0, Math.min(1, parseFloat(val)));
      try { await db.setSetting('themeAccentIntensity', state.themeAccentIntensity); } catch (e) { console.warn('[store] setThemeAccentIntensity error:', e); }
      const { applyTheme } = await import('./theme.js');
      applyTheme(state.themeMode, state.themeAccent, state.themeAccentIntensity);
      notify();
    },

    /** Set theme accent preset. Persists and applies. */
    async setThemeAccent(name) {
      state.themeAccent = name || 'skyBlue';
      try { await db.setSetting('themeAccent', state.themeAccent); } catch (e) { console.warn('[store] setThemeAccent error:', e); }
      const { applyTheme } = await import('./theme.js');
      applyTheme(state.themeMode, state.themeAccent, state.themeAccentIntensity);
      notify();
    },

    /** Set TTS pitch (0..99). */
    async setTtsPitch(v) {
      state.ttsPitch = Math.max(0, Math.min(99, parseInt(v) || 50));
      try { await db.setSetting('ttsPitch', state.ttsPitch); } catch (e) { console.warn('[store] setTtsPitch error:', e); }
      notify();
    },

    /** Set the TTS voice (espeak-ng voice name). Persists. */
    async setTtsVoice(v) {
      state.ttsVoice = String(v || 'en_US-ryan-high');
      try { await db.setSetting('ttsVoice', state.ttsVoice); } catch (e) { console.warn('[store] setTtsVoice error:', e); }
      notify();
    },

    /** Set the TTS speech speed (0.5 to 2.0). Persists. */
    async setTtsSpeed(v) {
      state.ttsSpeed = Math.max(0.3, Math.min(3.0, parseFloat(v) || 0.9));
      try { await db.setSetting('ttsSpeed', state.ttsSpeed); } catch (e) { console.warn('[store] setTtsSpeed error:', e); }
      notify();
    },

    /** Set the "day cutoff" (minutes after midnight). Persists. */
    async setDayCutoff(minutes) {
      const v = Math.max(0, Math.min(1439, parseInt(minutes) || 0));
      state.dayCutoff = v;
      try { await db.setSetting('dayCutoff', v); } catch (e) { console.warn('[store] setDayCutoff setSetting error:', e); }
      notify();
    },

    /** Toggle developer mode (unlocks CLI tools in simulator). */
    async setDevMode(v) {
      state.devMode = !!v;
      try { await db.setSetting('devMode', state.devMode); } catch (e) { console.warn('[store] setDevMode setSetting error:', e); }
      notify();
    },

    /** Delete a word */
    async deleteWord(id) {
      state.words = state.words.filter(w => w.id !== id);
      state.cards.delete(id);
      state.cardsMc.delete(id);
      state.cardsSpell.delete(id);
      deleteWordFromMemory(id);
      try { await db.deleteWord(id); } catch (e) { console.warn('[store] deleteWord deleteWord error:', e); }
      await refreshDerived();
      notify();
    },

    /** Create a deck */
    async createDeck(name, color) {
      const id = 'deck_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Math.random().toString(36).slice(2, 6);
      const deck = { id, name, color: color || '#5e6ad2' };
      state.decks.push(deck);
      try { await db.saveDeck(deck); } catch (e) { console.warn('[store] createDeck saveDeck error:', e); }
      await saveDeckOrder();
      notify();
      return deck;
    },

    /** Update a deck (rename / recolor). Words keep deck name reference. */
    async updateDeck(id, updates) {
      const idx = state.decks.findIndex(d => d.id === id);
      if (idx === -1) return;
      const oldName = state.decks[idx].name;
      const next = { ...state.decks[idx], ...updates };
      state.decks[idx] = next;
      try { await db.saveDeck(next); } catch (e) { console.warn('[store] updateDeck saveDeck error:', e); }
      // 若改名，同步更新 words 的 deck 欄位
      if (updates.name && updates.name !== oldName) {
        for (const w of state.words) {
          if (w.deck === oldName) {
            w.deck = updates.name;
            try { await db.saveWord(w); } catch (e) { console.warn('[store] updateDeck saveWord error:', e); }
          }
        }
      }
      await refreshDerived();
      notify();
    },

    /** Delete a deck. Optionally reassign its words to Default. */
    async deleteDeck(id) {
      const deck = state.decks.find(d => d.id === id);
      state.decks = state.decks.filter(d => d.id !== id);
      try { await db.deleteDeck(id); } catch (e) { console.warn('[store] deleteDeck deleteDeck error:', e); }
      if (deck) {
        const wordIds = new Set(state.words.filter(w => w.deck === deck.name).map(w => w.id));
        for (const wid of wordIds) deleteWordFromMemory(wid);   // BH-03: 清 memory 端 reviewLog/examHistory（Sets/buriedAt/examples 同 helper 冪等重清無害；用 wid 避遮蔽外層 deck id）
        state.words = state.words.filter(w => !wordIds.has(w.id));
        state.cards = new Map([...state.cards].filter(([wordId]) => !wordIds.has(wordId)));
        state.cardsMc = new Map([...state.cardsMc].filter(([wordId]) => !wordIds.has(wordId)));
        state.cardsSpell = new Map([...state.cardsSpell].filter(([wordId]) => !wordIds.has(wordId)));
        state.buried = new Set([...state.buried].filter(id => !wordIds.has(id)));
        state.suspended = new Set([...state.suspended].filter(id => !wordIds.has(id)));
        state.suspendedMc = new Set([...state.suspendedMc].filter(id => !wordIds.has(id)));
        state.suspendedSpell = new Set([...state.suspendedSpell].filter(id => !wordIds.has(id)));
        // A5: 三 mode buried/buriedAt 一併過濾（現況只清 flip — 補齊 mc/spell）
        state.buriedMc = new Set([...state.buriedMc].filter(id => !wordIds.has(id)));
        state.buriedSpell = new Set([...state.buriedSpell].filter(id => !wordIds.has(id)));
        for (const [atKey, at] of [['buriedAt', state.buriedAt], ['buriedAtMc', state.buriedAtMc], ['buriedAtSpell', state.buriedAtSpell]]) {
          for (const wid of Object.keys(at || {})) if (wordIds.has(wid)) delete at[wid];
        }
        state.examples = new Map([...state.examples].filter(([id]) => !wordIds.has(id)));
        try { await db.setSetting('buried', [...state.buried]); } catch (e) { console.warn('[store] deleteDeck setSetting buried error:', e); }
        try { await db.setSetting('suspended', [...state.suspended]); } catch (e) { console.warn('[store] deleteDeck setSetting suspended error:', e); }
        try { await db.setSetting('buriedMc', [...state.buriedMc]); } catch (e) { console.warn('[store] deleteDeck setSetting buriedMc error:', e); }
        try { await db.setSetting('buriedSpell', [...state.buriedSpell]); } catch (e) { console.warn('[store] deleteDeck setSetting buriedSpell error:', e); }
        try { await db.setSetting('suspendedMc', [...state.suspendedMc]); } catch (e) { console.warn('[store] deleteDeck setSetting suspendedMc error:', e); }
        try { await db.setSetting('suspendedSpell', [...state.suspendedSpell]); } catch (e) { console.warn('[store] deleteDeck setSetting suspendedSpell error:', e); }
        for (const [atKey, at] of [['buriedAt', state.buriedAt], ['buriedAtMc', state.buriedAtMc], ['buriedAtSpell', state.buriedAtSpell]]) {
          try { await db.setSetting(atKey, at || {}); } catch (e) { console.warn(`[store] deleteDeck setSetting ${atKey} error:`, e); }
        }
        try { await db.deleteWordsByDeck(deck.name); } catch (e) { console.warn('[store] deleteDeck deleteWordsByDeck error:', e); }
      }
      await saveDeckOrder();
      await refreshDerived();
      notify();
    },

    /** Merge source deck into target deck. Source words → target deck, then delete source. */
    async mergeDeck(sourceId, targetId) {
      if (sourceId === targetId) return;
      const src = state.decks.find(d => d.id === sourceId);
      const tgt = state.decks.find(d => d.id === targetId);
      if (!src || !tgt) return;
      for (const w of state.words) {
        if (w.deck === src.name) {
          w.deck = tgt.name;
          try { await db.saveWord(w); } catch (e) { console.warn('[store] mergeDeck saveWord error:', e); }
        }
      }
      state.decks = state.decks.filter(d => d.id !== sourceId);
      try { await db.deleteDeck(sourceId); } catch (e) { console.warn('[store] mergeDeck deleteDeck error:', e); }
      await saveDeckOrder();
      await refreshDerived();
      notify();
    },

    /** Move a deck up (-1) or down (+1) in the list. */
    async moveDeck(id, direction) {
      const idx = state.decks.findIndex(d => d.id === id);
      if (idx === -1) return;
      const target = idx + direction;
      if (target < 0 || target >= state.decks.length) return;
      [state.decks[idx], state.decks[target]] = [state.decks[target], state.decks[idx]];
      await saveDeckOrder();
      notify();
    },

    /** Run simulation (pure, doesn't mutate store) */
    async runSimulation(days = 365, overrideWeights, humanMode) {
      const weightsStr = overrideWeights || state.ankiSettings.fsrsWeights;
      return requireSimulator().runSimulation({
        days,
        words: state.words,
        cards: state.cards,
        fsrsParams: {
          weights: weightsStr
            ? (() => { try { return JSON.parse('[' + weightsStr + ']'); } catch { return null; } })()
            : null,
          desiredRetention: state.ankiSettings.desiredRetention,
        },
        newPerDay: state.ankiSettings.cardsPerDay,
        simParams: state.simParams,
        humanMode: humanMode ?? state.simParams.humanMode ?? false,
        ankiSettings: state.ankiSettings,
        reviewLog: state.reviewLog,
      });
    },

    /**
     * 逐卡學習模擬 — 每天對到期卡評分, 更新 interval, 統計成熟卡成長
     * 返回 [{ day, date, mature, maturePct, reviews }]
     */
    async runMatureSimulation(days = 365, targetPct = 95, seed = 1) {
      const ankiCfg = state.ankiSettings;
      const fsrs = new FSRS(
        ankiCfg.fsrsWeights ? (() => { try { const w = ankiCfg.fsrsWeights.replace(/^\[|\]$/g, '').trim(); return w ? JSON.parse('[' + w + ']') : null; } catch { return null; } })() : null,
        Math.max(0.7, Math.min(0.99, ankiCfg.desiredRetention ?? 0.9)),
        true,
        Math.max(1, ankiCfg.maxIvl ?? 365)
      );
      const learnSteps = parseStepsStr(ankiCfg.learnSteps, '1,10');
      const relearnSteps = parseStepsStr(ankiCfg.relearnSteps, '10');
      let rng = mulberry32(seed);

      // 複製卡片狀態 (不影響真實)
      const cards = new Map();
      for (const [wid, c] of state.cards) {
        cards.set(wid, { ...c, lastReviewMs: c.lastReview ? new Date(c.lastReview).getTime() : 0, lastReviewIso: c.lastReview || null });
      }
      const words = state.words;
      const total = words.length;
      let simNow = Date.now();

      // 評分函數 (依 interval 決定 Again, 接近成熟低 Again)
      const pick = (card) => {
        const r = rng();
        if (!card || card.state === 0) {
          const d = [0.05, 0.02, 0.92, 0.01];
          let acc = 0; for (let i = 0; i < 4; i++) { acc += d[i]; if (r < acc) return i; } return 2;
        }
        const ivl = card.scheduledDays ?? card.interval ?? 0;
        let dist;
        if (ivl >= 14) dist = [0.05, 0.04, 0.89, 0.02];
        else if (ivl >= 7) dist = [0.10, 0.05, 0.83, 0.02];
        else if (ivl >= 3) dist = [0.18, 0.06, 0.74, 0.02];
        else dist = [0.30, 0.07, 0.61, 0.02];
        let acc = 0;
        for (let i = 0; i < 4; i++) { acc += dist[i]; if (r < acc) return i; }
        return 2;
      };

      const results = [];
      let mature = 0;
      for (let d = 0; d < days; d++) {
        simNow += 24 * 3600 * 1000;
        const dateStr = new Date(simNow).toISOString().slice(0, 10);
        const dayStr = dateStr;
        let reviews = 0;

        // 收集今天到期卡 (due <= 今天)
        const dueCards = [];
        for (const w of words) {
          const card = cards.get(w.id);
          if (!card) continue;
          if (!card.due) continue;
          const dueDate = new Date(card.due).toISOString().slice(0, 10);
          if (dueDate > dayStr) continue;
          dueCards.push({ w, card });
        }
        // 新卡引入
        const freshSlots = Math.max(0, (ankiCfg.cardsPerDay ?? 80) - dueCards.length);
        let freshAdded = 0;
        for (const w of words) {
          if (freshAdded >= freshSlots) break;
          if (!cards.has(w.id)) {
            cards.set(w.id, { due: new Date(simNow).toISOString(), stability: 0, difficulty: 5, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0, step: 0, lastReview: null, lastReviewIso: null, lastReviewMs: 0, interval: 0 });
            freshAdded++;
          }
        }

        for (const { w, card } of dueCards) {
          const rating = pick(card);
          const res = fsrs.review(card, rating, rng(), learnSteps, relearnSteps);
          card.state = res.state;
          card.due = new Date(simNow + Math.max(60000, Math.round(res.dueDays * 86400000))).toISOString();
          card.stability = res.stability;
          card.difficulty = res.difficulty;
          card.step = res.step ?? 0;
          card.interval = res.dueDays ?? 0;
          card.scheduledDays = res.state === 2 ? Math.round(res.dueDays) : res.dueDays;
          card.reps = res.reps;
          card.lapses = res.lapses;
          card.elapsedDays = null;
          card.lastReviewIso = new Date(simNow).toISOString();
          card.lastReviewMs = simNow;
          reviews++;
        }

        mature = [...cards.values()].filter(c => c.state === 2 && (c.scheduledDays ?? 0) >= 21).length;
        results.push({ day: d + 1, date: dateStr, mature, maturePct: total ? Math.round(mature / total * 100) : 0, reviews });
        if (total && mature / total >= targetPct / 100) break;
      }
      return { results, targetPct, totalWords: total, finalMature: mature };
    },

    /** Preview the scheduled interval (days) for each rating on a card. */
    previewIntervals(wordId, mode = 'flip') {
      const { computeFutureDueCounts, getToday, toLocalDateStr } = requireScheduler();
      const cardMap = mode === 'mc' ? state.cardsMc : mode === 'spell' ? state.cardsSpell : state.cards;
      const ankiCfg = mode === 'mc' ? state.ankiSettingsMc : mode === 'spell' ? state.ankiSettingsSpell : state.ankiSettings;
      const fsrs = new FSRS(
        ankiCfg.fsrsWeights ? (() => { try { const w = ankiCfg.fsrsWeights.replace(/^\[|\]$/g, '').trim(); return w ? JSON.parse('[' + w + ']') : null; } catch { return null; } })() : null,
        Math.max(0.7, Math.min(0.99, ankiCfg.desiredRetention ?? 0.9)),
        true,
        Math.max(1, ankiCfg.maxIvl ?? 365)
      );
      const card = cardMap.get(wordId);
      const lastTs = card?.lastReview ? new Date(card.lastReview).getTime() : null;
      const todayStr = getToday(state.dayCutoff, ankiCfg?.timezoneOffset);
      const lastDay = lastTs != null ? toLocalDateStr(new Date(lastTs), ankiCfg?.timezoneOffset, state.dayCutoff) : null;
      const elapsed = lastDay != null ? daysBetween(lastDay, todayStr) : 0;
      const base = card ? {
        stability: card.stability ?? 0,
        difficulty: card.difficulty ?? 5,
        state: card.state ?? STATE_NEW,
        reps: card.reps ?? 0,
        lapses: card.lapses ?? 0,
        step: card.step ?? 0,
        elapsedDays: elapsed,
        scheduledDays: card.scheduledDays ?? 0,
      } : {
        stability: 0, difficulty: 5, state: STATE_NEW,
        reps: 0, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0,
      };
      const fuzzFactor = generateFuzzFactor(wordId + '_' + mode, base.reps);
      
      // Parse learning steps from settings
      const learnSteps = parseStepsStr(ankiCfg.learnSteps, '1,10');
      const relearnSteps = parseStepsStr(ankiCfg.relearnSteps, '10');
      // Get future due counts for load balancing (only for review cards)
      let futureCounts = null;
      if (base.state === STATE_REVIEW || base.state === STATE_RELEARNING) {
        futureCounts = computeFutureDueCounts(cardMap, 90, state.dayCutoff, ankiCfg?.timezoneOffset);
      }

      const out = {};
      for (let rating = 0; rating <= 3; rating++) {
        const res = fsrs.review(base, rating, fuzzFactor, learnSteps, relearnSteps, futureCounts);
        out[rating] = Math.max(0.001, res.dueDays);
      }
      return out;
    },

    /** Clear ALL data and reset to factory state */
    async resetAll() {
      const d = await import('./db.js');
      await d.clearAll();
      try { await d.executeSQL("VACUUM"); } catch (_) {}
      await d.closeDB();
      try { localStorage.clear(); } catch (e) {}
      try { localStorage.setItem('teno_no_seed', '1'); } catch (e) {}
      location.reload();
    },

    /** 將一次考試的結果寫入 exam_history（v3 B4：簽名 { mode, entries }；word 欄位語意統一為 word_id） */
    async recordExam({ mode, entries }) {
      const now = new Date().toISOString();
      const ids = new Set(state.words.map(w => w.id));   // B4: 循環前快照 — 消除跨 await 讀取
      for (const r of entries ?? []) {                   // B4: entries 非陣列防護
        if (!r || r.wordId == null || !ids.has(r.wordId)) continue;   // B4: 語意統一 — 只收 word_id，不驗文字
        try {
          await db.addExamEntry({ word: r.wordId, correct: !!r.correct, questionType: r.questionType || mode || null, examinedAt: now });
          // B4: push 移入 try 內 — db 成功才 push（記憶體與 DB 一致）；questionType ||（'' 降級 mode，與 db.js:494 正規化一致）
          state.examHistory.push({
            word: r.wordId,   // B4/M4: 統一 word_id（存文字改名後孤立）
            correct: r.correct ? 1 : 0,
            question_type: r.questionType || mode || null,
            examined_at: now,
          });
        } catch (e) { console.warn('[store] recordExam addExamEntry error:', e); }
      }
      notify();
    },

    /** 儲存測驗進度（中途退出時） */
    async saveExamSession(session) {
      const max = state.maxExamSessions || 5;
      let list = state.examSessions.filter(s => s.id !== session.id);
      list.push(session);
      list.sort((a, b) => b.timestamp - a.timestamp);
      if (list.length > max) list.length = max;
      state.examSessions = list;
      await db.setSetting('examSessions', list);
      notify();
    },

    /** 刪除指定測驗進度 */
    async deleteExamSession(id) {
      state.examSessions = state.examSessions.filter(s => s.id !== id);
      await db.setSetting('examSessions', state.examSessions);
      notify();
    },

    /** 設定最多保留幾組進度 */
    async setMaxExamSessions(n) {
      state.maxExamSessions = n;
      await db.setSetting('maxExamSessions', n);
      if (state.examSessions.length > n) {
        state.examSessions.sort((a, b) => b.timestamp - a.timestamp);
        state.examSessions.length = n;
        await db.setSetting('examSessions', state.examSessions);
      }
      notify();
    },

    /** Optimize FSRS weights for a specific mode (flip/mc/spell) — 各模式獨立 */
    async optimizeWeights(progressCallback, mode = 'flip') {
      const log = state.reviewLog.filter(e => (e.mode || 'flip') === mode);
      if (log.length < 10) {
        throw new Error(`${mode} 模式複習記錄不足：${log.length} 筆（需 ≥ 10）`);
      }
      const { optimizeFsrs } = await import('../lib/api.js');
      const data = log.map(r => ({ word_id: r.wordId, rating: r.rating, elapsed_days: r.elapsedDays ?? r.ivl ?? 0 }));
      const weights = await optimizeFsrs(data);
      if (!weights || weights.length !== 21) {
        throw new Error('官方 fsrs-rs 優化失敗');
      }
      const weightsStr = weights.map(w => w.toFixed(4)).join(', ');
      if (mode === 'mc') await this.updateAnkiSettingsMc({ fsrsWeights: weightsStr });
      else if (mode === 'spell') await this.updateAnkiSettingsSpell({ fsrsWeights: weightsStr });
      else await this.updateAnkiSettings({ fsrsWeights: weightsStr });
      progressCallback?.({ epoch: 1, totalEpochs: 1, currentLoss: 0, bestLoss: 0, improvement: `官方 fsrs-rs 優化（${mode} 模式獨立）` });
      return { weights, initialLoss: null, finalLoss: null, reviewCount: log.length, official: true, mode };
    },

    /** Health check for a specific mode's cards */
    async runHealthCheck(mode = 'flip') {
      const mod = await import('../core/fsrs-optimizer.js');
      const cards = mode === 'mc' ? state.cardsMc
        : mode === 'spell' ? state.cardsSpell
        : state.cards;
      const as = mode === 'mc' ? state.ankiSettingsMc
        : mode === 'spell' ? state.ankiSettingsSpell
        : state.ankiSettings;
      const log = state.reviewLog.filter(e => (e.mode || 'flip') === mode);
      return mod.healthCheck(cards, log, as, state.words);
    },

    // ─── Filtered Decks ──────────────────────────────────────

    async saveFilteredDeck(deck) {
      if (!deck.id) deck.id = 'fd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try {
        await db.saveFilteredDeck(deck);
        // Reload filtered decks
        state.filteredDecks = await db.getAllFilteredDecks();
        notify();
      } catch (e) {
        console.error('[store] saveFilteredDeck error:', e);
        throw e;
      }
    },

    async createFilteredDeck(data) {
      return this.saveFilteredDeck(data);
    },

    async updateFilteredDeck(id, data) {
      data.id = id;
      return this.saveFilteredDeck(data);
    },

    async deleteFilteredDeck(id) {
      try {
        await db.deleteFilteredDeck(id);
        state.filteredDecks = await db.getAllFilteredDecks();
        if (state.activeFilteredDeck === id) {
          state.activeFilteredDeck = null;
        }
        notify();
      } catch (e) {
        console.error('[store] deleteFilteredDeck error:', e);
        throw e;
      }
    },

    async activateFilteredDeck(id) {
      const deck = state.filteredDecks.find(d => d.id === id);
      if (!deck) {
        console.warn('[store] activateFilteredDeck: deck not found:', id);
        return;
      }
      state.activeFilteredDeck = id;
      try {
        await db.updateFilteredDeckLastUsed(id);
      } catch (e) {
        console.warn('[store] updateFilteredDeckLastUsed error:', e);
      }
      notify();
    },

    deactivateFilteredDeck() {
      state.activeFilteredDeck = null;
      notify();
    },

    getFilteredDeckCards(deckId) {
      const deck = state.filteredDecks.find(d => d.id === deckId);
      if (!deck) return [];
      
      const { executeFilter } = requireFilterEngine();
      
      // Convert cards Map to array with word data
      const allCards = state.words.map(word => {
        const card = state.cards.get(word.id) || state.cardsMc.get(word.id) || state.cardsSpell.get(word.id);
        return {
          ...word,
          id: word.id,
          word: word.word,
          translation: word.definition,
          deck: word.deck,
          tags: word.tags || [],
          state: card?.state ?? 0,
          stability: card?.stability ?? 2.5,
          difficulty: card?.difficulty ?? 5,
          due: card?.due ?? null,
          interval: card?.interval || 0,
          scheduledDays: card?.scheduledDays ?? 0,
          elapsedDays: card?.elapsedDays ?? 0,
          reps: card?.reps ?? 0,
          lapses: card?.lapses ?? 0,
          step: card?.step ?? 0,
          lastReview: card?.lastReview ?? null,
          buried: card?.buried ?? false,
          suspended: card?.suspended ?? false,
          mcData: card?.mcData ?? null,
          spellData: card?.spellData ?? null,
          createdAt: word.createdAt,
        };
      });
      
      return executeFilter(allCards, deck.search_query, {
        maxCards: deck.max_cards,
        orderBy: deck.order_by,
        dayCutoff: state.dayCutoff,
      });
    },
  };

  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    actions,
    // For testing
    async _refreshDerived() { await refreshDerived(); },
    async _autoUnburyIfNewDay(now) { await autoUnburyIfNewDay(now); },
    async _migrateBuriedAt() { await migrateBuriedAt(); },
    _resetUnburyGuard() { _lastUnburyCheckDay = null; },
  };
}
