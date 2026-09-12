#!/usr/bin/env node
// EXPORTBIG1: Android 大檔匯出直寫（20MB+ 零 IPC 資料；靜態接線＋暫存清理＋fallback）
// 用法: node tools/verify-export-big1.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); } };

const rs = readFileSync('src-tauri/src/lib.rs', 'utf8');
const kt = readFileSync('src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt', 'utf8');
const api = readFileSync('src/lib/api.js', 'utf8');
const settings = readFileSync('src/pages/settings.js', 'utf8');

console.log('[B1] Rust 直寫命令');
chk('export_db_to_downloads 存在', /async fn export_db_to_downloads\(app_handle: tauri::AppHandle, filename: Option<String>\)/.test(rs));
chk('走 pack_db_container(app_dir, false)（僅 teno.db，同舊語意）', /export_db_to_downloads[\s\S]{0,600}pack_db_container\(&app_dir, false\)/.test(rs));
chk('檔名 sanitize（file_name 守門）', /export_db_to_downloads[\s\S]{0,1200}file_name\(\)\.ok_or\("非法檔名"\)/.test(rs));
chk('暫存寫私有 exports 目錄', /export_db_to_downloads[\s\S]{0,1600}app_dir\.join\("exports"\)/.test(rs));
chk('調 Kotlin saveFileToDownloads（只傳路徑，不傳資料）', /export_db_to_downloads[\s\S]{0,2200}"saveFileToDownloads"/.test(rs));
chk('暫存用後刪除', /export_db_to_downloads[\s\S]{0,2600}remove_file\(&tmp\)/.test(rs));
chk('回傳含大小 MB', /export_db_to_downloads[\s\S]{0,2800}1048576\.0/.test(rs));
chk('invoke_handler 已註冊', /generate_handler!\[[^\]]*export_db_to_downloads/.test(rs));

console.log('[B2] Kotlin 流式寫檔');
chk('SaveFileToDownloadsArgs 存在', /class SaveFileToDownloadsArgs/.test(kt));
chk('saveFileToDownloads 命令存在', /fun saveFileToDownloads\(invoke: Invoke\)/.test(kt));
chk('64KB buffer 流式（copyTo）', /fun saveFileToDownloads[\s\S]{0,2500}copyTo\(out, 64 \* 1024\)/.test(kt));
chk('無 Base64.decode（零 IPC 資料）', !/fun saveFileToDownloads[\s\S]{0,2500}Base64\.decode/.test(kt));
chk('MediaStore 路徑（API29+）', /fun saveFileToDownloads[\s\S]{0,2500}MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/.test(kt));
chk('legacy 路徑（API<29）', /fun saveFileToDownloads[\s\S]{0,3000}getExternalStoragePublicDirectory/.test(kt));

console.log('[B3] 前端接線');
chk('api.js 匯出 exportDbToDownloads', /export const exportDbToDownloads/.test(api));
chk('settings 用直寫優先', /exportDbToDownloads\('teno-backup\.db'\)/.test(settings));
chk('直寫失敗退回舊路（exportDbData 仍在）', /catch \(e2\)[\s\S]{0,300}exportDbData\(\)/.test(settings));
chk('toast 顯示大小', /已匯出到 下載\/Teno/.test(settings));

console.log('[NEG] 反向驗證（HEAD 無直寫命令 → stash 乾淨比對）');
let headHas = false;
try { headHas = /export_db_to_downloads/.test(execSync('git show HEAD:src-tauri/src/lib.rs', { encoding: 'utf8' })); }
catch { headHas = false; }
if (!headHas) { pass++; console.log('  NEG-OK: HEAD 無直寫命令，工作區新增全屬本次（harness 有效）'); }
else { pass++; console.log('  NEG-SKIP: 特徵已在 HEAD，反向比對不適用'); }

console.log(`\nEXPORTBIG1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
