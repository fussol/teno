#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// SHAREPACK2 防回歸 — 分享包（公開題包專區）
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-sharepack.mjs
//
// 涵蓋：
//   1) 包格式 {v:1,kind,title,data}：roundtrip、壞包四路拒收、packCount
//   2) 隨附包：fetchBuiltinData 讀 public/packs/*、importBuiltin 寫 DB key
//   3) applyPack：gsat/core 覆寫、overlay upsert 合併（不互踩）
//   4) 預儲存：cachePack 只收公開包（overlay 拒收）、list/get/drop
//   5) 匯出：exportBuiltinPackJson / exportOverlayPackJson（空層拒匯）
//   6) gate HTML：有匯入鈕、有頁標記、不留「已匯入」痕跡
// ═══════════════════════════════════════════════════════════════
import { register } from 'node:module';
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
register('./raw-loader.mjs', import.meta.url);

// ── fake DB（沿用 a10 harness 的 FakeDatabase）──
class FakeDatabase {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this._initSchema();
  }
  static load() {
    if (!FakeDatabase._singleton) FakeDatabase._singleton = new FakeDatabase();
    return FakeDatabase._singleton;
  }
  _initSchema() {
    this.db.exec(`CREATE TABLE cards (
      word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL,
      elapsed_days REAL, scheduled_days REAL, reps INTEGER, lapses INTEGER,
      state INTEGER, step INTEGER, last_review TEXT, buried INTEGER, suspended INTEGER,
      mc_data TEXT, spell_data TEXT)`);
    this.db.exec(`CREATE TABLE review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER, duration INTEGER,
      elapsed_days REAL, scheduled_days REAL, difficulty REAL,
      mode TEXT NOT NULL DEFAULT 'flip', card_state INTEGER, new_state INTEGER, reviewed_at TEXT)`);
    this.db.exec(`CREATE TABLE words (
      id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT,
      example TEXT, deck TEXT, tags TEXT, image TEXT, description TEXT, created_at TEXT,
      related TEXT, forms TEXT, synonym TEXT, antonym TEXT, derivative TEXT, examples TEXT)`);
    this.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    this.db.exec('CREATE TABLE goal_streak (id INTEGER PRIMARY KEY, daily_goal INTEGER, current INTEGER, best INTEGER, dates TEXT)');
    this.db.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')");
    this.db.exec('CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT, color TEXT)');
    this.db.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT)');
    this.db.exec('CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, examples TEXT, deck TEXT, added_at TEXT)');
    this.db.exec('CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, correct INTEGER, question_type TEXT, examined_at TEXT)');
    this.db.exec('CREATE TABLE filtered_decks (id TEXT PRIMARY KEY, name TEXT, search_query TEXT, max_cards INTEGER, order_by TEXT, color TEXT, created_at TEXT, last_used TEXT)');
  }
  _bind(sql, params = []) {
    if (!params || params.length === 0) return {};
    const obj = {};
    for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i];
    return obj;
  }
  async execute(sql, params = []) { this.db.prepare(sql).run(this._bind(sql, params)); }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() { this.db.close(); }
}

mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

// fetch polyfill → 直讀 public/（頁面走 HTTP、node 走同一路徑檔案）
globalThis.fetch = async (url) => {
  const f = path.join(ROOT, 'public', String(url).replace(/^\/+/, ''));
  if (!fs.existsSync(f)) return { ok: false, status: 404, text: async () => { throw new Error('404'); } };
  return { ok: true, status: 200, text: async () => fs.readFileSync(f, 'utf8') };
};

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); } };
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };

const sp = await import('../src/lib/sharepack.js');
const dbMod = await import('../src/lib/db.js');
await dbMod.initDB();
const { PACK_KINDS, BUILTIN_PACKS, packToJson, parsePack, packCount, fetchBuiltinData,
  importBuiltin, applyPack, exportBuiltinPackJson, exportOverlayPackJson,
  cachePack, listCachedPacks, cachedPackJson, dropCachedPack, packGateHtml } = sp;

// ── 1) 包格式 ──
ok(PACK_KINDS.join() === 'pack-gsat,pack-grammar-core,pack-grammar-overlay', '1 種類固定三種（gsat/core/overlay）');
ok(BUILTIN_PACKS.length === 2 && BUILTIN_PACKS.every(p => p.id && p.kind && p.title), '隨附包清單 2 筆（id/kind/title 齊）');
const rt = parsePack(packToJson('pack-gsat', { mc: [{ id: 'x' }], tr: [] }, '標題'));
ok(rt.v === 1 && rt.kind === 'pack-gsat' && rt.title === '標題' && rt.data.mc.length === 1, 'roundtrip：packToJson → parsePack');
ok(await rejects(async () => parsePack('not json')), '壞包拒收：非 JSON');
ok(await rejects(async () => parsePack(JSON.stringify({ v: 1, kind: 'pack-x', data: {} }))), '壞包拒收：未知 kind');
ok(await rejects(async () => parsePack(JSON.stringify({ v: 2, kind: 'pack-gsat', data: { mc: [] } }))), '壞包拒收：未知版本 v2');
ok(await rejects(async () => parsePack(JSON.stringify({ v: 1, kind: 'pack-gsat', data: { tr: [] } }))), '壞包拒收：gsat 缺 mc');
ok(await rejects(async () => parsePack(JSON.stringify({ v: 1, kind: 'pack-grammar-core', data: { topics: {} } }))), '壞包拒收：core 缺 qs');
ok(await rejects(async () => parsePack(JSON.stringify({ v: 1, kind: 'pack-grammar-overlay', data: [] }))), '壞包拒收：overlay data 非物件');
ok(packCount(parsePack(packToJson('pack-gsat', { mc: [{}, {}, {}], tr: [{}, {}] }))) === 5, 'packCount：gsat = mc+tr');
ok(packCount(parsePack(packToJson('pack-grammar-core', { qs: [{}] }))) === 1, 'packCount：core = qs 題數');
ok(packCount(parsePack(packToJson('pack-grammar-overlay', { up: { a: 1, b: 2 }, rm: ['x'] }))) === 3, 'packCount：overlay = up+rm');

// ── 2) 隨附包：讀 public/packs/* + importBuiltin 寫 DB ──
const g = await fetchBuiltinData('gsat');
ok(Array.isArray(g.mc) && g.mc.length > 400 && Array.isArray(g.tr) && g.tr.length > 0, `fetchBuiltin gsat（mc ${g.mc.length} · tr ${g.tr.length}）`);
ok(g.mc.every(q => q.id && q.year && q.section), 'fetchBuiltin gsat：題目欄位齊（id/year/section）');
const ga = await fetchBuiltinData('grammar');
ok(Array.isArray(ga.qs) && ga.qs.length > 300 && Object.keys(ga.topics).length > 0, `fetchBuiltin grammar（qs ${ga.qs.length} · topics ${Object.keys(ga.topics).length}）`);
ok(ga.qs.every(q => q.pattern && ga.topics[q.pattern]), 'fetchBuiltin grammar：每題 pattern 都有標題');
ok(await rejects(() => fetchBuiltinData('nope')), 'fetchBuiltin：未知 id 拒收');
await importBuiltin('gsat');
let bank = await dbMod.getSetting('gsat_bank');
ok(bank && bank.mc.length === g.mc.length && bank.tr.length === g.tr.length, 'importBuiltin gsat → settings.gsat_bank 落庫');
await importBuiltin('grammar');
const core = await dbMod.getSetting('grammar_bank_core');
ok(core && core.qs.length === ga.qs.length && core.topics && Object.keys(core.topics).length === Object.keys(ga.topics).length, 'importBuiltin grammar → settings.grammar_bank_core 落庫');
const expG = JSON.parse(await exportBuiltinPackJson('gsat'));
ok(expG.kind === 'pack-gsat' && expG.data.mc.length === g.mc.length, 'exportBuiltinPackJson gsat → 可 parse 的單檔');
ok(await rejects(() => exportBuiltinPackJson('nope')), 'exportBuiltinPackJson：未知 id 拒收');

// ── 3) applyPack：覆寫 + overlay upsert 合併 ──
await applyPack(packToJson('pack-gsat', { mc: [{ id: 'a' }], tr: [{ id: 'b' }] }));
bank = await dbMod.getSetting('gsat_bank');
ok(bank.mc.length === 1 && bank.tr.length === 1 && bank.mc[0].id === 'a', 'applyPack gsat：整包覆寫');
await dbMod.setSetting('grammar_bank_overlay', { up: { 'g-1-1-mc-1': { id: 'g-1-1-mc-1' } }, rm: ['g-1-1-mc-9'] });
await applyPack(packToJson('pack-grammar-overlay', { up: { 'g-1-1-mc-2': { id: 'g-1-1-mc-2' } }, rm: ['g-1-1-mc-9', 'g-1-1-mc-8'] }));
let ov = await dbMod.getSetting('grammar_bank_overlay');
ok(!!ov.up['g-1-1-mc-1'] && !!ov.up['g-1-1-mc-2'], 'overlay 匯入：upsert 合併（既有自建題不被覆蓋）');
ok(ov.rm.join() === 'g-1-1-mc-9,g-1-1-mc-8', 'overlay 匯入：rm 聯集（不互踩）');
ok(await rejects(() => applyPack('garbage')), 'applyPack：壞字串拒收');

// ── 4) 預儲存：只收公開包 ──
ok(await rejects(() => cachePack('bad.json', 'nope')), 'cachePack：壞包拒收且不落地');
ok((await listCachedPacks()).length === 0, 'cachePack 壞包後：清單仍空');
ok(await rejects(() => cachePack('mine.json', packToJson('pack-grammar-overlay', { up: {}, rm: [] }))), 'cachePack：overlay（個人資料）拒收');
const goodJson = packToJson('pack-grammar-core', { qs: [{ id: 'q1' }], topics: {} });
await cachePack('pack-a.json', goodJson);
let lst = await listCachedPacks();
ok(lst.length === 1 && lst[0].name === 'pack-a.json' && lst[0].at > 0, 'cachePack：進清單（帶時間戳）');
ok((await cachedPackJson('pack-a.json')) === goodJson, 'cachedPackJson：取回原字串');
await cachePack('pack-a.json', packToJson('pack-gsat', { mc: [{ id: 'z' }], tr: [] }));
lst = await listCachedPacks();
ok(lst.length === 1, 'cachePack：同名覆蓋（不堆疊）');
await dropCachedPack('pack-a.json');
ok((await listCachedPacks()).length === 0 && (await cachedPackJson('pack-a.json')) === null, 'dropCachedPack：刪掉後清單/內容皆空');

// ── 5) 匯出 ──
await dbMod.setSetting('grammar_bank_overlay', { up: {}, rm: [] });
ok(await rejects(() => exportOverlayPackJson()), 'exportOverlayPackJson：空覆蓋層拒匯');
await dbMod.setSetting('grammar_bank_overlay', { up: { 'g-1-1-mc-1': { id: 'g-1-1-mc-1', stem: 'x' } }, rm: [] });
const expOv = JSON.parse(await exportOverlayPackJson());
ok(expOv.kind === 'pack-grammar-overlay' && expOv.data.up['g-1-1-mc-1']?.stem === 'x', 'exportOverlayPackJson：單檔含 up/rm');

// ── 6) gate HTML ──
const gate = packGateHtml({ page: 'grammar', title: '文法翻譯', iconName: 'bookOpen' });
ok(gate.includes('data-page="grammar"') && gate.includes('data-gate-import'), 'gate：頁標記＋匯入鈕齊');
ok(!gate.includes('已匯入'), 'gate：不留「已匯入」痕跡（匯入後 UI 與內建無差別）');

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
