// SIMPLIFY1 harness — 設定頁整頓（WebDAV 按鈕簡化 + 折疊手風琴 + API 改名）
// 原則：斷言「行為還在」，不只是「id 字串在」。
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
};
const src = (p) => readFileSync(p, 'utf8');
const settings = src('src/pages/settings.js')+src('src/pages/settings/sections.js')+src('src/pages/settings/webdav.js');
const css = src('src/styles/base.css');

console.log('== [A] WebDAV 按鈕簡化：15 → 3 顆可見 ==');
// 移除了的：不該有任何殘留（含 handler）
for (const id of ['webdavSaveBtn', 'webdavTestBtn', 'webdavPatchUploadBtn',
                  'webdavPatchDownloadBtn', 'webdavSrvSaveBtn', 'webdavSrvStartBtn',
                  'webdavSrvStopBtn', 'cloudRefreshBtn']) {
  chk(`已移除 ${id}（無殘留）`, !settings.includes(id));
}
// 留下來的核心兩顆
chk('保留「上傳」主按鈕', settings.includes('id="webdavUploadBtn"'));
chk('保留「下載」主按鈕', settings.includes('id="webdavDownloadBtn"'));
// 進階折疊區存在
chk('進階收在 <details> 折疊裡', /<summary[^>]*>進階<\/summary>/.test(settings));

console.log('\n== [B] 自動切換：差量優先、失敗自動整包 ==');
{
  // handler 很長 → 用固定視窗抽取（比對不到結尾大括號的風險較低）
  const grab = (marker, len = 6000) => {
    const i = settings.indexOf(marker);
    return i < 0 ? '' : settings.slice(i, i + len);
  };
  const up = grab(`document.getElementById('webdavUploadBtn')?.addEventListener`);
  chk('上傳 handler 存在', up.length > 0);
  if (up) {
    chk('上傳：先試差量', /await webdavPatchUpload\(\)/.test(up));
    chk('上傳：差量成功就 return（不重複整包）', /await webdavPatchUpload\(\)[\s\S]{0,900}?\breturn;/.test(up));
    chk('上傳：整包路徑仍在（含 checkpoint）', /await checkpoint\(\)/.test(up));
    chk('上傳：保留 CONFLICT 防呆', /CONFLICT:/.test(up));
    chk('上傳：保留 REMOTE_NEWER 防呆', /REMOTE_NEWER:/.test(up));
    chk('上傳：保留 EMPTY_LOCAL 防呆', /EMPTY_LOCAL:/.test(up));
    chk('上傳：媒體順帶（差量成功路徑也有）', (up.match(/webdavMediaUpload\(\)/g) || []).length >= 2,
      `次數=${(up.match(/webdavMediaUpload\(\)/g) || []).length}`);
  }
  const dn = grab(`document.getElementById('webdavDownloadBtn')?.addEventListener`);
  chk('下載 handler 存在', dn.length > 0);
  if (dn) {
    chk('下載：先試差量', /await webdavPatchDownload\(\)/.test(dn));
    chk('下載：整包路徑仍在', /await closeDB\(\)/.test(dn));
    chk('下載：保留 LOCAL_NEWER 防呆', /LOCAL_NEWER:/.test(dn));
    chk('下載：保留 EMPTY_REMOTE 防呆', /EMPTY_REMOTE:/.test(dn));
    // 只有一次 confirm（差量與整包共用）—— 注意整包內另有兩個「強制覆蓋」確認
    chk('下載：確認次數 <= 3（原本 1+2 強制覆蓋，未新增）',
      (dn.match(/confirm\(/g) || []).length <= 3,
      `confirm 數=${(dn.match(/confirm\(/g) || []).length}`);
  }
}

console.log('\n== [C] 自動化：存檔 / 測連線 / 啟停 ==');
chk('設定欄位自動儲存（change/blur）', /bindWebdavAutoSave/.test(settings) && /addEventListener\('blur', maybeSave\)/.test(settings));
chk('存檔後自動測連線', /await webdavTest\(\)/.test(settings));
chk('只在值真的變了才存', /if \(now\.url === last\.url/.test(settings));
chk('本地雲欄位自動儲存', /srvSaveConfig/.test(settings) && /webdavSrvAutostart'\].forEach/.test(settings));
chk('啟停合一顆切換鈕', /webdavSrvToggleBtn/.test(settings) && /btn\.dataset\.running === '1'/.test(settings));
chk('切換鈕文字依狀態', /btn\.textContent = running \? '停止本地雲' : '啟動本地雲'/.test(settings));
chk('啟動前先存欄位', /啟動前先把欄位存起來/.test(settings));
chk('媒體鈕只在有 pending 時顯示', /wrap\.style\.display = n > 0 \? '' : 'none'/.test(settings));

console.log('\n== [D] 折疊手風琴：一次只能展開一個 ==');
chk('展開前先收合其他', /sections\.forEach\(other => \{ if \(other !== sec\) _setCollapsed\(other, true\); \}\)/.test(settings));
chk('載入時收斂成最多一個', /expanded\.slice\(1\)\.forEach\(s => _setCollapsed\(s, true\)\)/.test(settings));
chk('收合集合由 DOM 導出（單一真相）', /_collapsedSetFromDom/.test(settings));
chk('aria-expanded 仍同步', /setAttribute\('aria-expanded', String\(!collapsed\)\)/.test(settings));
chk('折疊 CSS 帶 !important（沿用）', /\.section\.collapsible\.collapsed > :not\(\.section-title\)[^}]*!important/.test(css));

console.log('\n== [E] 韋氏字典 → API 改名 ==');
chk('設定區標題已改名為 API', /\$\{icon\('book'\)\} API<\/div>/.test(settings));
chk('不再有「韋氏字典」當區塊標題', !/\$\{icon\('book'\)\} 韋氏字典/.test(settings));
chk('提示文字說明兩種接口', /可接<b>本地<\/b>（ollama）或<b>公開<\/b>/.test(settings));

console.log('\n== [F] SIMPLIFY2：WebDAV 兩個子項目可收納、刪掉無意義字樣 ==');
chk('「連線設定」是 <details> 可收納', /<details id="webdavConfigSection"/.test(settings));
chk('「連線設定」摘要標題正確', /<summary[^>]*>連線設定（URL／帳號／密碼）<\/summary>/.test(settings));
chk('「雲端檔案」是 <details> 可收納', /<details id="webdavCloudSection"\s+open/.test(settings));
chk('「雲端檔案」預設展開（手機裝 APK 主路徑）', /<details id="webdavCloudSection" open/.test(settings));
chk('「（免開瀏覽器）」字樣已刪除（只看顯示文字，不含註解）',
  !settings.split('\n')
    .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('<!--') && !t.startsWith('*'); })
    .join('\n').includes('免開瀏覽器'));
chk('摺疊後仍保有原本欄位 id', ['webdavUrl', 'webdavUser', 'webdavPass', 'cloudFileTable', 'cloudUpBtn']
  .every(id => settings.includes(`id="${id}"`)));
// 收納不能把必要資訊也收掉：主要操作（自動同步／上傳／下載／狀態）必須留在折疊外
{
  const syncBlock = settings.slice(settings.indexOf('id="webdavSyncSection"'), settings.indexOf('<details', settings.indexOf('id="webdavSyncSection"')));
  chk('主要操作留在折疊外（自動同步）', syncBlock.includes('id="webdavAutoUpload"'));
  chk('主要操作留在折疊外（上傳）', syncBlock.includes('id="webdavUploadBtn"'));
  chk('主要操作留在折疊外（下載）', syncBlock.includes('id="webdavDownloadBtn"'));
  chk('主要操作留在折疊外（狀態行）', syncBlock.includes('id="webdavStatusText"'));
}

console.log(`\nSIMPLIFY1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
