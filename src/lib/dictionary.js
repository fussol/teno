import wordsText from '../assets/words.txt?raw';

let _dict = null;
let _byFirst = null;
let _byLen = null;

export function loadDictionary() {
  if (!_dict) {
    const words = wordsText.split('\n').filter(Boolean);
    _dict = new Set(words);
    // 建立索引供 edit-distance 還原：小寫 ascii 詞分桶
    _byFirst = new Map();
    _byLen = new Map();
    for (const raw of words) {
      const w = raw.toLowerCase();
      if (!/^[a-z]+$/.test(w)) continue;
      if (!_byFirst.has(w[0])) _byFirst.set(w[0], []);
      _byFirst.get(w[0]).push(w);
      if (!_byLen.has(w.length)) _byLen.set(w.length, []);
      _byLen.get(w.length).push(w);
    }
  }
  return Promise.resolve(_dict);
}

export function isKnownWord(word) {
  if (!_dict) return false;
  return _dict.has(word.toLowerCase().trim());
}

export function dictionarySize() {
  return _dict ? _dict.size : 0;
}

/** Damerau–Levenshtein：含相鄰換位（OCR 亂碼最常見「字母對調」），字串短＋差異僅 ≤2 */
function damerau(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 2) return 99;
  const d = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[la][lb];
}

/**
 * 離線 OCR 還原：亂碼 token → 最接近的真英文字。
 * 用 Damerau edit-distance 對本機字典找最近字（≤2 距離）。
 * 採「嚴格唯一」守門——距離最小且唯一領先才還原，歧義/找不到回 null（＝還原不了，呼叫方刪）。
 * @param {string} token 小寫亂碼 token
 * @param {number} [maxDist=2]
 * @returns {string|null} 還原的字，或 null（還原不確定／不存在）
 */
export function restoreFromDictionary(token, maxDist = 2) {
  if (!_dict) return null;
  const raw = String(token || '').toLowerCase().trim();
  if (!raw) return null;
  if (_dict.has(raw)) return raw;              // 已在字典 → 就是對的
  if (!/^[a-z]+$/.test(raw)) return null;      // 含非英字 → 不猜

  const best = [];
  const first = _byFirst.get(raw[0]);
  if (first) {
    for (const w of first) {
      if (Math.abs(w.length - raw.length) > 2) continue;
      const d = damerau(w, raw);
      if (d <= maxDist) best.push([d, w]);
    }
  }
  if (!best.length) {
    // 首字桶放寬（首字也可能 OCR 錯）：同長度桶掃
    for (let L = Math.max(1, raw.length - 2); L <= raw.length + 2; L++) {
      for (const w of _byLen.get(L) || []) {
        const d = damerau(w, raw);
        if (d <= maxDist) best.push([d, w]);
      }
    }
  }
  if (!best.length) return null;
  best.sort((a, b) => a[0] - b[0]);
  // 嚴格唯一：top1 距離 < top2 距離才採納（歧義不亂猜，交還「還原不了」刪除）
  if (best.length === 1 || best[0][0] < best[1][0]) return best[0][1];
  return null;
}
