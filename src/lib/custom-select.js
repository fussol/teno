export function initCustomSelects(root) {
  ensureGlobalDocListener();   // G5: 確保 document listener 只綁一次
  root.querySelectorAll('select').forEach(el => {
    if (el.dataset.cs) return;
    el.dataset.cs = '1';
    build(el);
  });
}

// G5: document-level capture click 只註冊一次（防每 build 一個 select 累積 listener），
// 由 _openWraps 追蹤所有開啟 wrap，點外空白一次全關。
let _globalDocBound = false;
function ensureGlobalDocListener() {
  if (_globalDocBound) return;
  _globalDocBound = true;
  document.addEventListener('click', (_e) => {
    for (const w of _csOpenWraps) {
      if (w._csOpen && !w.contains(_e.target)) {
        const m = w.querySelector('.cs-menu');
        const t = w.querySelector('.cs-trigger');
        if (m) m.classList.remove('open');
        w.classList.remove('open');
        if (t) t.setAttribute('aria-expanded', 'false');
        w._csOpen = false;
      }
    }
  }, { capture: true });
}
const _csOpenWraps = new Set();

function build(select) {
  const wrap = document.createElement('div');
  wrap.className = 'cs-wrap';

  const trigger = document.createElement('button');
  trigger.className = 'cs-trigger';
  trigger.type = 'button';

  const label = document.createElement('span');
  label.className = 'cs-label';

  const chevron = document.createElement('span');
  chevron.className = 'cs-chevron';
  chevron.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';

  trigger.appendChild(label);
  trigger.appendChild(chevron);

  const menu = document.createElement('div');
  menu.className = 'cs-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('id', 'cs-menu-' + (select.id || '') + '-' + Math.random().toString(36).slice(2, 8));

  let lastGrp;
  Array.from(select.children).forEach(child => {
    if (child.tagName === 'OPTGROUP') {
      const h = document.createElement('div');
      h.className = 'cs-optgroup';
      h.textContent = child.label;
      menu.appendChild(h);
      lastGrp = child;
      Array.from(child.children).forEach(opt => addOption(opt, select, label, menu, wrap));
    } else if (child.tagName === 'OPTION') {
      addOption(child, select, label, menu, wrap);
    }
  });

  wrap.appendChild(trigger);
  wrap.appendChild(menu);

  label.textContent = select.options[select.selectedIndex]?.text || '';

  // G13: aria 標記 + 鍵盤狀態
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menu.id || undefined);

  function options() { return Array.from(menu.querySelectorAll('.cs-option')); }
  function setOpen(open, fromTriggerKey) {
    menu.classList.toggle('open', open);
    wrap.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', String(open));
    if (open && !fromTriggerKey) menu.style.minWidth = wrap.offsetWidth + 'px';
    // G5: 同步 _csOpenWraps 供共用 document listener 關閉
    if (open) { _csOpenWraps.add(wrap); wrap._csOpen = true; }
    else { _csOpenWraps.delete(wrap); wrap._csOpen = false; }
  }

  function openFromTrigger() {
    closeAll();
    setOpen(true);
    const rect = wrap.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const menuHeight = menu.scrollHeight || 200;
    menu.classList.toggle('cs-up', menuHeight > spaceBelow);
  }

  function focusOption(idx) {
    const opts = options();
    if (!opts.length) return;
    const clamped = ((idx % opts.length) + opts.length) % opts.length;
    opts.forEach(o => o.classList.remove('cs-highlight'));
    opts[clamped].classList.add('cs-highlight');
    opts[clamped].setAttribute('aria-selected', 'true');
    try { opts[clamped].focus({ preventScroll: true }); } catch (_) {}
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.classList.contains('open')) { setOpen(false); return; }
    openFromTrigger();
    focusOption(0);
  });

  // G13: 鍵盤導航（trigger 上）
  trigger.addEventListener('keydown', e => {
    const opts = options();
    const isOpen = menu.classList.contains('open');
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!isOpen) { openFromTrigger(); focusOption(e.key === 'ArrowDown' ? 0 : opts.length - 1); }
        else {
          // 用 tabindex/active 定位目前高亮
          const cur = opts.findIndex(o => o.classList.contains('cs-highlight'));
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          focusOption(cur === -1 ? (dir === 1 ? 0 : opts.length - 1) : cur + dir);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        if (isOpen) {
          e.preventDefault();
          const cur = opts.findIndex(o => o.classList.contains('cs-highlight'));
          if (cur >= 0) opts[cur].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } else {
          // 未開 → 開選單
          e.preventDefault();
          openFromTrigger();
          focusOption(0);
        }
        break;
      }
      case 'Escape':
        if (isOpen) { e.preventDefault(); setOpen(false); trigger.focus(); }
        break;
      case 'Home': if (isOpen) { e.preventDefault(); focusOption(0); } break;
      case 'End':  if (isOpen) { e.preventDefault(); focusOption(opts.length - 1); } break;
    }
  });

  // G13: 選項自身鍵盤（focus 後 Enter/Space 選擇、Tab 離開、Esc 關）
  menu.addEventListener('keydown', e => {
    const opts = options();
    switch (e.key) {
      case 'Enter':
      case ' ': {
        const cur = opts.findIndex(o => o.classList.contains('cs-highlight'));
        if (cur >= 0) { e.preventDefault(); opts[cur].dispatchEvent(new MouseEvent('click', { bubbles: true })); }
        break;
      }
      case 'ArrowDown':
        e.preventDefault();
        { const cur = opts.findIndex(o => o.classList.contains('cs-highlight')); focusOption(cur === -1 ? 0 : cur + 1); }
        break;
      case 'ArrowUp':
        e.preventDefault();
        { const cur = opts.findIndex(o => o.classList.contains('cs-highlight')); focusOption(cur === -1 ? opts.length - 1 : cur - 1); }
        break;
      case 'Escape':
        e.preventDefault(); setOpen(false); trigger.focus(); break;
      case 'Home': e.preventDefault(); focusOption(0); break;
      case 'End': e.preventDefault(); focusOption(opts.length - 1); break;
    }
  });

  select.addEventListener('change', () => {
    label.textContent = select.options[select.selectedIndex]?.text || '';
    menu.querySelector('.cs-option.selected')?.classList.remove('selected');
    const active = menu.querySelector(`.cs-option[data-value="${CSS.escape(select.value)}"]`);
    if (active) active.classList.add('selected');
  });

  ensureGlobalDocListener();   // G5: 共用單一 document listener（不在此累積）
  select.parentNode.insertBefore(wrap, select);
  select.style.display = 'none';
}

function addOption(opt, select, label, menu, wrap) {
  const item = document.createElement('div');
  item.className = 'cs-option';
  if (opt.selected) item.classList.add('selected');
  item.textContent = opt.text;
  item.dataset.value = opt.value;
  // G13: aria + focusable
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', 'false');
  item.tabIndex = -1;
  item.addEventListener('mouseenter', () => { item.classList.add('cs-highlight'); item.setAttribute('aria-selected', 'true'); });
  item.addEventListener('mouseleave', () => { if (!item.classList.contains('selected')) { item.classList.remove('cs-highlight'); item.setAttribute('aria-selected', 'false'); } });
  item.addEventListener('click', () => {
    select.value = item.dataset.value;
    label.textContent = item.textContent;
    menu.querySelector('.selected')?.classList.remove('selected');
    item.classList.add('selected');
    item.setAttribute('aria-selected', 'true');
    menu.classList.remove('open');
    if (wrap) { wrap.classList.remove('open'); _csOpenWraps.delete(wrap); wrap._csOpen = false; const t = wrap.querySelector('.cs-trigger'); if (t) t.setAttribute('aria-expanded', 'false'); }
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
  });
  menu.appendChild(item);
}

function closeAll() {
  document.querySelectorAll('.cs-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.cs-wrap.open').forEach(w => w.classList.remove('open'));
  _csOpenWraps.clear();   // G5: 同步清空追蹤集合
}
