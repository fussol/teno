// Card renderer for the independent study system.
// Produces HTML strings for card display, no DOM manipulation.

export const MODES = [
  { id: 'flashcard', label: '翻卡', icon: 'book', desc: '看單字 → 翻面 → 評分' },
  { id: 'quiz', label: '多選', icon: 'target', desc: '看單字，從選項中選定義' },
  { id: 'spelling', label: '拼寫', icon: 'pencil', desc: '看定義，拼出單字' },
  { id: 'listening', label: '聽寫', icon: 'headphone', desc: '聽發音，拼出單字' },
];

const MODE_LABEL = Object.fromEntries(MODES.map(m => [m.id, m.label]));
const MODE_ICON = Object.fromEntries(MODES.map(m => [m.id, m.icon]));

export class Renderer {
  constructor(session, { icon, speak, ttsAvailable, escapeHtml }) {
    this.s = session;
    this.icon = icon;
    this.speak = speak;
    this.ttsAvailable = ttsAvailable;
    this.escapeHtml = escapeHtml;
    this.flipped = false;
    this.answered = false;
    this.selectedIdx = null;
    this.lastCorrect = null;
    this.userInput = '';
    this.options = [];
    this.correctIdx = 0;
    this.previews = {};
    this.mode = 'flashcard';
  }

  resetCard() {
    this.flipped = false;
    this.answered = false;
    this.selectedIdx = null;
    this.lastCorrect = null;
    this.userInput = '';
    this.options = [];
    this.correctIdx = 0;
  }

  prepareCard() {
    this.resetCard();
    const card = this.s.current?.card;
    if (card) this.previews = this.s.previewIntervals(card.id) || {};
    if (this.mode === 'quiz' && this.s.current) {
      const { options, correctIdx } = this.buildQuiz();
      this.options = options;
      this.correctIdx = correctIdx;
    }
  }

  buildQuiz() {
    const correct = this.s.current.word;
    const cd = (correct.definition || correct.word || '').trim();
    const ck = cd.toLowerCase();
    const pool = this.s.words;
    const cand = pool.filter(x => x.id !== correct.id).map(x => (x.definition || x.word || '').trim()).filter(t => t && t.toLowerCase() !== ck);
    const seen = new Set([ck]);
    const distractors = cand.sort(() => Math.random() - 0.5).filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
    const wp = pool.filter(x => x.id !== correct.id).sort(() => Math.random() - 0.5);
    for (const w of wp) { if (distractors.length >= 3) break; const k = (w.definition || w.word || '').toLowerCase(); if (!seen.has(k)) { seen.add(k); distractors.push(w.definition || w.word); } }
    const options = [cd, ...distractors].sort(() => Math.random() - 0.5);
    return { options, correctIdx: options.findIndex(o => o.toLowerCase() === ck) };
  }

  renderSelect(filter, stats) {
    const due = this.s.queue.length;
    const { icon, escapeHtml: e } = this;
    if (stats.total === 0) {
      return `<div class="page-title">${icon('book')} 學習 (v2)</div><div class="page-subtitle">間隔重複學習 · 獨立引擎</div>
        <div class="review-empty"><div style="font-size:56px;margin-bottom:var(--s4);color:var(--text-disabled)">${icon('box')}</div>
          <h3>字庫是空的</h3><p>匯入 CSV 或新增單字後即可開始學習</p>
          <div style="margin-top:var(--s6);display:flex;gap:var(--s3);justify-content:center;flex-wrap:wrap">
            <button class="btn-primary" data-goto="settings">${icon('upload')} 匯入 CSV</button>
            <button class="btn" data-goto="browser">${icon('plus')} 新增單字</button></div></div>`;
    }
    if (due === 0) {
      const h = filter ? `${filter} 沒有待複習的單字` : '今日佇列已清空';
      return `<div class="page-title">${icon('book')} 學習 (v2)</div><div class="page-subtitle">間隔重複學習 · 獨立引擎</div>
        <div class="review-empty"><div style="font-size:56px;margin-bottom:var(--s4);color:var(--green)">${icon('check')}</div>
          <h3>${h}</h3><p>所有卡片都在進度中，明天再來吧</p>
          <div style="margin-top:var(--s6);display:flex;gap:var(--s3);justify-content:center;flex-wrap:wrap">
            ${filter ? `<button class="btn" id="s2ClearFilter">${icon('x')} 清除過濾</button>` : ''}
            <button class="btn-primary" data-goto="dashboard">${icon('arrowR')} 回儀表板</button></div></div>`;
    }
    const fc = filter ? `<button class="tag tag-accent" id="s2FilterChip">${icon('filter')} ${e(filter)} ${icon('x')}</button>` : '';
    return `<div class="page-title">${icon('book')} 學習 (v2)</div>
      <div class="page-subtitle" style="display:flex;align-items:center;gap:var(--s3);flex-wrap:wrap"><span>獨立學習引擎 · 間隔重複</span>${fc}</div>
      <div class="study-summary">
        <div class="study-stat"><span class="study-stat-ic" style="color:var(--rose);background:var(--rose-container)">${icon('clock')}</span><div><div class="study-stat-val">${due}</div><div class="study-stat-lbl">今日待複習</div></div></div>
        <div class="study-stat"><span class="study-stat-ic" style="color:var(--green);background:var(--green-container)">${icon('check')}</span><div><div class="study-stat-val">${stats.learned}</div><div class="study-stat-lbl">已學</div></div></div>
        <div class="study-stat"><span class="study-stat-ic" style="color:var(--cyan);background:var(--cyan-container)">${icon('brain')}</span><div><div class="study-stat-val">${stats.mature}</div><div class="study-stat-lbl">熟練</div></div></div></div>
      <div class="section-title" style="margin-bottom:var(--s4)">${icon('zap')} 選擇學習模式</div>
      <div class="study-mode-grid">${MODES.map(m => `<button class="study-mode-card" data-s2mode="${m.id}" ${m.id === 'listening' && !this.ttsAvailable() ? 'data-tts-warn="1"' : ''}><span class="study-mode-ic">${icon(m.icon)}</span><span class="study-mode-label">${m.label}</span><span class="study-mode-desc">${m.desc}</span></button>`).join('')}</div>`;
  }

  renderSession() {
    const { icon: ic, escapeHtml: e } = this;
    const card = this.s.current;
    if (!card) return this.renderSummary();
    const word = card.word;
    const mode = this.mode;
    const total = this.s.queue.length;
    const pct = total > 0 ? Math.round((this.s.results.length / total) * 100) : 0;
    let body = '';
    if (mode === 'flashcard') body = this.renderFlashcard(word);
    else if (mode === 'quiz') body = this.renderQuiz(word);
    else if (mode === 'spelling') body = this.renderSpelling(word);
    else if (mode === 'listening') body = this.renderListening(word);
    return `<div class="exam-session">
      <div class="exam-header"><span class="tag tag-accent">${ic(MODE_ICON[mode])} ${MODE_LABEL[mode]}</span><button class="btn btn-ghost" id="s2ExitBtn">${ic('x')} 結束</button></div>
      <div class="review-progress-bar"><div class="review-progress-fill" style="width:${pct}%"></div></div>
      <div class="exam-progress" style="text-align:center;margin:var(--s3) 0"><span class="tnum">${this.s.results.length + 1}</span><span style="color:var(--text-disabled)">·</span><span>已完成 <span class="tnum" style="color:var(--green);font-weight:700">${this.s.results.length}</span></span></div>
      <div class="review-card-wrap"><div class="review-card" style="min-height:360px;padding:var(--s12) var(--s10)">${body}${this.renderRatingRow()}</div></div></div>`;
  }

  renderFlashcard(word) {
    const show = this.flipped;
    const e = this.escapeHtml;
    return `<div class="review-pos">${e(word.pos || '—')}</div><div class="review-pron">${e(word.pron || '')}</div>
      <button class="review-audio" id="s2AudioBtn" title="發音">${this.icon('volume')}</button>
      <div class="review-word">${e(word.word)}</div>
      <div class="review-meaning" id="s2Meaning" style="display:${show ? 'block' : 'none'}">${e(word.definition || '<span class="muted">（無定義）</span>')}${word.example ? `<div class="review-example" style="display:${show ? 'block' : 'none'}">「${e(word.example)}」</div>` : ''}</div>
      ${!show ? `<button class="review-flip-btn" id="s2FlipBtn">${this.icon('eye')} 顯示答案</button>` : ''}`;
  }

  renderQuiz(word) {
    const e = this.escapeHtml;
    return `<div class="review-word" style="font-size:36px">${e(word.word)}</div>
      ${word.pron ? `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s3);font-family:var(--mono)">${e(word.pron)}</div>` : ''}
      <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:var(--s4)">選出正確的定義</div>
      <div class="options-grid" id="s2Options">${this.options.map((opt, i) => { let cls = 'option-btn'; if (this.answered) { if (i === this.correctIdx) cls += ' correct'; else if (i === this.selectedIdx) cls += ' wrong'; } return `<button class="${cls}" data-s2opt="${i}" ${this.answered ? 'disabled' : ''}>${e(opt)}</button>`; }).join('')}</div>${this.answered ? this.verdict() : ''}`;
  }

  renderSpelling(word) {
    const e = this.escapeHtml;
    return `<div class="review-word" style="font-size:24px;max-width:520px">${e(word.definition || '（無定義）')}</div>
      ${word.pos ? `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s2)">${e(word.pos)}</div>` : ''}
      ${word.example ? `<div style="font-size:13px;color:var(--text-tertiary);font-style:italic;margin-bottom:var(--s4);max-width:480px;text-align:center">「${e(word.example)}」</div>` : ''}
      <input class="card-input" id="s2Input" placeholder="輸入英文..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ${this.answered ? 'disabled' : ''}>
      ${!this.answered ? `<button class="btn-primary" id="s2SubmitBtn" style="margin-top:var(--s4)">${this.icon('arrowR')} 送出</button>` : this.verdict()}`;
  }

  renderListening(word) {
    const e = this.escapeHtml;
    return `<div class="review-word" style="font-size:24px">${this.answered ? e(word.word) : '點擊喇叭聽發音'}</div>
      <button class="review-audio" id="s2AudioBtn" style="position:static;width:56px;height:56px;font-size:26px;margin:var(--s3) 0;display:flex">${this.icon('volume')}</button>
      <input class="card-input" id="s2Input" placeholder="輸入聽到的單字..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ${this.answered ? 'disabled' : ''}>
      ${!this.answered ? `<button class="btn-primary" id="s2SubmitBtn" style="margin-top:var(--s4)">${this.icon('arrowR')} 送出</button>` : this.verdict()}`;
  }

  verdict() {
    const ok = this.lastCorrect;
    const userAns = this.userInput || (this.selectedIdx != null ? this.options[this.selectedIdx] : '');
    const card = this.s.current?.word;
    const e = this.escapeHtml;
    return `<div style="margin-top:var(--s4);text-align:center;width:100%">
      <div style="font-size:16px;font-weight:700;color:${ok ? 'var(--green)' : 'var(--red)'};margin-bottom:var(--s2)">${ok ? this.icon('check') + ' 正確' : this.icon('x') + ' 錯誤'}</div>
      ${!ok && this.mode !== 'quiz' ? `<div style="font-size:14px;color:var(--text-secondary);margin-bottom:var(--s2)">正確答案：<b style="color:var(--text-primary)">${e(card?.word || '')}</b>${userAns ? ` <span style="color:var(--text-tertiary)">· 你答：${e(userAns)}</span>` : ''}</div>` : ''}</div>`;
  }

  renderRatingRow() {
    const show = this.mode === 'flashcard' ? this.flipped : this.answered;
    if (!show) return '';
    const p = this.previews;
    return `<div class="review-buttons" style="display:flex;margin-top:var(--s4)">
      <button class="review-btn btn-again" data-s2rate="0">Again<span class="btn-interval">${this.s.formatInterval(p[0] || 1)}</span></button>
      <button class="review-btn btn-hard" data-s2rate="1">Hard<span class="btn-interval">${this.s.formatInterval(p[1] || 1)}</span></button>
      <button class="review-btn btn-good" data-s2rate="2">Good<span class="btn-interval">${this.s.formatInterval(p[2] || 1)}</span></button>
      <button class="review-btn btn-easy" data-s2rate="3">Easy<span class="btn-interval">${this.s.formatInterval(p[3] || 1)}</span></button></div>`;
  }

  renderSummary() {
    const rs = this.s.results;
    const total = rs.length;
    const correct = rs.filter(r => r.rating >= 2).length;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const avgMs = total > 0 ? rs.reduce((a, r) => a + (r.timeMs || 0), 0) / total : 0;
    const fmtMs = ms => { const s = ms / 1000; return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's'; };
    let grade = '再接再厲', gc = 'var(--red)';
    if (pct >= 90) { grade = '優秀！'; gc = 'var(--green)'; } else if (pct >= 75) { grade = '很好'; gc = 'var(--green)'; } else if (pct >= 60) { grade = '及格'; gc = 'var(--amber)'; } else if (pct >= 40) { grade = '加油'; gc = 'var(--orange)'; }
    const wrong = rs.filter(r => r.rating < 2);
    return `<div class="page-title">${this.icon('book')} 學習完成 (v2)</div><div class="page-subtitle">${MODE_LABEL[this.mode]} · 本次 ${total} 張</div>
      <div class="hero" style="text-align:center"><div class="hero-glow"></div><div class="hero-content">
        <div class="hero-pct ${pct >= 60 ? 'done' : ''}" style="font-size:72px;color:${gc}">${total > 0 ? pct + '<span class="unit">%</span>' : '—'}</div>
        <div class="hero-label" style="margin-top:var(--s2)">${grade}</div>
        <div style="display:flex;justify-content:center;gap:var(--s8);margin-top:var(--s6)">
          <div><div style="font-size:28px;font-weight:800;color:var(--green);font-feature-settings:'tnum'">${correct}</div><div style="font-size:11px;color:var(--text-tertiary);font-weight:600;text-transform:uppercase;letter-spacing:.06em">正確</div></div>
          <div><div style="font-size:28px;font-weight:800;color:var(--red);font-feature-settings:'tnum'">${total - correct}</div><div style="font-size:11px;color:var(--text-tertiary);font-weight:600;text-transform:uppercase;letter-spacing:.06em">錯誤</div></div>
          <div><div style="font-size:28px;font-weight:800;color:var(--accent);font-feature-settings:'tnum'">${fmtMs(avgMs)}</div><div style="font-size:11px;color:var(--text-tertiary);font-weight:600;text-transform:uppercase;letter-spacing:.06em">平均反應</div></div></div></div></div>
      ${wrong.length > 0 && this.mode !== 'flashcard' ? `<div class="section"><div class="section-title" style="color:var(--red)">${this.icon('x')} 錯誤題目（${wrong.length}）</div><div class="word-list">${wrong.map(r => `<div class="word-row" style="cursor:default"><span class="word-row-word">${this.escapeHtml(r.word)}</span><span class="word-row-def"></span>${r.userAnswer ? `<span class="tag tag-rose" style="margin-left:auto">你答：${this.escapeHtml(r.userAnswer)}</span>` : ''}</div>`).join('')}</div></div>` : ''}
      <div style="display:flex;gap:var(--s3);justify-content:center;flex-wrap:wrap;margin-top:var(--s4)">
        <button class="btn-primary" id="s2ContinueBtn">${this.icon('refresh')} 繼續學習</button>
        <button class="btn" id="s2HomeBtn">${this.icon('home')} 回儀表板</button></div>`;
  }
}
