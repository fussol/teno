// settings/webdav.js — WebDAV 同步／內嵌雲／雲端瀏覽／媒體佇列／日誌歸檔 綁定群（P4 Step2 純搬移）
// 原 settings.js _mount 內 WebDAV 區塊（WIDGET1 先純搬位使其連續）；s 由呼叫端傳入
import { webdavSaveConfig, webdavTest, backupDb, webdavCloudDelete, webdavCloudList, webdavDownload, webdavLogArchivePrune, webdavLogArchiveStatus, webdavLogArchiveUpload, webdavLogout, webdavMediaDownload, webdavMediaUpload, webdavPatchDownload, webdavPatchUpload, webdavServerDeleteLocal, webdavServerGetConfig, webdavServerListLocal, webdavServerSaveConfig, webdavServerStart, webdavServerStatus, webdavServerStop, webdavStatus, webdavUpload } from '../../lib/api.js';
import { isAndroid } from '../../lib/platform.js';
import { toast } from '../../lib/toast.js';
export function bindWebdavSyncPage(s) {
  // ── WebDAV Sync（帳密存一次，之後自動帶；上傳自動對帳）──
  async function updateWebdavUI() {
    const st = document.getElementById('webdavStatusText');
    try {
      const status = await webdavStatus();
      st.textContent = `狀態: ${status}`;
    } catch (e) {
      st.textContent = `狀態: ${e}`;
    }
  }
  updateWebdavUI();

  // WebDAV 自動上傳開關（存 db settings，預設關；開了才跟本地自動備份同一 tick 上傳）
  import('../../lib/db.js').then(async ({ getSetting, setSetting }) => {
    const box = document.getElementById('webdavAutoUpload');
    if (!box) return;
    try {
      const flag = await getSetting('webdavAutoUpload');
      box.checked = flag === 1 || flag === true || flag === '1';
    } catch (_) {}
    box.addEventListener('change', async () => {
      try {
        await setSetting('webdavAutoUpload', box.checked ? 1 : 0);
        toast(box.checked ? '已開啟：自動備份時同步上傳 WebDAV' : '已關閉 WebDAV 自動上傳', 'toast-success');
      } catch (e) {
        toast('設定儲存失敗: ' + e, 'toast-error');
      }
    });
  }).catch(() => {});

  // SIMPLIFY1：設定欄位失焦即存＋自動測連線（取代原本「儲存」「測試連線」兩顆按鈕）
  // SIMPLIFY1：上傳＝**先差量（幾 KB），不可用自動走整包** —— 不必自己選。
  // 任何差量失敗都落到整包路徑，由那裡統一面對衝突（CONFLICT/REMOTE_NEWER 防呆）。
  document.getElementById('webdavUploadBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('webdavUploadBtn');
    btn.disabled = true;
    btn.textContent = '處理中…';
    try {
      // ① 差量優先（快）
      try {
        const r = await webdavPatchUpload();
        toast(r, 'toast-success');
        try {
          const { addAudit } = await import('../../lib/db.js');
          await addAudit('webdav-patch-upload', 'WebDAV 差量上傳').catch(() => {});
        } catch (_) {}
        try { const mr = await webdavMediaUpload(); if (mr) toast(mr, ''); } catch (_) {}
        return;
      } catch (_patchErr) {
        // ② 落到整包（下方流程）；失敗原因交由整包路徑的防呆統一呈現
      }
      // D3 同源：WAL checkpoint → 主檔完整後再上傳（webdav_upload 只 fs::read 主檔）
      const { checkpoint } = await import('../../lib/db.js');
      await checkpoint();
      try {
        const result = await webdavUpload();
        toast(result, 'toast-success');
      } catch (e) {
        // WEBDAV-GUARD1：遠端比較新→擋下，問過才硬蓋（舊蓋新防呆）
        const msg = String(e);
        if (msg.includes('CONFLICT:')) {
          // SYNC2-Q1：分叉→不自動蓋，遠端已存 conflict 檔，人看完再選
          toast(msg, 'toast-error');
          if (confirm(msg.replace('CONFLICT:', '') + '\n\n確定要用本地版強制覆蓋遠端？（遠端舊版已存 conflict 檔＋伺服器 .history）')) {
            const result = await webdavUpload(true);
            toast(result + '（已強制覆蓋）', 'toast-success');
          } else {
            toast('已取消上傳（兩邊都在，本地未動）', '');
            return;
          }
        } else if (msg.includes('EMPTY_LOCAL:')) {
          toast(msg, 'toast-error');
          return;
        } else if (msg.includes('REMOTE_NEWER:') && confirm(msg.replace('REMOTE_NEWER:', '') + '\n\n確定要用本地舊版覆蓋遠端新版？')) {
          const result = await webdavUpload(true);
          toast(result + '（已強制覆蓋）', 'toast-success');
        } else if (!msg.includes('REMOTE_NEWER:')) {
          throw e;
        } else {
          toast('已取消上傳（遠端較新，本地未動）', '');
          return;
        }
      }
      const _d = await import('../../lib/db.js');
      await _d.addAudit('webdav-upload', 'WebDAV 全庫上傳同步').catch(() => {});
      // MEDIAPEEL1：DB 上傳成功後順帶媒體（只傳缺塊；失敗不擋主流程）
      try {
        const mr = await webdavMediaUpload();
        toast(mr, '');
        await _d.addAudit('webdav-media-upload', String(mr)).catch(() => {});
      } catch (me) { toast('媒體順帶上傳失敗（DB 已同步，圖下次再傳）: ' + me, 'toast-warn'); }
      updateWebdavUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    } finally {
      btn.disabled = false;
      btn.textContent = '上傳同步';
    }
  });

  // SIMPLIFY1：下載＝**先差量（fast-forward，本地乾淨時），不可用自動走整包**。
  // 只有一次確認（涵蓋兩種路徑），比舊版「差量確認＋整包確認」少一次打擾。
  document.getElementById('webdavDownloadBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('webdavDownloadBtn');
    btn.disabled = true;
    try {
      if (!confirm('確定要從 WebDAV 下載並取代目前資料？（會先自動備份目前資料庫）')) return;
      // ① 差量優先（不需關庫）
      try {
        const r = await webdavPatchDownload();
        toast(r, 'toast-success');
        setTimeout(() => location.reload(), 500);
        return;
      } catch (_patchErr) {
        // ② 落到整包（下方流程，含 CONFLICT/LOCAL_NEWER 防呆）
      }
      const { checkpoint, closeDB, initDB } = await import('../../lib/db.js');
      const { closeAppLog } = await import('../../lib/app-log.js');
      await checkpoint();
      await backupDb();
      await closeDB();
      await closeAppLog();
      let _dlOk = false;
      try {
        const result = await webdavDownload();
        toast(result, 'toast-success');
        _dlOk = true;
      } catch (e) {
        // WEBDAV-GUARD1：本地比較新→擋下，問過才硬蓋（舊蓋新防呆）
        const msg = String(e);
        if (msg.includes('CONFLICT:')) {
          toast(msg, 'toast-error');
          if (confirm(msg.replace('CONFLICT:', '') + '\n\n確定要用遠端版強制覆蓋本地？（本地有新進度，會被吃掉）')) {
            const result = await webdavDownload(true);
            toast(result + '（已強制覆蓋）', 'toast-success');
            _dlOk = true;
          } else {
            toast('已取消下載（兩邊都在，本地未動）', '');
            try { await initDB(2); } catch (_) {}
            return;
          }
        } else if (msg.includes('EMPTY_REMOTE:')) {
          toast(msg, 'toast-error');
          try { await initDB(2); } catch (_) {}
          return;
        } else if (msg.includes('LOCAL_NEWER:') && confirm(msg.replace('LOCAL_NEWER:', '') + '\n\n確定要用遠端舊版覆蓋本地新版？')) {
          const result = await webdavDownload(true);
          toast(result + '（已強制覆蓋）', 'toast-success');
          _dlOk = true;
        } else if (!msg.includes('LOCAL_NEWER:')) {
          throw e;
        } else {
          toast('已取消下載（本地較新，本地未動）', '');
          try { await initDB(2); } catch (_) {}
          return;
        }
      }
      // MEDIAPEEL1：DB 下載成功後順帶媒體下載（best-effort；reload 前做）
      if (_dlOk) {
        try {
          const mr = await webdavMediaDownload();
          toast(mr, '');
        } catch (me) { toast('媒體順帶下載失敗（DB 已同步，圖下次再拉）: ' + me, 'toast-warn'); }
      }
      setTimeout(() => location.reload(), 500);
    } catch (e) {
      toast(String(e), 'toast-error');
      try { const { initDB } = await import('../../lib/db.js'); await initDB(2); } catch (_) {}
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('webdavClearBtn')?.addEventListener('click', async () => {
    await webdavLogout();
    toast('已清除 WebDAV 設定', 'toast-success');
    updateWebdavUI();
  });

  // ── SIMPLIFY1：差量已併入「上傳」「下載」主按鈕（先差量、失敗自動整包），
  //    故獨立的差量按鈕與處理器已移除。

  // ── MEDIAPEEL1 媒體佇列（有時間慢慢傳；取消＋僅 WiFi）──
  import('../../lib/media-queue.js').then(mq => {
    const cnt = document.getElementById('mediaQueueCount');
    const wrap = document.getElementById('mediaQueueWrap');
    const n = mq.pendingCount();
    if (cnt) cnt.textContent = n;
    // SIMPLIFY1：沒待傳就整顆藏起來（上傳主按鈕本來就會順帶傳媒體）
    if (wrap) wrap.style.display = n > 0 ? '' : 'none';
    const wf = document.getElementById('mediaWifiOnly');
    if (wf) {
      wf.checked = mq.wifiOnly();
      wf.addEventListener('change', () => mq.setWifiOnly(wf.checked));
    }
  }).catch(() => {});
  document.getElementById('webdavMediaFlushBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const cancelBtn = document.getElementById('webdavMediaFlushCancelBtn');
    if (cancelBtn) cancelBtn.style.display = '';
    try {
      const mq = await import('../../lib/media-queue.js');
      const api = await import('../../lib/api.js');
      const r = await mq.flushMediaQueue(api, ({ done, total }) => {
        btn.textContent = `傳圖中 ${done}/${total}…`;
      });
      toast(`媒體佇列：${r.ok} 個完成${r.note && r.note !== 'empty' ? `（${r.note}）` : ''}`, 'toast-success');
      try { const { invalidateWordImages } = await import('../../lib/word-image.js'); invalidateWordImages(); } catch (_) {}
    } catch (err) {
      toast('媒體上傳失敗（佇列已落地，下次重試）: ' + err, 'toast-error');
    } finally {
      btn.disabled = false; btn.textContent = '媒體佇列上傳';
      if (cancelBtn) cancelBtn.style.display = 'none';
      try {
        const mq2 = await import('../../lib/media-queue.js');
        const cnt2 = document.getElementById('mediaQueueCount');
        if (cnt2) cnt2.textContent = mq2.pendingCount();
      } catch (_) {}
      updateWebdavUI();
    }
  });
  document.getElementById('webdavMediaFlushCancelBtn')?.addEventListener('click', async () => {
    try { const mq = await import('../../lib/media-queue.js'); mq.cancelFlush(); toast('已取消（剩餘下次再傳）', ''); } catch (_) {}
  });

  // ── LOGARCHIVE1 日誌歸檔（devMode 唯一入口；顯示本次多大；傳完 24h 後釋放）──
  (function refreshLogArchiveStatus() {
    const el = document.getElementById('logArchiveStatus');
    if (!el) return;
    webdavLogArchiveStatus().then(r => {
      const o = typeof r === 'string' ? JSON.parse(r) : r;
      el.textContent = `本地 ${o.rows} 筆（約 ${(o.bytes_gz_est / 1024).toFixed(1)} KB），已歸檔至 ${o.uploaded_until ? new Date(o.uploaded_until).toLocaleString('zh-TW') : '無'}`;
    }).catch(() => { el.textContent = '讀取失敗'; });
  })();
  document.getElementById('logArchiveUploadBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      const r = await webdavLogArchiveUpload();
      toast(r, 'toast-success');
      try {
        const st2 = await webdavLogArchiveStatus();
        const o2 = typeof st2 === 'string' ? JSON.parse(st2) : st2;
        const el2 = document.getElementById('logArchiveStatus');
        if (el2) el2.textContent = `本地 ${o2.rows} 筆，已歸檔至 ${o2.uploaded_until ? new Date(o2.uploaded_until).toLocaleString('zh-TW') : '無'}`;
      } catch (_) {}
    } catch (err) { toast(String(err), 'toast-error'); }
    finally { btn.disabled = false; }
  });
  document.getElementById('logArchivePruneBtn')?.addEventListener('click', async () => {
    try {
      const r = await webdavLogArchivePrune();
      toast(r, 'toast-success');
      try {
        const st3 = await webdavLogArchiveStatus();
        const o3 = typeof st3 === 'string' ? JSON.parse(st3) : st3;
        const el3 = document.getElementById('logArchiveStatus');
        if (el3) el3.textContent = `本地 ${o3.rows} 筆，已歸檔至 ${o3.uploaded_until ? new Date(o3.uploaded_until).toLocaleString('zh-TW') : '無'}`;
      } catch (_) {}
    } catch (err) { toast(String(err), 'toast-error'); }
  });

  // ── 內嵌本地雲 WEBDAV-EMBED1（桌機限定；手機走 Termux 獨立版）──
  async function updateWebdavSrvUI() {
    const st = document.getElementById('webdavSrvStatusText');
    if (!st) return;
    let running = false;
    try {
      const status = await webdavServerStatus();
      st.textContent = `狀態: ${status}`;
      // SIMPLIFY1：切換鈕文字依狀態（Rust 端固定用「內嵌跑著」開頭表示執行中）
      running = /內嵌跑著/.test(String(status));
    } catch (e) {
      st.textContent = `狀態: ${e}`;
    }
    const btn = document.getElementById('webdavSrvToggleBtn');
    if (btn) {
      btn.dataset.running = running ? '1' : '0';
      btn.textContent = running ? '停止本地雲' : '啟動本地雲';
    }
    try {
      const cfg = await webdavServerGetConfig();
      const port = document.getElementById('webdavSrvPort');
      const user = document.getElementById('webdavSrvUser');
      const auto = document.getElementById('webdavSrvAutostart');
      if (port && cfg.port) port.value = cfg.port;
      if (user && cfg.username) user.value = cfg.username;
      if (auto) auto.checked = !!cfg.autostart;
    } catch (_) {}
  }
  updateWebdavSrvUI();

  // SIMPLIFY1：內嵌本地雲 = 欄位自動儲存 + 一顆「啟動⇄停止」切換（取代儲存/啟動/停止三顆）
  async function srvSaveConfig() {
    const port = parseInt(document.getElementById('webdavSrvPort')?.value, 10) || 8080;
    const user = document.getElementById('webdavSrvUser')?.value.trim() || 'teno';
    const pass = document.getElementById('webdavSrvPass')?.value || '';
    const autostart = !!document.getElementById('webdavSrvAutostart')?.checked;
    const r = await webdavServerSaveConfig(port, user, pass, autostart);
    const pe = document.getElementById('webdavSrvPass'); if (pe) pe.value = '';
    return r;
  }
  ['webdavSrvPort', 'webdavSrvUser', 'webdavSrvPass', 'webdavSrvAutostart'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      try { await srvSaveConfig(); toast('本地雲設定已儲存', 'toast-success'); updateWebdavSrvUI(); }
      catch (e) { toast(String(e), 'toast-error'); }
    });
  });

  document.getElementById('webdavSrvToggleBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const running = btn.dataset.running === '1';
    btn.disabled = true;
    try {
      if (running) {
        toast(await webdavServerStop(), 'toast-success');
      } else {
        try { await srvSaveConfig(); } catch (_) {}   // 啟動前先把欄位存起來
        toast(await webdavServerStart(), 'toast-success');
      }
      updateWebdavSrvUI();
    } catch (err) { toast(String(err), 'toast-error'); }
    finally { btn.disabled = false; }
  });

  // ── 雲端檔案瀏覽 CLOUDBROWSE1（免開瀏覽器）──
  let _cloudPath = '';
  let _cloudSource = 'local'; // local＝本機直讀（桌機預設）／remote＝雲端列表（手機預設）
  try { if (isAndroid) _cloudSource = 'remote'; } catch (_) {}
  const cloudFmtSize = (n) => {
    n = Number(n) || 0;
    if (n <= 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  const cloudFmtTime = (t) => {
    t = Number(t) || 0;
    if (!t) return '—';
    try { return new Date(t * 1000).toLocaleString('zh-TW', { hour12: false }); }
    catch (_) { return String(t); }
  };
  const cloudEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  async function refreshCloudBrowser() {
    const box = document.getElementById('cloudFileTable');
    const pathEl = document.getElementById('cloudPathLabel');
    const srcEl = document.getElementById('cloudSourceLabel');
    if (!box) return;
    if (pathEl) pathEl.textContent = '/' + (_cloudPath || '');
    box.innerHTML = '<span style="font-size:12px">讀取中…</span>';
    try {
      let raw;
      if (_cloudSource === 'local' && !isAndroid) {
        try { raw = await webdavServerListLocal(_cloudPath || null); }
        catch (_) { raw = await webdavCloudList(_cloudPath || null); } // 本機無目錄→掉回雲端
      } else {
        raw = await webdavCloudList(_cloudPath || null);
      }
      const data = JSON.parse(raw);
      if (srcEl) srcEl.textContent = data.source === 'local' ? '· 本機直讀（免網路）' : '· 雲端列表';
      _cloudSource = data.source === 'local' ? 'local' : 'remote';
      const es = Array.isArray(data.entries) ? data.entries : [];
      if (!es.length) { box.innerHTML = '<span style="font-size:12px">空目錄</span>'; return; }
      box.innerHTML = es.map((e, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border-subtle)">
          <span style="font-size:15px">${e.isdir ? '📁' : '📄'}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary)" title="${cloudEsc(e.name)}">${cloudEsc(e.name)}${e.isdir ? '/' : ''}</span>
          <span style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">${e.isdir ? '' : cloudFmtSize(e.size)}</span>
          <span style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">${cloudFmtTime(e.mtime)}</span>
          ${e.isdir ? `<button class="btn btn-sm" data-cloud-enter="${i}">進入</button>` : ''}
          <button class="btn btn-sm btn-secondary" data-cloud-del="${i}" title="刪除">刪</button>
        </div>`).join('');
      box.querySelectorAll('[data-cloud-enter]').forEach(btn => {
        btn.addEventListener('click', () => {
          const e = es[parseInt(btn.dataset.cloudEnter, 10)];
          if (!e) return;
          _cloudPath = (_cloudPath ? _cloudPath + '/' : '') + e.name;
          refreshCloudBrowser();
        });
      });
      box.querySelectorAll('[data-cloud-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const e = es[parseInt(btn.dataset.cloudDel, 10)];
          if (!e) return;
          const full = (_cloudPath ? _cloudPath + '/' : '') + e.name;
          if (!confirm(`確定刪除雲端「${full}」？${e.isdir ? '（只刪空目錄）' : ''}`)) return;
          try {
            const r = (data.source === 'local')
              ? await webdavServerDeleteLocal(full)
              : await webdavCloudDelete(full);
            toast(r, 'toast-success');
            refreshCloudBrowser();
          } catch (err) { toast(String(err), 'toast-error'); }
        });
      });
    } catch (e) {
      box.innerHTML = `<span style="font-size:12px">讀不到：${cloudEsc(e?.message || e)}（先確認同步設定已存＋雲有開）</span>`;
      if (srcEl) srcEl.textContent = '';
    }
  }
  // SIMPLIFY1：「重新整理」按鈕已移除 —— 進入目錄／回上層／切換來源都會自動重整
  document.getElementById('cloudSrcToggleBtn')?.addEventListener('click', () => {
    _cloudSource = (_cloudSource === 'local') ? 'remote' : 'local';
    refreshCloudBrowser();
  });
  document.getElementById('cloudUpBtn')?.addEventListener('click', () => {
    if (!_cloudPath) return;
    const parts = _cloudPath.split('/').filter(Boolean);
    parts.pop();
    _cloudPath = parts.join('/');
    refreshCloudBrowser();
  });
  refreshCloudBrowser();


  // SIMPLIFY1：設定欄位失焦即存＋自動測連線（P4 Step2 自 settings widget 段併回）
    (function bindWebdavAutoSave() {
      const urlEl = document.getElementById('webdavUrl');
      const userEl = document.getElementById('webdavUser');
      const passEl = document.getElementById('webdavPass');
      if (!urlEl || !userEl || !passEl) return;
      let last = { url: urlEl.value, user: userEl.value, pass: passEl.value };
      const saveNow = async () => {
        const url = urlEl.value.trim();
        const user = userEl.value.trim();
        const pass = passEl.value;
        if (!url || !user) return;                 // 未填齊 → 不打擾
        try {
          await webdavSaveConfig(url, user, pass);
          passEl.value = '';
          try {
            const r = await webdavTest();           // 自動測連線
            toast(r, 'toast-success');
          } catch (te) { toast('已儲存，但連線測試失敗：' + te, 'toast-warn'); }
          updateWebdavUI();
        } catch (e) { toast(String(e), 'toast-error'); }
      };
      const maybeSave = () => {
        const now = { url: urlEl.value, user: userEl.value, pass: passEl.value };
        if (now.url === last.url && now.user === last.user && now.pass === last.pass) return;
        last = { ...now };
        saveNow();
      };
      [urlEl, userEl, passEl].forEach(el => {
        el.addEventListener('change', maybeSave);
      });
      urlEl.addEventListener('blur', maybeSave);
    })();
}
