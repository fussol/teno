#!/usr/bin/env node
// ═══ VERIFY-VISION-V2 — Vision adapter 實測升級驗證 ═══
// 測純函式層（node 無 DOM）：mergeSliceTexts 去重拼合 / detectDarkTextBands /
// 預設模型切換 / parseChatToOcrResult 相容。canvas 部分（shrinkToDataUrl、
// enhanceDarkBand）由結構釘守護（node 無法執行 canvas）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/ocr/vision-adapter.js'), 'utf8');
const mod = await import('file://' + path.join(ROOT, 'src/lib/ocr/vision-adapter.js'));

let fail = 0, total = 0;
const ok = (l, c, d) => { total++; if (!c) { fail++; console.log(`FAIL ${l}${d ? ' :: ' + JSON.stringify(d) : ''}`); } else console.log(`PASS ${l}`); };

// ── T1 mergeSliceTexts：重疊區重複行去重 ──
{
  const r = mod.mergeSliceTexts([
    'Line A\nLine B\nLine C',
    'Line B\nLine C\nLine D',   // B C 重疊
    'Line D\nLine E',
  ]);
  ok('T1a 重疊行去重拼合', r === 'Line A\nLine B\nLine C\nLine D\nLine E', r);
}
{
  const r = mod.mergeSliceTexts(['', 'Only one']);
  ok('T1b 空片容忍', r === 'Only one', r);
}
// ── T2 detectDarkTextBands ──
{
  // 合成：上半亮（200）下半暗帶有字（60±40）
  const w = 100, h = 1000;
  const gray = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 200;
      if (y >= 600) v = (((x + y) % 32 < 16) ? 0 : 120);   // 暗帶高對比假字（0/120 全幅交替：50/50 伯努利 std=60>25；真實照片 std 實測 35.6）
      gray[y * w + x] = v;
    }
  }
  const { bands, minMean } = mod.detectDarkTextBands(gray, w, h);
  ok('T2a 暗帶偵測（y>=600 有字帶）', bands.length >= 1 && bands[0].y1 >= 560, JSON.stringify(bands));
  ok('T2b minMean < 90（觸發增強）', minMean < 90, minMean);
}
{
  const w = 50, h = 400;
  const gray = new Uint8ClampedArray(w * h).fill(240);
  const { bands, minMean } = mod.detectDarkTextBands(gray, w, h);
  ok('T2c 全亮平面零帶', bands.length === 0, JSON.stringify(bands));
}
// ── T3 預設模型切換（qwen3-ocr64k → qwen2.5vl:7b）──
{
  ok('T3a 預設模型改 qwen2.5vl:7b', /'qwen2\.5vl:7b'/.test(SRC));
  ok('T3b 舊預設不再 hardcode 為唯一 fallback', !/model = \(await getSetting\('ocrVisionModel'\)\) \|\| 'qwen3-ocr64k'/.test(SRC));
  ok('T3c 使用者設定鍵保留（ocrVisionModel 覆蓋點）', /getSetting\('ocrVisionModel'\)/.test(SRC));
}
// ── T4 縮圖結構釘（node 無 canvas，守護呼叫鏈在位）──
{
  ok('T4a VISION_MAX_DIM=1280 導出', mod.VISION_MAX_DIM === 1280);
  ok('T4b SLICE_TRIGGER_H=1400 導出', mod.SLICE_TRIGGER_H === 1400);
  ok('T4c recognize 含 shrinkToDataUrl 呼叫', /shrinkToDataUrl\(bitmap, w, h\)/.test(SRC));
  ok('T4d 大圖切片 1280+96 重疊', /SLICE_H = 1280, OVERLAP = 96/.test(SRC));
  ok('T4e 暗帶增強掛入 recognize', /enhanceDarkBand\(bitmap, w, h, b\.y1, b\.y2\)/.test(SRC));
  ok('T4f mergeSliceTexts 掛入 recognize', /fullText = mergeSliceTexts\(pieceTexts\)/.test(SRC));
}
// ── T5 parseChatToOcrResult 回歸 ──
{
  const r = mod.parseChatToOcrResult({ message: { content: 'hello' } });
  ok('T5 chat 解析回歸', r.text === 'hello' && r.confidence === 1 && r.blocks.length === 1);
}
// ── T6 桌面限定回歸（node 下 false）──
{
  ok('T6 isDesktopEnv node=false', mod.isDesktopEnv() === false);
}

console.log(fail === 0 ? `\n═══ ${total - fail}/${total} ALL PASS ═══` : `\n═══ ${fail} FAIL / ${total} ═══`);
process.exit(fail ? 1 : 0);
