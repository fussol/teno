import { toast } from './toast.js';

const STUDY_MSGS = [
  { at: 5, msg: '🌱 5 cards — a seed of knowledge!' },
  { at: 10, msg: '📚 10 cards — warming up!' },
  { at: 25, msg: '⚡ 25 cards — getting serious!' },
  { at: 50, msg: '🔥 50 cards — on fire!' },
  { at: 100, msg: '💪 100 cards — you\'re a machine!' },
  { at: 200, msg: '🏆 200 cards — unstoppable!' },
];

// G4b: 終生制＋持久化 — 計數源=_totalRated（生涯累計，G4 寫入端）；
// 進度態 _eggsShown 落 localStorage，重啟不歸零不重播。
// 語意定案（G4b 計畫書 §3.3/3.4）：訊息=降序最高已達節點一跳＋lastMsgAt 跳頂
// （中間節點永久跳過）；里程碑=升序逐條補放（每次呼叫一條）。
function lifetimeRated() {
  try {
    const n = Number.parseInt(localStorage.getItem('_totalRated') || '0', 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function readShown() {
  try {
    const o = JSON.parse(localStorage.getItem('_eggsShown') || 'null');
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { lastMsgAt: -1, milestones: [] };
    return {
      lastMsgAt: Number.isFinite(o.lastMsgAt) ? o.lastMsgAt : -1,
      milestones: Array.isArray(o.milestones) ? o.milestones : [],
    };
  } catch { return { lastMsgAt: -1, milestones: [] }; }
}

function writeShown(s) {
  try { localStorage.setItem('_eggsShown', JSON.stringify(s)); } catch { /* 無痕模式：降級回重啟重播，一次性接受 */ }
}

export function checkStudyMessages() {
  const total = lifetimeRated();
  const shown = readShown();
  if (total <= shown.lastMsgAt) return;
  // G4b: 觸發雙條件 total >= m.at && m.at > lastMsgAt（已放過節點永不重放）；
  // 非節點遞進（5→7）零放、靜默跳標。
  let hit = null;
  for (let i = STUDY_MSGS.length - 1; i >= 0; i--) {
    const m = STUDY_MSGS[i];
    if (total >= m.at && m.at > shown.lastMsgAt) { hit = m; break; }
  }
  shown.lastMsgAt = total;
  writeShown(shown);
  if (hit) toast(hit.msg, 'toast-easter');
}

export function checkMilestone() {
  const total = lifetimeRated();
  const shown = readShown();
  const milestones = [100, 500, 1000, 5000];
  for (const m of milestones) {
    if (total >= m && !shown.milestones.includes(m)) {
      // G4b: 升序逐條補放，每次呼叫一條（儀式價值，最多 4 條封頂）
      shown.milestones.push(m);
      writeShown(shown);
      showMilestone(m);
      return;
    }
  }
}

function showMilestone(m) {
  const el = document.createElement('div');
  el.className = 'milestone-overlay';
  el.innerHTML = `<div class="milestone-inner"><div class="milestone-emoji">🎉</div><div class="milestone-title">${m} Cards Studied!</div><div class="milestone-sub">Keep going!</div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 2800);
}

export function checkAchievement(id, threshold, label) {
  const done = JSON.parse(localStorage.getItem('_achievements') || '{}');
  if (done[id]) return;
  const results = JSON.parse(localStorage.getItem('_totalRated') || '0');
  if (results >= threshold) {
    done[id] = true;
    localStorage.setItem('_achievements', JSON.stringify(done));
    toast(`🏅 Achievement: ${label}!`, 'toast-easter');
  }
}

let _konamiPos = 0;
const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];

export function initKonami() {
  document.addEventListener('keydown', (e) => {
    const key = e.key === 'b' || e.key === 'B' ? 'b' : e.key === 'a' || e.key === 'A' ? 'a' : e.key;
    if (key === KONAMI[_konamiPos]) {
      _konamiPos++;
      if (_konamiPos >= KONAMI.length) {
        _konamiPos = 0;
        triggerKonami();
      }
    } else {
      _konamiPos = 0;
    }
  });
}

function triggerKonami() {
  const overlay = document.createElement('div');
  overlay.className = 'konami-overlay';
  overlay.innerHTML = '<div class="konami-text">🎊 KONAMI CODE! 🎊</div>';
  document.body.appendChild(overlay);
  spawnConfetti();
  setTimeout(() => overlay.remove(), 5000);
}

function spawnConfetti() {
  const colors = ['#ff0','#f0f','#0ff','#f00','#0f0','#00f','#ff8800','#ff0088'];
  for (let i = 0; i < 80; i++) {
    const c = document.createElement('div');
    c.className = 'konami-confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[Math.random() * colors.length | 0];
    c.style.animationDuration = (1.5 + Math.random() * 2) + 's';
    c.style.animationDelay = Math.random() * 0.5 + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
}
