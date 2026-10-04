// settings/deck-manager.js — 牌組管理渲染＋綁定＋浮層（P4 Step4 純搬移）
// 原 settings.js 兩段：renderDeckManager/renderFilteredDecks ＋ bindDeckManager 及 modal 群
import { pageRoot, renderInPlace, getDeckPalette, escapeHtml, escapeAttr } from '../settings.js'; // 循環引用：執行期取值
import { icon } from '../../lib/svg.js';
import { toast } from '../../lib/toast.js';

export function renderDeckManager(s) {
  const { decks, words } = s.state;
  // KEEPALIVE1-PERF1：原式在 decks.map() 裡逐字本 words.filter() → O(decks × words)
  // （16 字本 × 4921 詞 ≈ 7.9 萬次帶閉包迭代）。改成一次 O(words) 統計，輸出相同。
  const deckCount = new Map();
  for (const w of words) deckCount.set(w.deck, (deckCount.get(w.deck) || 0) + 1);
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('book')} 字本管理</div>
        <button class="btn btn-sm" id="deckAddBtn">${icon('plus')} 新增字本</button>
      </div>
      <div class="config-section">
        ${decks.length === 0 ? `
          <div style="text-align:center;padding:var(--s6);color:var(--text-tertiary);font-size:13px">
            尚無字本，點擊「新增字本」建立
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:var(--s2);padding:0 var(--s1)">
            ${decks.map((d, i) => {
              const count = deckCount.get(d.name) || 0;
              const first = i === 0;
              const last = i === decks.length - 1;
              return `
                <div class="deck-mgr-row" data-deck-id="${escapeAttr(d.id)}">
                  <span class="deck-mgr-dot" style="background:${d.color};box-shadow:0 0 6px ${d.color}"></span>
                  <span class="deck-mgr-name">${escapeHtml(d.name)}</span>
                  <span class="deck-mgr-count">${count} 詞</span>
                  <div class="deck-mgr-actions">
                    <button class="btn btn-ghost btn-sm" data-deck-action="move-up" data-deck-id="${escapeAttr(d.id)}" title="上移" ${first ? 'disabled style="opacity:0.3"' : ''}>${icon('chevronU')}</button>
                    <button class="btn btn-ghost btn-sm" data-deck-action="move-down" data-deck-id="${escapeAttr(d.id)}" title="下移" ${last ? 'disabled style="opacity:0.3"' : ''}>${icon('chevronD')}</button>
                    <button class="btn btn-ghost btn-sm" data-deck-action="merge" data-deck-id="${escapeAttr(d.id)}" title="合併">${icon('shuffle')}</button>
                    <button class="btn btn-ghost btn-sm" data-deck-action="edit" data-deck-id="${escapeAttr(d.id)}" title="編輯">${icon('edit')}</button>
                    <button class="btn btn-ghost btn-sm danger" data-deck-action="delete" data-deck-id="${escapeAttr(d.id)}" title="刪除">${icon('trash')}</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

// ─── 單字列表（搜尋、編輯、刪除，可收納）────────
export function renderFilteredDecks(s) {
  const { filteredDecks } = s.state;
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('filter')} 過濾牌組</div>
        <button class="btn btn-sm" id="filteredDeckAddBtn">${icon('plus')} 新增</button>
      </div>
      <div class="config-section">
        ${filteredDecks.length === 0 ? `
          <div style="text-align:center;padding:var(--s6);color:var(--text-tertiary);font-size:13px">
            尚無過濾牌組。過濾牌組可讓您依條件篩選卡片進行專項複習。
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:var(--s2)">
            ${filteredDecks.map(fd => `
              <div class="deck-mgr-row" data-fd-id="${escapeAttr(fd.id)}">
                <span class="deck-mgr-dot" style="background:${fd.color || '#f59e0b'};box-shadow:0 0 6px ${fd.color || '#f59e0b'}"></span>
                <span class="deck-mgr-name">${escapeHtml(fd.name)}</span>
                <span class="deck-mgr-count" style="font-size:11px;color:var(--text-tertiary)">${escapeHtml(fd.search_query)}</span>
                <div class="deck-mgr-actions">
                  <button class="btn btn-ghost btn-sm" data-fd-action="edit" data-fd-id="${escapeAttr(fd.id)}" title="編輯">${icon('edit')}</button>
                  <button class="btn btn-ghost btn-sm danger" data-fd-action="delete" data-fd-id="${escapeAttr(fd.id)}" title="刪除">${icon('trash')}</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

// ─── 設定頁收合（整頓：標題常駐＋內容下拉，狀態記 localStorage）───
// 設計：render 零改動（以後加新 section 自動跟上）；onMount 枚举頂層 .section
// 掛 .collapsible；內嵌（匯入／匯出／標籤頁自己的子 section）保持展開。
// ACCORDION1：**一次只能展開一個**（使用者指定「不可同時有兩個同時下拉」）。

export function bindDeckManager(s) {
  const addBtn = document.getElementById('deckAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => openDeckModal(s, null));

  document.querySelectorAll('[data-deck-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.deckId;
      const action = btn.dataset.deckAction;
      if (action === 'move-up') { await s.actions.moveDeck(id, -1); renderInPlace(s); return; }
      if (action === 'move-down') { await s.actions.moveDeck(id, 1); renderInPlace(s); return; }
      const deck = s.state.decks.find(d => d.id === id);
      if (!deck) return;
      if (action === 'edit') openDeckModal(s, deck);
      else if (action === 'delete') confirmDeleteDeck(s, deck);
      else if (action === 'merge') openMergeModal(s, deck);
    });
  });

}

function openDeckModal(s, deck) {
  const isEdit = !!deck;
  const container = pageRoot();
  if (!container) return;
  document.getElementById('deckModal')?.remove();

  const html = `
    <div class="modal-overlay open" id="deckModal">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <div class="modal-title">${icon(isEdit ? 'edit' : 'plus')} ${isEdit ? '編輯字本' : '新增字本'}</div>
          <button class="modal-close" id="deckModalClose">${icon('x')}</button>
        </div>
        <div class="form-group">
          <label class="form-label">字本名稱 *</label>
          <input class="form-input" id="deckName" placeholder="TOEFL 5000" value="${escapeAttr(deck?.name || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">顏色</label>
          <div style="display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center">
            ${getDeckPalette(s).slice(0, 8).map(c => `
              <button type="button" class="color-swatch" data-color="${c}" style="background:${c}"
                aria-label="選擇顏色 ${c}"></button>
            `).join('')}
            <label class="color-swatch color-swatch-custom" title="自訂顏色">
              ${icon('sliders')}
              <input type="color" id="deckColorCustom" value="${deck?.color || '#b69dff'}">
            </label>
            <span style="font-family:var(--mono);font-size:11px;color:var(--text-tertiary);margin-left:var(--s1)" id="deckColorLabel">${deck?.color || '#b69dff'}</span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">新卡權重 <span style="font-size:11px;color:var(--text-tertiary)">（DW1）</span></label>
          <input class="form-input" id="deckNewWeight" type="number" min="0" max="100" step="0.5" value="${deck?.newWeight ?? 1}" style="width:100px">
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">1 = 正常隨機；越高，這本的新卡越容易被抽到；0 = 今天不出這本的新卡（既有卡複習不受影響）</div>
        </div>
        <div class="modal-footer">
          ${isEdit ? `<button class="btn btn-danger" id="deckModalDelete" style="margin-right:auto">${icon('trash')} 刪除</button>` : ''}
          <button class="btn" id="deckModalCancel">取消</button>
          <button class="btn-primary" id="deckModalSave">${icon('check')} ${isEdit ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);

  let chosenColor = deck?.color || '#b69dff';
  const colorLabel = document.getElementById('deckColorLabel');
  const setColor = (c) => {
    chosenColor = c;
    if (colorLabel) colorLabel.textContent = c;
    container.querySelectorAll('.color-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.color === c);
    });
  };
  setColor(chosenColor);

  container.querySelectorAll('.color-swatch[data-color]').forEach(sw => {
    sw.addEventListener('click', () => setColor(sw.dataset.color));
  });
  const custom = document.getElementById('deckColorCustom');
  if (custom) custom.addEventListener('input', () => setColor(custom.value));

  const close = () => document.getElementById('deckModal')?.remove();
  document.getElementById('deckModalClose')?.addEventListener('click', close);
  document.getElementById('deckModalCancel')?.addEventListener('click', close);
  document.getElementById('deckModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'deckModal') close();
  });

  document.getElementById('deckModalSave')?.addEventListener('click', async () => {
    const name = document.getElementById('deckName')?.value.trim();
    if (!name) { toast('請輸入字本名稱', 'toast-error'); return; }
    // 檢查重複名稱
    const dup = s.state.decks.find(d => d.name.toLowerCase() === name.toLowerCase() && d.id !== deck?.id);
    if (dup) { toast('已有同名字本', 'toast-error'); return; }
    // DW1: 新卡權重 — Number.isFinite 防呆（parseFloat+?? 接不住 NaN），clamp [0,100]
    const rawW = parseFloat(document.getElementById('deckNewWeight')?.value);
    const newWeight = Number.isFinite(rawW) ? Math.min(100, Math.max(0, rawW)) : 1;

    if (isEdit && deck) {
      await s.actions.updateDeck(deck.id, { name, color: chosenColor, newWeight });
      toast(`已更新字本「${name}」`, 'toast-success');
    } else {
      await s.actions.createDeck(name, chosenColor, newWeight);
      toast(`已建立字本「${name}」`, 'toast-success');
    }
    close();
    renderInPlace(s);
  });

  if (isEdit) {
    document.getElementById('deckModalDelete')?.addEventListener('click', async () => {
      if (!deck) return;
      await s.actions.deleteDeck(deck.id);
      toast(`已刪除字本「${deck.name}」及其中所有單字`, 'toast-success');
      close();
      renderInPlace(s);
    });
  }
}

async function confirmDeleteDeck(s, deck) {
  const count = s.state.words.filter(w => w.deck === deck.name).length;
  const msg = count > 0
    ? `確定要刪除字本「${deck.name}」？內含 ${count} 個單字將一併刪除。`
    : `確定要刪除字本「${deck.name}」？`;
  if (!confirm(msg)) return;
  await s.actions.deleteDeck(deck.id);
  toast(`已刪除字本「${deck.name}」`, 'toast-success');
  renderInPlace(s);
}

function openMergeModal(s, srcDeck) {
  const others = s.state.decks.filter(d => d.id !== srcDeck.id);
  const html = `
    <div class="modal-overlay open" id="mergeModal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${icon('shuffle')} 合併字本</div>
          <button class="modal-close" id="mergeModalClose">${icon('x')}</button>
        </div>
        <div style="padding:var(--s4) 0">
          <div style="font-size:13px;color:var(--text-primary);margin-bottom:var(--s4);font-weight:600">
            ${escapeHtml(srcDeck.name)} <span style="color:var(--text-tertiary)">(${s.state.words.filter(w => w.deck === srcDeck.name).length} 詞)</span>
          </div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s3)">合併到哪個字本？</div>
          <select id="mergeTargetSelect" class="form-input" style="width:100%">
            ${others.map(d => `<option value="${escapeAttr(d.id)}">${escapeHtml(d.name)} (${s.state.words.filter(w => w.deck === d.name).length} 詞)</option>`).join('')}
          </select>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:var(--s3)">來源字本的單字和學習進度都會保留，僅變更所屬字本名稱。</div>
        </div>
        <div class="modal-footer">
          <button class="btn" id="mergeModalCancel">取消</button>
          <button class="btn-primary" id="mergeModalConfirm">${icon('shuffle')} 合併</button>
        </div>
      </div>
    </div>`;
  const container = pageRoot();
  container.insertAdjacentHTML('beforeend', html);
  const close = () => document.getElementById('mergeModal')?.remove();
  document.getElementById('mergeModalClose')?.addEventListener('click', close);
  document.getElementById('mergeModalCancel')?.addEventListener('click', close);
  document.getElementById('mergeModal')?.addEventListener('click', e => { if (e.target.id === 'mergeModal') close(); });
  document.getElementById('mergeModalConfirm')?.addEventListener('click', async () => {
    const targetId = document.getElementById('mergeTargetSelect')?.value;
    if (!targetId) return;
    const target = s.state.decks.find(d => d.id === targetId);
    if (!target) return;
    await s.actions.mergeDeck(srcDeck.id, targetId);
    close();
    toast(`已將「${srcDeck.name}」合併至「${target.name}」`, 'toast-success');
    renderInPlace(s);
  });
}

// ─── 過濾牌組 Modal ─────────────────────────────
function showFilteredDeckModal(s, fd = null) {
  const isEdit = !!fd;
  const container = pageRoot();
  if (!container) return;

  const html = `
    <div class="modal-overlay open" id="fdModal">
      <div class="modal">
        <div class="modal-header">
          <h3>${isEdit ? '編輯過濾牌組' : '新增過濾牌組'}</h3>
          <button class="btn btn-ghost" id="fdModalClose">${icon('x')}</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--s3);padding:var(--s4) 0">
          <div>
            <label class="form-label">名稱</label>
            <input type="text" id="fdName" class="form-input" value="${escapeAttr(fd?.name || '')}" placeholder="例如：困難卡片">
          </div>
          <div>
            <label class="form-label">搜尋條件</label>
            <input type="text" id="fdQuery" class="form-input" value="${escapeAttr(fd?.search_query || '')}" placeholder="is:due deck:TOEFL tag:hard">
            <div style="margin-top:var(--s1);font-size:11px;color:var(--text-tertiary)">
              支援：is:due, is:new, is:learning, is:review, deck:名稱, tag:標籤, lapses:>5, props:ivl>30
            </div>
          </div>
          <div style="display:flex;gap:var(--s3)">
            <div style="flex:1">
              <label class="form-label">最多卡片數</label>
              <input type="number" id="fdMaxCards" class="form-input" value="${fd?.max_cards || 100}" min="1" max="1000">
            </div>
            <div style="flex:1">
              <label class="form-label">排序方式</label>
              <select id="fdOrderBy" class="form-input">
                <option value="due" ${fd?.order_by === 'due' ? 'selected' : ''}>到期時間</option>
                <option value="random" ${fd?.order_by === 'random' ? 'selected' : ''}>隨機</option>
                <option value="added" ${fd?.order_by === 'added' ? 'selected' : ''}>加入時間</option>
                <option value="interval" ${fd?.order_by === 'interval' ? 'selected' : ''}>間隔天數</option>
                <option value="lapses" ${fd?.order_by === 'lapses' ? 'selected' : ''}>遺忘次數</option>
              </select>
            </div>
          </div>
          <div>
            <label class="form-label">顏色</label>
            <div style="display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap">
              <input type="color" id="fdColor" class="form-input" value="${escapeAttr(fd?.color || '#f59e0b')}" style="width:60px">
              <span id="fdColorLabel" style="font-size:12px;color:var(--text-tertiary)">${escapeHtml(fd?.color || '#f59e0b')}</span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          ${isEdit ? `<button class="btn btn-danger" id="fdModalDelete" style="margin-right:auto">${icon('trash')} 刪除</button>` : ''}
          <button class="btn" id="fdModalCancel">取消</button>
          <button class="btn-primary" id="fdModalSave">${icon('check')} ${isEdit ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);

  const colorInput = document.getElementById('fdColor');
  const colorLabel = document.getElementById('fdColorLabel');
  if (colorInput && colorLabel) {
    colorInput.addEventListener('input', () => {
      colorLabel.textContent = colorInput.value;
    });
  }

  const close = () => document.getElementById('fdModal')?.remove();
  document.getElementById('fdModalClose')?.addEventListener('click', close);
  document.getElementById('fdModalCancel')?.addEventListener('click', close);
  document.getElementById('fdModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'fdModal') close();
  });

  document.getElementById('fdModalSave')?.addEventListener('click', async () => {
    const name = document.getElementById('fdName')?.value.trim();
    const query = document.getElementById('fdQuery')?.value.trim();
    const maxCards = parseInt(document.getElementById('fdMaxCards')?.value) || 100;
    const orderBy = document.getElementById('fdOrderBy')?.value || 'due';
    const color = document.getElementById('fdColor')?.value || '#f59e0b';

    if (!name) { toast('請輸入名稱', 'toast-error'); return; }
    if (!query) { toast('請輸入搜尋條件', 'toast-error'); return; }

    const data = { name, search_query: query, max_cards: maxCards, order_by: orderBy, color };

    if (isEdit && fd) {
      data.id = fd.id;
      await s.actions.updateFilteredDeck(fd.id, data);
      toast(`已更新過濾牌組「${name}」`, 'toast-success');
    } else {
      await s.actions.createFilteredDeck(data);
      toast(`已建立過濾牌組「${name}」`, 'toast-success');
    }
    close();
    renderInPlace(s);
  });

  if (isEdit) {
    document.getElementById('fdModalDelete')?.addEventListener('click', async () => {
      if (!fd) return;
      if (!confirm(`確定要刪除過濾牌組「${fd.name}」？`)) return;
      await s.actions.deleteFilteredDeck(fd.id);
      toast(`已刪除過濾牌組「${fd.name}」`, 'toast-success');
      close();
      renderInPlace(s);
    });
  }

  // ponytail: inline onclick broken in WebKitGTK, use addEventListener
  document.querySelectorAll('button[onclick]').forEach(btn => {
    const m = btn.getAttribute('onclick')?.match(/window\.__(\w+)\(/);
    if (m && typeof window['__' + m[1]] === 'function') {
      btn.addEventListener('click', window['__' + m[1]]);
      btn.removeAttribute('onclick');
    }
  });
}

// ─── 匯入事件綁定 ──────────────────────────────
// ─── 重新渲染當頁（保留搜尋狀態）─────────────
