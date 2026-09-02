#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-PERSIST 驗證（T6）— ocr_engine 設定往返＋引擎解析鏈（真 db.js 層）
//
// 背景：bare dev browser 無 Tauri SQL，「選單重載後保持」的 DB 落盤段
// 無法於 browser 端綠。本腳本以 FakeDatabase（node:sqlite 真 SQL）把
// db.js get/setSetting 往返＋engine.js 現讀解析鏈整段釘死：
//   P1 setSetting('ocr_engine','paddle') → getSetting 重讀＝'paddle'
//   P2 未設定 key → getSetting null → _getActiveEngine 預設 tesseract
//   P3 持久化 'paddle' 存在時 _getActiveEngine → 現讀命中 paddle id
//      （佔位 available=false → 回退 tesseract 執行，id 鏈路仍正確）
//   P4 非法值幽靈 id 落庫 → getSetting 如實回、engine 回退（髒資料韌性）
//   P5 setSetting 覆寫（ON CONFLICT）：paddle→tesseract 往返收斂
//   NC ：FakeDatabase 層 GET 強制拋錯 → _getActiveEngine 仍回 tesseract
//        （setting 讀取炸＝回退鏈，非崩潰；engine E3 已測单元態，此處
//        打的是 db.js→engine.js 整合態）
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
};

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };

let boomGet = false;
class FakeDatabase {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    this.db.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')");
  }
  static load() {
    if (!FakeDatabase._singleton) FakeDatabase._singleton = new FakeDatabase();
    return FakeDatabase._singleton;
  }
  _bind(params = []) {
    const obj = {};
    for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i];
    return obj;
  }
  async execute(sql, params = []) { this.db.prepare(sql).run(this._bind(params)); }
  async select(sql, params = []) {
    if (boomGet && /FROM settings/.test(sql)) throw new Error('simulated read failure');
    return this.db.prepare(sql).all(this._bind(params));
  }
  async close() { this.db.close(); }
}
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });

async function main() {
  const dbMod = await import('../src/lib/db.js');
  await FakeDatabase.load();
  await dbMod.initDB();
  const { _getActiveEngine, registerEngine } = await import('../src/lib/ocr/engine.js');
  // node 無 Worker/document → 真 tesseract-adapter available()=false（E7 正確語意）。
  // 本腳本測「DB 持久化→現讀解析」整合鏈：tesseract 以 fake 頂位（同 T3 E 系慣例），
  // paddle 留真佔位（available=false）測回退。recognize 絕不呼叫。
  registerEngine('tesseract', async () => ({
    id: 'tesseract', available: async () => true, recognize: async () => { throw new Error('never'); },
  }));

  console.log('═══ OCR-PERSIST T6 驗證 ═══');

  // P1 寫入→重讀往返
  await dbMod.setSetting('ocr_engine', 'paddle');
  check('P1 setSetting→getSetting 往返', await dbMod.getSetting('ocr_engine'), 'paddle');

  // P2 未設定 → null → 預設鏈
  await dbMod.setSetting('ocr_engine', null).catch(() => {});
  FakeDatabase._singleton.db.exec("DELETE FROM settings WHERE key='ocr_engine'");
  check('P2 未設定 getSetting=null', await dbMod.getSetting('ocr_engine'), null);
  const r2 = await _getActiveEngine(dbMod.getSetting);
  check('P2 未設定 → 現讀預設 tesseract', r2.id, 'tesseract');

  // P3 持久化 paddle：id 現讀命中（佔位不可用→執行回退，切換鏈路正確）
  await dbMod.setSetting('ocr_engine', 'paddle');
  const r3 = await _getActiveEngine(dbMod.getSetting);
  check('P3 paddle 落庫→現讀回退 tesseract 執行', r3.id, 'tesseract');
  check('P3 設定值仍在（下次辨識現讀）', await dbMod.getSetting('ocr_engine'), 'paddle');

  // P4 髒資料：幽靈 id 直接落庫
  FakeDatabase._singleton.db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('ocr_engine', '\"cloud-x\"')");
  const r4 = await _getActiveEngine(dbMod.getSetting);
  check('P4 幽靈 id 落庫 → 回退不崩', r4.id, 'tesseract');

  // P5 覆寫收斂
  await dbMod.setSetting('ocr_engine', 'tesseract');
  check('P5 覆寫 ON CONFLICT 收斂', await dbMod.getSetting('ocr_engine'), 'tesseract');

  // NC 整合態：setting 讀取炸 → 回退鏈非崩潰
  boomGet = true;
  const rN = await _getActiveEngine(dbMod.getSetting);
  check('NC 讀取炸 → 回退 tesseract 不崩（整合態）', rN.id, 'tesseract');
  boomGet = false;

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('[harness error]', e); process.exit(2); });
