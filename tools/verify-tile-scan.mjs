#!/usr/bin/env node
// ═══ VERIFY-TILE-SCAN — 局部切割掃描純函式驗證 ═══
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { tileGrid, crossTileVote, tileUpscaleFactor, buildQueue, OVERLAP_RATIO, EDGE_PX } =
  await import('file://' + path.join(ROOT, 'src/lib/ocr/tile-scan.js'));

let fail = 0, total = 0;
const ok = (l, c, d) => { total++; if (!c) { fail++; console.log(`FAIL ${l}${d ? ' :: ' + JSON.stringify(d) : ''}`); } else console.log(`PASS ${l}`); };

// ── T1 tileGrid：3×3 網格覆蓋全圖 ──
{
  const tiles = tileGrid({ width: 1200, height: 2400 }, 3, 3);
  ok('T1a 3×3 = 9 片', tiles.length === 9, tiles.length);
  // T1a2（2026-09-01 實測抓漏 v2）：所有片座標非負、片不出圖
  ok('T1a2 座標非負且不出圖（v1 負起點 bug 釘）', tiles.every(t => t.x >= 0 && t.y >= 0 && t.x + t.w <= 1200 + 1 && t.y + t.h <= 2400 + 1), tiles.filter(t => t.x < 0 || t.y < 0));
  // 全覆蓋：聯集面積 >= 原圖（有重疊的條件下）
  const covered = new Set();
  for (const t of tiles) {
    for (let y = t.y; y < t.y + t.h; y += 4) for (let x = t.x; x < t.x + t.w; x += 4) covered.add(`${x},${y}`);
  }
  let expected = 0;
  for (let y = 0; y < 2400; y += 4) for (let x = 0; x < 1200; x += 4) expected++;
  ok('T1b 全圖覆蓋（抽樣 >= 99%）', covered.size >= expected * 0.99, `${covered.size}/${expected}`);
}
// ── T1c 片尺寸含重疊 ──
{
  const tiles = tileGrid({ width: 900, height: 900 }, 3, 3);
  const t = tiles[0];
  const expectedW = Math.round(300 * (1 + OVERLAP_RATIO));
  ok('T1c 片寬 = 格寬×1.25（含重疊）', t.w === expectedW, `${t.w} vs ${expectedW}`);
}
// ── T2 crossTileVote：重疊字保留 / 切半碎片丟棄 ──
{
  // 900 高圖、3×1 網格（3 橫片）：片0 (0,0,375,900)、片1 (262,0,375,900)、片2 (525,0,375,900)
  const tiles = tileGrid({ width: 900, height: 300 }, 3, 1);
  // 模擬：'marathon' 完整出現在片0 核心區（cx=180）；'th' 碎片只在片0 邊緣（cx=370 貼片0右緣375）
  // 'glycogen' 在片0 邊緣+片1 出現（重疊區驗證）
  const perTile = [
    { tile: 0, tokens: [
      { t: 'marathon', cx: 180, cy: 150 },      // 片0 核心 → keep（safeCore）
      { t: 'glycogen', cx: 350, cy: 150 },      // 片0 邊緣（但有片1 佐證）
      { t: 'th', cx: 372, cy: 150 },            // 片0 貼右緣、無他片 → dropped
    ]},
    { tile: 1, tokens: [
      { t: 'glycogen', cx: 280, cy: 150 },      // 片1 出現 → glycogen multi → keep
    ]},
    { tile: 2, tokens: [] },
  ];
  const { keep, dropped } = crossTileVote(perTile, tiles);
  ok('T2a 核心區完整字保留', keep.has('marathon'), [...keep]);
  ok('T2b 重疊區多片字保留', keep.has('glycogen'), [...keep]);
  ok('T2c 貼緣單片碎片丟棄', dropped.has('th') && !keep.has('th'), { keep: [...keep], dropped: [...dropped] });
}
// ── T2d 無 bbox 引擎退路：單片出現仍保留（保守）──
{
  const tiles = tileGrid({ width: 600, height: 300 }, 2, 1);
  const perTile = [
    { tile: 0, tokens: [{ t: 'apple' }] },   // 無 cx/cy → 視為安全（退路保守）
    { tile: 1, tokens: [] },
  ];
  const { keep } = crossTileVote(perTile, tiles);
  ok('T2d 無 bbox token 保守保留', keep.has('apple'), [...keep]);
}
// ── T3 tileUpscaleFactor ──
{
  ok('T3a 片寬 375 → 2x', tileUpscaleFactor(375) === 2);
  ok('T3b 片寬 1000 → 1x', tileUpscaleFactor(1000) === 1);
}
// ── T4 buildQueue ──
{
  const q = buildQueue([{ name: 'a.jpg' }, { name: 'b.jpg' }]);
  ok('T4 佇列標號', q[0].label.includes('1/2') && q[1].label.includes('2/2'), q.map(x => x.label));
}

console.log(fail === 0 ? `\n═══ ${total - fail}/${total} ALL PASS ═══` : `\n═══ ${fail} FAIL / ${total} ═══`);
process.exit(fail ? 1 : 0);
