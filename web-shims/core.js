// ══════════════════════════════════════════════════════════════
// WEB-SERVE1：網站版 invoke 傳輸層。
// 只在 `vite --mode web` 被 alias 成 '@tauri-apps/api/core'（Tauri build 不經過本檔）。
// 契約 = Tauri invoke：成功→回傳值；失敗→throw「字串」（前端 catch(e) 全吃字串）。
// session：任何 API 前先確認登入；401 → 登入浮層（成功後 reload）。
// ══════════════════════════════════════════════════════════════

let gate = null;

export function ensureSession() {
  if (!gate) {
    gate = checkSession().catch((e) => {
      gate = null;
      throw e;
    });
  }
  return gate;
}

async function checkSession() {
  const res = await fetch('/api/whoami', { credentials: 'same-origin' });
  if (res.ok) return;
  if (res.status === 401) return showLogin();
  throw `HTTP ${res.status}`;
}

// 未登入 → 全螢登入浮層（登入⇄註冊切換）；成功由伺服器下 session cookie → reload 重跑啟動
function showLogin() {
  if (document.getElementById('web-login')) return; // 已在顯示
  const wrap = document.createElement('div');
  wrap.id = 'web-login';
  wrap.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
  wrap.innerHTML = `
    <form style="background:#1c1c1e;color:#eee;padding:28px 24px;border-radius:14px;min-width:280px;display:flex;flex-direction:column;gap:12px">
      <div data-title style="font-size:17px;font-weight:600;text-align:center">Teno 登入</div>
      <input name="u" autocomplete="username" placeholder="帳號" required
        style="padding:10px;border-radius:8px;border:1px solid #444;background:#2c2c2e;color:#eee">
      <input name="p" type="password" autocomplete="current-password" placeholder="密碼" required minlength="8"
        style="padding:10px;border-radius:8px;border:1px solid #444;background:#2c2c2e;color:#eee">
      <div data-err style="color:#ff6b6b;font-size:13px;min-height:16px"></div>
      <button style="padding:10px;border-radius:8px;border:0;background:#0a84ff;color:#fff;font-size:15px;cursor:pointer">登入</button>
      <button type="button" data-switch style="padding:0;border:0;background:none;color:#0a84ff;font-size:13px;cursor:pointer">沒有帳號？註冊</button>
    </form>`;
  document.body.appendChild(wrap);
  let mode = 'login';
  wrap.querySelector('[data-switch]').addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    const isReg = mode === 'register';
    wrap.querySelector('[data-title]').textContent = isReg ? 'Teno 註冊' : 'Teno 登入';
    wrap.querySelector('button:not([data-switch])').textContent = isReg ? '註冊' : '登入';
    wrap.querySelector('[data-switch]').textContent = isReg ? '已有帳號？登入' : '沒有帳號？註冊';
    wrap.querySelector('input[name=p]').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
    wrap.querySelector('[data-err]').textContent = '';
  });
  wrap.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = wrap.querySelector('[data-err]');
    errEl.textContent = '';
    const username = e.target.u.value;
    const password = e.target.p.value;
    try {
      const res = await fetch(mode === 'register' ? '/api/register' : '/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        let msg = mode === 'register' ? '註冊失敗' : '登入失敗';
        try {
          const j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (_) {}
        errEl.textContent = msg;
        return;
      }
      location.reload();
    } catch (_) {
      errEl.textContent = '網路錯誤';
    }
  });
  return new Promise(() => {}); // 等 reload；永不 resolve 是刻意的
}

// 共用 POST：session 檢查 → 帶 cookie → 失敗 throw 字串（invoke/sql shim 都走這）
export async function apiPost(path, body) {
  await ensureSession();
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (res.ok) {
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }
  let msg = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    if (j && typeof j.error === 'string') msg = j.error;
  } catch (_) {}
  if (res.status === 401) {
    gate = null; // session 過期 → 下次呼叫重走登入
  }
  throw msg;
}

export async function invoke(cmd, args) {
  return apiPost(`/api/invoke/${encodeURIComponent(cmd)}`, args);
}
