// ═══════════════════════════════════════════════════════════════
// WEB-DEMO 展示資料（純瀏覽器預覽用，記憶體內，refresh 重置）
//
// 啟用條件：window.__TAURI__ 缺席（dist 被當純靜態頁開時）。
// db.js initDB 偵測到即切 demoMode，全函式分流到此檔；實機（含
// Tauri 桌面＋Android）零影響——SQLite 路徑一行未動。
// 依使用者裁示（2026-09-08）：網頁版內建幾十個假單字，各頁可點可看。
// ═══════════════════════════════════════════════════════════════

let words = [];
let cards = new Map();
let decks = [];
let folders = {};
let additions = [];
let settings = new Map();
let reviewLogs = [];
let examHistory = [];
let goalStreak = null;
let filteredDecks = [];
let logSeq = 1;
let wordSeq = 1;

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// 建構單字（欄位對齊 db.js getAllWords 輸出形狀）
function mk(id, word, definition, pos, pron, example, deck, extra = {}) {
  return {
    id, word, definition, pos, pron, example, deck,
    tags: [], image: '', description: '',
    related: [], forms: [],
    synonym: '', antonym: '', derivative: '',
    examples: [], etymology: '', syllables: '', phrases: '',
    createdAt: isoDaysAgo(30),
    ...extra,
  };
}

// 複習卡（欄位對齊 db.js getAllCards 輸出形狀）
function mkCard(dueIso, lastIso, extra = {}) {
  return {
    due: dueIso, stability: 2.5, difficulty: 5,
    elapsedDays: 0, scheduledDays: 1, reps: 1, lapses: 0,
    state: 0, step: 0, lastReview: lastIso,
    buried: false, suspended: false, interval: 1,
    mcData: null, spellData: null,
    ...extra,
  };
}

/** 重置並填入種子資料（initDB demo 分支呼叫；clearAll 後不清、直接倒空） */
export async function seed() {
  words = [
    // ── GRE 核心 ──
    mk('w001', 'abate', '減弱；緩和', 'verb', 'əˈbeɪt',
      'The storm suddenly abated. 暴風雨突然減弱了。', 'GRE 核心', {
        tags: ['GRE', '動詞'], related: ['subside', 'lessen'], forms: ['abated', 'abatement'],
        synonym: 'subside, lessen, diminish', antonym: 'intensify, escalate',
        examples: ['The storm suddenly abated.', 'Nothing could abate his curiosity.'],
        etymology: 'Middle English, from Old French abattre ‘to fell’. 首現 14 世紀。',
        syllables: 'abate', phrases: 'abate in intensity',
      }),
    mk('w002', 'aberration', '越軌；反常', 'noun', 'ˌæbəˈreɪʃn',
      'Such behavior is an aberration. 這種行為是反常的。', 'GRE 核心', {
        tags: ['GRE', '名詞'], related: ['anomaly', 'deviation'], forms: ['aberrational'],
        synonym: 'anomaly, deviation', antonym: 'norm, standard',
        etymology: 'Latin aberrare ‘to stray’. 首現 16 世紀。', syllables: 'ab·er·ra·tion',
      }),
    mk('w003', 'abjure', '發誓放棄', 'verb', 'æbˈdʒʊr',
      'He abjured violence. 他發誓放棄暴力。', 'GRE 核心', {
        tags: ['GRE', '動詞'], related: ['renounce', 'recant'],
        synonym: 'renounce, recant', antonym: 'embrace, adopt',
      }),
    mk('w004', 'abscond', '潛逃', 'verb', 'æbˈskɑːnd',
      'The thief absconded with the money. 小偷捲款潛逃。', 'GRE 核心', {
        tags: ['GRE', '動詞'], related: ['flee', 'escape'],
        synonym: 'flee, escape, bolt', antonym: 'remain, stay',
      }),
    mk('w005', 'abstruse', '深奧的；難懂的', 'adjective', 'æbˈstruːs',
      'An abstruse theory. 深奧的理論。', 'GRE 核心', {
        tags: ['GRE', '形容詞'], related: ['obscure', 'recondite'],
        synonym: 'obscure, arcane', antonym: 'clear, obvious',
      }),
    mk('w006', 'acerbic', '尖酸的；刻薄的', 'adjective', 'əˈsɜːrbɪk',
      'His acerbic wit. 他尖酸的機智。', 'GRE 核心', {
        tags: ['GRE', '形容詞'], related: ['caustic', 'mordant'],
        synonym: 'caustic, biting', antonym: 'kind, gentle',
      }),
    mk('w007', 'acquiesce', '默許；默認', 'verb', 'ˌækwiˈes',
      'She acquiesced to the plan. 她默許了這個計畫。', 'GRE 核心', {
        tags: ['GRE', '動詞'], related: ['assent', 'concede'],
        synonym: 'assent, comply', antonym: 'resist, object',
      }),
    mk('w008', 'adamant', '堅決的；固執的', 'adjective', 'ˈædəmənt',
      'He was adamant about leaving. 他堅決要離開。', 'GRE 核心', {
        tags: ['GRE', '形容詞'], related: ['resolute', 'inflexible'],
        synonym: 'resolute, firm', antonym: 'flexible, yielding',
      }),
    mk('w009', 'adulation', '諂媚；奉承', 'noun', 'ˌædʒəˈleɪʃn',
      'He found adulation embarrassing. 他覺得奉承令人尷尬。', 'GRE 核心', {
        tags: ['GRE', '名詞'], related: ['flattery', 'worship'],
        synonym: 'flattery, worship', antonym: 'criticism, scorn',
      }),
    mk('w010', 'alacrity', '欣然；敏捷', 'noun', 'əˈlækrəti',
      'She accepted with alacrity. 她欣然接受。', 'GRE 核心', {
        tags: ['GRE', '名詞'], related: ['eagerness', 'willingness'],
        synonym: 'eagerness, readiness', antonym: 'reluctance, apathy',
      }),
    mk('w011', 'ambiguous', '含糊的；模稜兩可的', 'adjective', 'æmˈbɪɡjuəs',
      'An ambiguous answer. 含糊的回答。', 'GRE 核心', {
        tags: ['GRE', '形容詞'], related: ['equivocal', 'vague'], forms: ['ambiguity'],
        synonym: 'equivocal, vague', antonym: 'clear, explicit',
      }),
    mk('w012', 'ameliorate', '改善；減輕', 'verb', 'əˈmiːljəreɪt',
      'Measures to ameliorate poverty. 改善貧困的措施。', 'GRE 核心', {
        tags: ['GRE', '動詞'], related: ['improve', 'alleviate'],
        synonym: 'improve, alleviate', antonym: 'worsen, aggravate',
      }),
    // ── 托福 ──
    mk('w013', 'albeit', '雖然；儘管', 'conjunction', 'ɔːlˈbiːɪt',
      'He tried, albeit unsuccessfully. 他試了，雖然沒成功。', '托福', {
        tags: ['托福'], synonym: 'although, though',
      }),
    mk('w014', 'bolster', '支持；鞏固', 'verb', 'ˈboʊlstər',
      'Evidence bolsters the theory. 證據支持了這個理論。', '托福', {
        tags: ['托福', '動詞'], related: ['support', 'strengthen'],
        synonym: 'support, strengthen', antonym: 'undermine, weaken',
      }),
    mk('w015', 'camouflage', '偽裝；掩飾', 'noun', 'ˈkæməflɑːʒ',
      'The soldiers wore camouflage. 士兵穿著迷彩服。', '托福', {
        tags: ['托福', '名詞'], related: ['disguise', 'cover'],
        synonym: 'disguise, mask', antonym: 'exposure',
      }),
    mk('w016', 'candid', '坦率的；直言的', 'adjective', 'ˈkændɪd',
      'A candid interview. 坦率的訪談。', '托福', {
        tags: ['托福', '形容詞'], related: ['frank', 'forthright'],
        synonym: 'frank, honest', antonym: 'evasive, guarded',
      }),
    mk('w017', 'contemplate', '沉思；考慮', 'verb', 'ˈkɑːntəmpleɪt',
      'He contemplated the problem. 他思考這個問題。', '托福', {
        tags: ['托福', '動詞'], related: ['ponder', 'consider'], forms: ['contemplation'],
        synonym: 'ponder, consider',
      }),
    mk('w018', 'deteriorate', '惡化；變壞', 'verb', 'dɪˈtɪriəreɪt',
      'His health deteriorated. 他的健康惡化了。', '托福', {
        tags: ['托福', '動詞'], related: ['worsen', 'decline'],
        synonym: 'worsen, decline', antonym: 'improve, recover',
      }),
    mk('w019', 'eloquent', '雄辯的；有說服力的', 'adjective', 'ˈeləkwənt',
      'An eloquent speech. 雄辯的演說。', '托福', {
        tags: ['托福', '形容詞'], related: ['articulate', 'fluent'],
        synonym: 'articulate, expressive', antonym: 'inarticulate',
      }),
    mk('w020', 'feasible', '可行的', 'adjective', 'ˈfiːzəbl',
      'A feasible plan. 可行的計畫。', '托福', {
        tags: ['托福', '形容詞'], related: ['viable', 'practical'],
        synonym: 'viable, workable', antonym: 'impractical, impossible',
      }),
    mk('w021', 'fluctuate', '波動；起伏', 'verb', 'ˈflʌktʃueɪt',
      'Prices fluctuate daily. 價格每天波動。', '托福', {
        tags: ['托福', '動詞'], related: ['vary', 'oscillate'],
        synonym: 'vary, waver', antonym: 'stabilize',
      }),
    mk('w022', 'inevitable', '不可避免的', 'adjective', 'ɪnˈevɪtəbl',
      'An inevitable result. 不可避免的結果。', '托福', {
        tags: ['托福', '形容詞'], related: ['unavoidable', 'certain'],
        synonym: 'unavoidable, certain', antonym: 'avoidable, uncertain',
      }),
    mk('w023', 'meticulous', '一絲不苟的', 'adjective', 'məˈtɪkjələs',
      'Meticulous care. 無微不至的照顧。', '托福', {
        tags: ['托福', '形容詞'], related: ['thorough', 'precise'],
        synonym: 'thorough, careful', antonym: 'careless, sloppy',
      }),
    mk('w024', 'mitigate', '減輕；緩解', 'verb', 'ˈmɪtɪɡeɪt',
      'Measures to mitigate risk. 減輕風險的措施。', '托福', {
        tags: ['托福', '動詞'], related: ['alleviate', 'relieve'],
        synonym: 'alleviate, ease', antonym: 'aggravate, intensify',
      }),
    // ── 日常 ──
    mk('w025', 'appointment', '約會；預約', 'noun', 'əˈpɔɪntmənt',
      'I have a dentist appointment. 我約了牙醫。', '日常', {
        tags: ['日常', '名詞'], related: ['meeting', 'date'],
      }),
    mk('w026', 'traffic', '交通；車流', 'noun', 'ˈtræfɪk',
      'Heavy traffic this morning. 今早車很多。', '日常', {
        tags: ['日常', '名詞'],
        etymology: 'Old Italian traffico. 首現 16 世紀。', syllables: 'traf·fic',
      }),
    mk('w027', 'dictionary', '字典；詞典', 'noun', 'ˈdɪkʃəneri',
      'Look it up in a dictionary. 查字典吧。', '日常', {
        tags: ['日常', '名詞'], forms: ['dictionaries'],
        syllables: 'dict·io·nary',
      }),
    mk('w028', 'abroad', '在國外；到國外', 'adverb', 'əˈbrɔːd',
      'She lives abroad. 她住在國外。', '日常', { tags: ['日常'] }),
    mk('w029', 'bargain', '便宜貨；討價還價', 'noun', 'ˈbɑːrɡən',
      'This bag was a bargain. 這個包很划算。', '日常', {
        tags: ['日常', '名詞'], related: ['deal'],
      }),
    mk('w030', 'ceiling', '天花板；上限', 'noun', 'ˈsiːlɪŋ',
      'The room has a high ceiling. 房間天花板很高。', '日常', {
        tags: ['日常', '名詞'],
      }),
    mk('w031', 'damp', '潮濕的', 'adjective', 'dæmp',
      'The towel is still damp. 毛巾還是濕的。', '日常', {
        tags: ['日常', '形容詞'], related: ['moist', 'humid'],
        synonym: 'moist, humid', antonym: 'dry, arid',
      }),
    mk('w032', 'eager', '渴望的；熱切的', 'adjective', 'ˈiːɡər',
      'Eager to learn. 渴望學習。', '日常', {
        tags: ['日常', '形容詞'], related: ['keen', 'enthusiastic'],
        synonym: 'keen, enthusiastic', antonym: 'indifferent, reluctant',
      }),
    mk('w033', 'fragrance', '香味；芬芳', 'noun', 'ˈfreɪɡrəns',
      'The fragrance of flowers. 花香。', '日常', {
        tags: ['日常', '名詞'], related: ['scent', 'aroma'],
        synonym: 'scent, aroma', antonym: 'stench, odor',
      }),
    mk('w034', 'grumble', '抱怨；嘟囔', 'verb', 'ˈɡrʌmbl',
      'He grumbled about the food. 他抱怨食物。', '日常', {
        tags: ['日常', '動詞'], related: ['complain', 'mutter'],
        synonym: 'complain, mutter',
      }),
    mk('w035', 'humble', '謙遜的；卑微的', 'adjective', 'ˈhʌmbl',
      'A humble beginning. 卑微的起點。', '日常', {
        tags: ['日常', '形容詞'], related: ['modest', 'unassuming'],
        synonym: 'modest, meek', antonym: 'proud, arrogant',
      }),
    mk('w036', 'inspire', '啟發；鼓舞', 'verb', 'ɪnˈspaɪər',
      'Her story inspires me. 她的故事鼓舞了我。', '日常', {
        tags: ['日常', '動詞'], related: ['motivate', 'encourage'], forms: ['inspired', 'inspiration'],
        synonym: 'motivate, encourage', antonym: 'discourage, daunt',
      }),
  ];

  decks = [
    { id: 'd-gre', name: 'GRE 核心', color: '#5e6ad2', newWeight: 1 },
    { id: 'd-toefl', name: '托福', color: '#0ea5e9', newWeight: 1 },
    { id: 'd-daily', name: '日常', color: '#22c55e', newWeight: 1 },
  ];
  folders = {};
  additions = [];
  settings = new Map([['tags', ['GRE', '托福', '日常', '動詞', '名詞', '形容詞']]]);
  filteredDecks = [];

  // 卡片：前 8 張複習中（部分已到期），中間 8 張全新待學，其餘排未來
  cards = new Map();
  const duePast = isoDaysAgo(1);
  const dueNow = new Date().toISOString();
  const dueFuture = new Date(Date.now() + 3 * 86400000).toISOString();
  words.forEach((w, i) => {
    if (i < 8) {
      cards.set(w.id, mkCard(i % 2 ? duePast : dueNow, isoDaysAgo(2), {
        state: 2, reps: 4 + i, stability: 3 + i * 0.5, difficulty: 4 + (i % 3),
        scheduledDays: 2, interval: 2, elapsedDays: 2,
      }));
    } else if (i < 16) {
      cards.set(w.id, mkCard(dueNow, null, { state: 0, reps: 0, stability: 2.5, scheduledDays: 0, interval: 0 }));
    } else {
      cards.set(w.id, mkCard(dueFuture, isoDaysAgo(1), {
        state: 2, reps: 6, stability: 8, difficulty: 3, scheduledDays: 4, interval: 4, elapsedDays: 1,
      }));
    }
  });

  // 複習紀錄：過去 7 天、每天數筆（三模式輪轉，確定性排程）
  reviewLogs = [];
  logSeq = 1;
  const modes = ['flip', 'mc', 'spell'];
  for (let d = 7; d >= 1; d--) {
    const n = 3 + (d % 3);
    for (let k = 0; k < n; k++) {
      const w = words[(d * 5 + k * 7) % words.length];
      reviewLogs.push({
        id: logSeq++,
        wordId: w.id,
        rating: 1 + ((d + k) % 4),
        duration: 3000 + ((d * 1000 + k * 500) % 9000),
        elapsedDays: 1, scheduledDays: 2 + (k % 4),
        stability: 2 + (k % 5), difficulty: 3 + ((d + k) % 5),
        reviewed_at: new Date(Date.now() - d * 86400000 + k * 3600000).toISOString(),
        state: (d + k) % 3 === 0 ? 0 : 2,
        newState: 2,
        ivl: 2 + (k % 4),
        mode: modes[(d + k) % 3],
      });
    }
  }

  examHistory = words.slice(0, 10).map((w, i) => ({
    word: w.id, correct: i % 3 !== 0 ? 1 : 0,
    questionType: ['flip', 'mc', 'spell'][i % 3],
    examinedAt: isoDaysAgo(i % 5),
  }));

  const today = new Date().toISOString().slice(0, 10);
  goalStreak = {
    dailyGoal: 20, current: 6, best: 15,
    dates: { flip: [today], mc: [today], spell: [] },
  };
}

// ─── Words ───
export async function getAllWords() { return words.map((w) => ({ ...w, tags: [...w.tags], related: [...w.related], forms: [...w.forms], examples: [...w.examples] })); }
export async function getWordCount() { return words.length; }
export async function saveWord(word) {
  const w = {
    id: word.id || `w-demo-${wordSeq++}`,
    word: word.word || '', definition: word.definition || '',
    pos: word.pos || '', pron: word.pron || '', example: word.example || '',
    deck: word.deck || 'Default', tags: [...(word.tags || [])],
    image: word.image || '', description: word.description || '',
    related: [...(word.related || [])], forms: [...(word.forms || [])],
    synonym: word.synonym || '', antonym: word.antonym || '',
    derivative: word.derivative || '', examples: [...(word.examples || [])],
    etymology: word.etymology || '', syllables: word.syllables || '',
    phrases: word.phrases || '',
    createdAt: word.createdAt || new Date().toISOString(),
  };
  const i = words.findIndex((x) => x.id === w.id);
  if (i >= 0) words[i] = w; else words.push(w);
}
export async function saveWordsInTx(list) { for (const w of list) await saveWord(w); }
export async function getImagesForWord() { return []; }
export async function getImagesForWords() { return new Map(); }
export async function addWordImage() {}
export async function deleteWordImage() {}
export async function deleteWordImagesForWord() {}
export async function deleteWord(id) {
  const w = words.find((x) => x.id === id);
  words = words.filter((x) => x.id !== id);
  cards.delete(id);
  reviewLogs = reviewLogs.filter((r) => r.wordId !== id);
  examHistory = examHistory.filter((e2) => e2.word !== id && (!w || e2.word !== w.word));
}
export async function bulkSaveWords(list) { words = []; for (const w of list) await saveWord(w); }

// ─── Cards ───
export async function getAllCards() { return new Map(cards); }
export async function getCard(wordId) { return cards.get(wordId) || null; }
export async function saveCard(wordId, card) { cards.set(wordId, { ...card }); }
export async function bulkSaveCards(list) { for (const [wid, c] of list) cards.set(wid, { ...c }); }
export async function deleteCard(wordId) { cards.delete(wordId); }

// ─── Decks / Folders / Additions ───
export async function getAllDecks() { return decks.map((d) => ({ ...d })); }
export async function saveDeck(deck) {
  const i = decks.findIndex((d) => d.id === deck.id);
  const row = { id: deck.id, name: deck.name, color: deck.color || '#5e6ad2', newWeight: deck.newWeight ?? 1 };
  if (i >= 0) decks[i] = row; else decks.push(row);
}
export async function deleteDeck(id) { decks = decks.filter((d) => d.id !== id); }
export async function deleteWordsByDeck(deckName) {
  const ids = new Set(words.filter((w) => w.deck === deckName).map((w) => w.id));
  words = words.filter((w) => w.deck !== deckName);
  for (const id of ids) {
    cards.delete(id);
    reviewLogs = reviewLogs.filter((r) => r.wordId !== id);
  }
  examHistory = examHistory.filter((e2) => !ids.has(e2.word));
}
export async function getAllFolders() { return { ...folders }; }
export async function saveFolders(f) { folders = { ...f }; }
export async function getAllAdditions() { return additions.map((a) => ({ ...a })); }
export async function bulkSaveAdditions(list) { additions = list.map((a) => ({ ...a })); }

// ─── Settings / Audit / Tags ───
export async function getSetting(key) { return settings.has(key) ? settings.get(key) : null; }
export async function setSetting(key, value) { settings.set(key, value); }
export async function addAudit() {}
export async function getAllTags() {
  const raw = await getSetting('tags');
  return Array.isArray(raw) ? raw : [];
}
export async function setAllTags(tags) { await setSetting('tags', tags); }

// ─── Review Log ───
export async function addReviewLog(entry) {
  reviewLogs.push({
    id: logSeq++,
    wordId: entry.wordId, rating: entry.rating,
    duration: entry.duration ?? null,
    elapsedDays: entry.elapsedDays ?? null, scheduledDays: entry.scheduledDays ?? null,
    stability: entry.stability ?? null, difficulty: entry.difficulty ?? null,
    reviewed_at: entry.reviewedAt || new Date().toISOString(),
    state: entry.state ?? null, newState: entry.newState ?? null,
    ivl: entry.scheduledDays ?? null, mode: entry.mode || 'flip',
  });
}
export async function getAllReviewLogs() { return reviewLogs.map((r) => ({ ...r })); }
function boundaryUtc(todayStart, dayCutoff, tzOffset) {
  const offset = tzOffset ?? -(new Date().getTimezoneOffset());
  const [y, m, d] = todayStart.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, dayCutoff || 0) - offset * 60000).toISOString();
}
export async function getNewRatedToday(mode, todayStart, dayCutoff = 0, tzOffset = null) {
  const b = boundaryUtc(todayStart, dayCutoff, tzOffset);
  return reviewLogs.filter((r) => r.mode === mode && r.state === 0 && r.reviewed_at >= b).length;
}
export async function getNewRatedTodayAll(todayStart, dayCutoff = 0, tzOffset = null) {
  const b = boundaryUtc(todayStart, dayCutoff, tzOffset);
  const out = { flip: 0, mc: 0, spell: 0 };
  for (const r of reviewLogs) {
    if (r.state === 0 && r.reviewed_at >= b && out[r.mode] !== undefined) out[r.mode]++;
  }
  return out;
}
export async function clearReviewLogs() { reviewLogs = []; }
export async function getMaxReviewLogId() { return reviewLogs.reduce((m, r) => Math.max(m, r.id), 0); }
export async function deleteReviewLogsAfter(id, mode) {
  const m = mode || 'flip';
  reviewLogs = reviewLogs.filter((r) => !(r.id > id && (r.mode || 'flip') === m));
}
export async function deleteLastReviewLog() {
  const m = await getMaxReviewLogId();
  reviewLogs = reviewLogs.filter((r) => r.id !== m);
}

// ─── Exam / Streak / Filtered / Misc ───
export async function addExamEntry(entry) {
  examHistory.push({
    word: entry.word, correct: entry.correct ? 1 : 0,
    questionType: entry.questionType || null,
    examinedAt: entry.examinedAt || new Date().toISOString(),
  });
}
export async function getAllExamHistory() { return examHistory.map((e2) => ({ ...e2 })); }
export async function getGoalStreak() {
  return goalStreak
    ? JSON.parse(JSON.stringify(goalStreak))
    : { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
}
export async function saveGoalStreak(data) { goalStreak = JSON.parse(JSON.stringify(data)); }
export async function getAllFilteredDecks() { return filteredDecks.map((d) => ({ ...d })); }
export async function saveFilteredDeck(deck) {
  const i = filteredDecks.findIndex((d) => d.id === deck.id);
  if (i >= 0) filteredDecks[i] = { ...deck }; else filteredDecks.push({ ...deck });
}
export async function updateFilteredDeckLastUsed(id) {
  const d = filteredDecks.find((x) => x.id === id);
  if (d) d.last_used = new Date().toISOString();
}
export async function deleteFilteredDeck(id) { filteredDecks = filteredDecks.filter((d) => d.id !== id); }
export async function executeSQL() { return []; }
export async function closeDB() {}
export async function checkpoint() {}
export async function clearAll() {
  words = []; cards = new Map(); decks = []; folders = {};
  additions = []; settings = new Map(); reviewLogs = [];
  examHistory = []; goalStreak = null; filteredDecks = [];
}
