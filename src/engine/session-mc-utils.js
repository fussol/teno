import { Session } from './session-v4.js';
import { FSRS, AGAIN, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING } from '../core/fsrs.js';
import { toast } from '../lib/toast.js';

export let session = null;
export let state = 'EMPTY';
export const intervals = {};
export let lastCorrect = false;
export let mcOptions = [];
let currentWordId = null;
let keyCleanup = null;
let _undoSnapshot = null;
let _completionShown = false;
let _ratingLock = false;
let _goalPending = Promise.resolve(); // C9: incrementGoal in-flight 追縱鏈（undo 前必排空）

export function e(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function parseWeights(as) {
  try { return as?.fsrsWeights ? JSON.parse('[' + as.fsrsWeights + ']') : null; }
  catch { return null; }
}

function makeFSRS(as) {
  // C4: 第 4 參 maximumInterval 與 store rateCard 同源（store.js new FSRS(..., maxIvl)）；
  // 不傳則走 fsrs.js 預設 36500 → 成熟卡預覽 interval 突破使用者 maxIvl 上限
  return new FSRS(parseWeights(as), as?.desiredRetention ?? 0.9, true,
    Math.max(1, as?.maxIvl ?? 365));
}

export function ensureSession(storeState) {
  if (session) return;
  if (!storeState.words || !storeState.cardsMc || !storeState.ankiSettingsMc) return;
  session = new Session({
    words: storeState.words, cards: storeState.cardsMc,
    buried: storeState.buried, suspended: storeState.suspended,
    fsrs: makeFSRS(storeState.ankiSettingsMc),
    dayCutoff: storeState.dayCutoff,
    newPerDay: storeState.ankiSettingsMc.cardsPerDay,
    ratedNewToday: storeState.newRatedTodayMc,
    learnSteps: storeState.ankiSettingsMc.learnSteps,
    relearnSteps: storeState.ankiSettingsMc.relearnSteps,
    maxReviewsPerDay: storeState.simParams?.maxReviewsPerDay ?? 0,
    reviewMix: storeState.ankiSettingsMc.reviewMix ?? 2,
    timezoneOffset: storeState.ankiSettingsMc.timezoneOffset,
    mode: 'mc',
    learnAheadLimit: storeState.ankiSettingsMc.learnAheadLimit,
  });
}

export function ensureQueue(filter, storeState) {
  if (session?.running) return true;
  if (!session) return false;
  // Session completed — show completion screen once, then allow rebuild
  if (!session.running && session.results.length > 0) {
    if (!_completionShown) {
      _completionShown = true;
      state = 'EMPTY';
      return false;
    }
    session.reset();
  }
  _completionShown = false;
  if (storeState) {
    session.newPerDay = storeState.ankiSettingsMc.cardsPerDay;
    session.ratedNewToday = storeState.newRatedTodayMc;
    session.maxReviewsPerDay = storeState.simParams?.maxReviewsPerDay ?? 0;
    // C4: live sync — ensureSession 只建一次 FSRS，設定變更後此行保證預覽 cap 與 store 端一致
    session.fsrs.maximumInterval = Math.max(1, storeState.ankiSettingsMc?.maxIvl ?? 365);
  }
  session.start(filter);
  if (!session.intradayLearning.length && !session.mainQueue.length && !session.current) { state = 'EMPTY'; return false; }
  state = 'QUESTION';
  currentWordId = null;
  mcOptions = [];
  if (session.current) {
    Object.assign(intervals, session.computeIntervals(session.current.word.id));
    generateOptions(session.current.word, session.words);
  }
  return true;
}

function generateOptions(word, allWords) {
  const others = allWords.filter(w => w.id !== word.id && w.word !== word.word);
  const shuffled = [...others].sort(() => Math.random() - 0.5);
  const wrong = shuffled.slice(0, 7).map(w => w.word);
  const correct = word.word;
  const options = [...wrong, correct];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  mcOptions = options;
  currentWordId = word.id;
}

export function pickAnswer(index) {
  if (!session?.current || state !== 'QUESTION' || index < 0 || index >= mcOptions.length) return;
  lastCorrect = mcOptions[index] === session.current.word.word;
  state = 'ANSWER';
  Object.assign(intervals, session.computeIntervals(session.current.word.id) || {});
}

export async function rateCard(store, rating, renderFn) {
  if (!session?.current) return;
  if (_ratingLock) return;
  _ratingLock = true;
  const wid = session.current.word.id;
  const t = Math.max(0, Date.now() - (session.current.shownAt || session.startedAt));
  try {
    try {
      await store.actions.rateCard(wid, rating, t, 'mc');
    } catch (err) {
      toast('儲存失敗', 'toast-error');
      return; // C10: 釋鎖交 finally（原手動釋放＋return，語意相同）
    }
    const _goalP = store.actions.incrementGoal('mc').catch(() => {});
    _goalPending = _goalPending.then(() => _goalP); // C9: 追縱完成，undo 前統一排空（呼叫時機與現行逐字同）

    _undoSnapshot = {
      // 深拷貝：rateCard 之後 line `session.current.card = session.cards.get(...)`
      // 會改到同一個引用 → 快照若存引用，undo 後 current 卡的排程會是「評分後」的。
      currentCard: session.current
        ? { ...session.current, card: session.current.card ? { ...session.current.card } : null }
        : null,
      rating, wordId: wid,
      stateBefore: state,
      mcOptionsBefore: [...mcOptions],
      currentWordIdBefore: currentWordId,
    };

    session.cards = store.state.cardsMc;
    if (session.current) session.current.card = session.cards.get(session.current.word.id) || session.current.card;
    const updatedCard = store.state.cardsMc.get(wid);

    session.rate(rating);

    session.requeueIntraday(wid, updatedCard);

    session.next();
    state = session.current ? 'QUESTION' : 'EMPTY';
    currentWordId = null;
    mcOptions = [];
    if (session.current) {
      Object.assign(intervals, session.computeIntervals(session.current.word.id));
      generateOptions(session.current.word, session.words);
    }
    const _c = getCounts();
    console.log('[rate]', wid, 'rating=', rating, 'newstate=', updatedCard?.state, 'counts=', _c.newCount + '新', _c.learnCount + '學', _c.reviewCount + '複', 'state=', state, 'running=', session.running);
  } finally {
    _ratingLock = false; // C10: 任何路徑釋鎖（原手動單點——尾段拋錯＝評分+undo 雙鎖死）
  }
  renderFn();
}

export function getCounts() {
  const counts = { newCount: 0, learnCount: 0, reviewCount: 0 };
  if (!session) return counts;
  const count = (s) => {
    if (s === STATE_NEW) counts.newCount++;
    else if (s === STATE_LEARNING || s === STATE_RELEARNING) counts.learnCount++;
    else if (s === STATE_REVIEW) counts.reviewCount++;
  };
  for (const item of session.intradayLearning) count(item.card?.state ?? 0);
  for (const item of session.mainQueue) count(item.card?.state ?? 0);
  if (session.current) count(session.current.card?.state ?? 0);
  return counts;
}

export async function undoRating(store, renderFn) {
  if (!_undoSnapshot) return;
  if (_ratingLock) return; // C8: 評分 in-flight 期間 undo 丟棄（與 rateCard 鎖雙向互斥）
  _ratingLock = true;
  try {
    const { currentCard, rating, wordId, mcOptionsBefore, currentWordIdBefore } = _undoSnapshot;

    await _goalPending; // C9: in-flight goal 增量必全數落地後才還原（goal_streak 寫序序列化，防幽靈覆寫）
    await store.actions.undoLastRating('mc');

    session.results.pop();

    session.removeIntraday(wordId);

    // 評分後 next() 已把下一張 (B) 設為 current — 放回原本 queue, 避免 undo 吞掉它
    if (session.current && session.current !== currentCard) {
      const cur = session.current;
      if (cur.type === 'learning' || cur.type === 'relearning') {
        session.intradayLearning.unshift(cur);
      } else {
        session.mainQueue.unshift(cur);
      }
    }

    if (currentCard) {
      // undo 後 current 就是它 — 不進任何 queue（還原「評分前」狀態：評分前
      // 它原本就是 current 不在 queue）。重評時 rateCard 的 requeueIntraday
      // 會處理 learning 卡重新排程；若在此 requeue 會讓它同時存在於
      // intraday 與 current，重評後 next() 又撈到它 → 連續兩張同一卡。
    }

    session.current = currentCard;
    session.running = true;
    _completionShown = false; // C7: undo 後重評再完成須走完成分支（原殘留旗標致 reset 清空 results）
    state = _undoSnapshot.stateBefore || 'QUESTION';
    // 重算間隔預覽：undo 前 intervals 停留在下一張卡 B（或評分後）的數值
    if (session.current) Object.assign(intervals, session.computeIntervals(session.current.word.id) || {});
    if (currentCard) {
      currentWordId = currentWordIdBefore;
      mcOptions = mcOptionsBefore;
    }
    _undoSnapshot = null; // C8: 移入 try 尾——undo 完成必清快照（漏植＝重複 undo 洞）
  } finally {
    _ratingLock = false; // C8: 任何路徑釋鎖（含 await 拋錯——undo 半途而廢不永久鎖死）
  }
  renderFn();
}

export function mount(store, renderFn) {
  document.querySelectorAll('[data-goto]').forEach(el =>
    el.addEventListener('click', () => store.actions.navigate(el.dataset.goto)));
  if (keyCleanup) keyCleanup();
  if (!session?.running && !_undoSnapshot) return; // C7: 完成畫面有快照仍註冊 handler（原早退致零 handler）
  setTimeout(() => {
    const btns = document.querySelector('.study-buttons');
    const bar = document.getElementById('bottomBar');
    if (btns && bar && getComputedStyle(bar).display !== 'none') {
      const br = btns.getBoundingClientRect();
      const barR = bar.getBoundingClientRect();
      if (br.bottom > barR.top && br.top < barR.bottom) {
        console.error('[overlap] study buttons overlap bottom bar', br, barR);
      }
    }
  }, 100);
  document.querySelectorAll('[data-opt-index]').forEach(el =>
    el.addEventListener('click', () => { pickAnswer(parseInt(el.dataset.optIndex)); renderFn(); }));
  document.querySelectorAll('[data-r4]').forEach(el =>
    el.addEventListener('click', async () => {
      if (el.disabled) return;
      el.disabled = true;
      el.style.transform = 'scale(.94)';
      el.style.opacity = '.6';
      await rateCard(store, parseInt(el.dataset.r4), renderFn);
    }));
  document.getElementById('undoBtn')?.addEventListener('click', () => undoRating(store, renderFn));
  const h = e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (_undoSnapshot) { // C7: 完成/QUESTION 態亦可 undo（原 ANSWER-only gate 擋死）
        undoRating(store, renderFn);
      }
      return;
    }
    const k = parseInt(e.key);
    if (k >= 1 && k <= 8) {
      e.preventDefault();
      if (state === 'QUESTION') {
        pickAnswer(k - 1);
        renderFn();
      } else if (state === 'ANSWER' && k >= 1 && k <= 4) {
        rateCard(store, k - 1, renderFn);
      }
    }
  };
  document.addEventListener('keydown', h);
  keyCleanup = () => document.removeEventListener('keydown', h);
  window.__pageCleanup = keyCleanup;
}
