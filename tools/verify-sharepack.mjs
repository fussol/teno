// SHAREPACK1 驗收：單字套含圖打包（words.csv＋media/＋manifest.json）。
// 重點：圖零 IPC（Rust 直讀 DB）、CSV image 欄留空、匯入 manifest 對 id 掛圖、
// 守門（zip 500MB／單圖 10MB）、token 綁定、取消靜默。
import { readFileSync, existsSync } from 'node:fs';

const R = (p) => readFileSync(p, 'utf8');
const PROJ = '/home/jupiter/teno 修檢版';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

// ── Rust 命令註冊 ──
const lib = R(`${PROJ}/src-tauri/src/lib.rs`);
ok('mod share_pack 註冊', /mod share_pack;/.test(lib));
ok('export_share_pack 註冊', /share_pack::export_share_pack/.test(lib));
ok('import_share_pack_dialog 註冊', /share_pack::import_share_pack_dialog/.test(lib));
ok('get_share_media 註冊', /share_pack::get_share_media/.test(lib));

const rs = R(`${PROJ}/src-tauri/src/share_pack.rs`);
// ── 匯出：零 IPC 打包 ──
ok('匯出直讀 teno.db（唯讀）', /SQLITE_OPEN_READ_ONLY/.test(rs));
ok('匯出讀 word_images 表', /FROM word_images/.test(rs));
ok('匯出讀 words 取 word+deck（manifest 用）', /FROM words WHERE id IN/.test(rs));
ok('data URL 解碼（不經 IPC）', /decode_data_url\(t\)/.test(rs));
ok('直連下載落地（Tenor 時效）', /download_bytes\(t\)/.test(rs));
ok('zip 佈局 words.csv', /start_file\("words\.csv"/.test(rs));
ok('zip 佈局 manifest.json', /start_file\("manifest\.json"/.test(rs));
ok('zip 佈局 media/ 前綴', /start_file\(format!\("media\//.test(rs));
ok('words.csv 帶 BOM（Excel 相容）', /0xEF, 0xBB, 0xBF/.test(rs));
ok('回 JSON {path,images,skipped}', /"images": media\.len\(\),.*"skipped": skipped/s.test(rs));
// ── 匯入：解包＋逐張取圖 ──
ok('缺 words.csv 拒收', /缺少 words\.csv/.test(rs));
ok('zip 上限 500MB', /MAX_PACK_BYTES/.test(rs));
ok('單圖上限 10MB', /MAX_MEDIA_BYTES/.test(rs));
ok('media/ 前綴守門（防穿越）', /media\/\{safe_name\}/.test(rs));
ok('token 綁定 temp（apkg F-RACE1 同形）', /resolve_pack_tmp/.test(rs));
ok('Android content:// 走 cache（apkg 同路）', /copy_uri_to_cache/.test(rs));
// ── 純函式 ──
ok('檔名 ASCII 安全＋穿越只取副檔名', /safe_media_name/.test(rs) && /extension\(\)/.test(rs));
ok('mime 白名單（png/jpg/gif/webp/bmp/svg/avif）', /"avif"/.test(rs));
// ── 前端 ──
const api = R(`${PROJ}/src/lib/api.js`);
ok('api: exportSharePack', /exportSharePack/.test(api));
ok('api: importSharePackDialog', /importSharePackDialog/.test(api));
ok('api: getShareMedia', /getShareMedia/.test(api));

const exp = R(`${PROJ}/src/pages/export.js`);
ok('匯出：書櫃整櫃打包鈕', /data-shelf-pack/.test(exp));
ok('匯出：每本打包鈕', /data-share-pack-deck/.test(exp));
ok('匯出：篩選區含圖打包鈕', /sharePackRunBtn/.test(exp));
ok('匯出：CSV image 欄留空（避舊欄遷移）', /image: ''/.test(exp));

const imp = R(`${PROJ}/src/pages/import.js`);
ok('匯入：分享包頁籤', /data-mode="pack"/.test(imp));
ok('匯入：renderPackSection', /function renderPackSection/.test(imp));
ok('匯入：映射 UI 重用（renderMapping）', /renderMapping\(s\) \+ renderPreview\(s, true\) \+ renderPackImportBar/.test(imp));
ok('匯入：取消靜默（/取消/）', /if \(\/取消\/\.test\(msg\)\) return;.*pickPack/s.test(imp));
ok('匯入：manifest word+deck 對 id', /byKey\.set\(String\(w\.word/.test(imp));
ok('匯入：舊字也掛圖（state 全量查）', /s\.state\.words \|\| \[\]/.test(imp) && /importPackImages/.test(imp));
ok('匯入：逐張失敗只跳過（try/catch per job）', /pack image skip/.test(imp));
ok('匯入：500+ 張確認', /jobs\.length > 500/.test(imp));
ok('匯入：resetState 清 pack 會話', /_packToken = null/.test(imp));
ok('匯入：doImport after 回調掛圖', /doImport\(s, toImport, \(res\) => importPackImages/.test(imp));

// ── 檔存在 ──
ok('share_pack.rs 存在', existsSync(`${PROJ}/src-tauri/src/share_pack.rs`));
ok('verify-sharepack.mjs 存在', existsSync(`${PROJ}/tools/verify-sharepack.mjs`));

console.log(`\nSHAREPACK1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
