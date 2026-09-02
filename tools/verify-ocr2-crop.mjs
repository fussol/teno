#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-OPTIMIZE B′ 段 — 切割兩態（preview/cutting）＋四角 handle 驗證
// 檔案: tools/verify-ocr2-crop.mjs
//
// 測 src/lib/ocr/crop.js 純函式層（零 DOM，直接 import）+ 靜態釘 ocr.js：
//   T1 cornersToRect：四角 → 軸向包圍矩形（min/min/max/max）；不完整回 null
//   T2 moveCorner：拖單角 clamp 在 [0,dispW]×[0,dispH]；越界(idx)自保
//   T3 defaultCorners：中央 60% 框，四點順序 [左上,右上,右下,左下]
//   T4 untangleCorners：對角線自交 → 矯正回包圍矩形；非自交 → 各自 clamp
//   T5 mapCornersToSource：顯示座標 → 原圖 px 映射（不越界）
//   T6 touchActionFor / bindsCropPointer：
//        preview → 'auto'（可捲動）+ 不綁切割 pointer（不影響滑頁）
//        cutting → 'none' + 綁（切割態鎖 scroll 合理）
//   NC 負控制：把 _cropMode 預設當成 'cutting' → touchActionFor='none' +
//      bindsCropPointer=true → 精準重現「進 OCR 頁影響滑動」原 bug
//   NCS 靜態釘 ocr.js：.ocr-img-wrap 無 touch-action:none、wrap 不綁
//      pointerdown 切割、handle pointerdown guard 要求 cutting 態。
// 用法: node tools/verify-ocr2-crop.mjs
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORNER_COUNT, cornersToRect, defaultCorners, moveCorner,
  untangleCorners, mapCornersToSource, defaultMapToSource,
  touchActionFor, bindsCropPointer,
} from '../src/lib/ocr/crop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OCR_SRC = fs.readFileSync(path.join(ROOT, 'src/pages/ocr.js'), 'utf8');

let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
};

console.log('═══ OCR2-B′ 切割兩態 四角 handle 驗證 ═══');

// T1 cornersToRect：四角 → 軸向包圍矩形
{
  const r = cornersToRect([
    { x: 10, y: 10 }, { x: 100, y: 20 }, { x: 90, y: 80 }, { x: 5, y: 70 },
  ]);
  check('T1a 包圍矩形 {x:5,y:10,w:95,h:70}', r, { x: 5, y: 10, w: 95, h: 70 });
  check('T1b 非四角 → null', cornersToRect([{ x: 1, y: 2 }, { x: 3, y: 4 }]), null);
  check('T1c 含非數字 → null', cornersToRect([{ x: 1, y: 2 }, { x: 'a', y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }]), null);
  check('T1d 非陣列 → null', cornersToRect('x'), null);
  check('T1e 零邊長矩形成立', cornersToRect([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }]), { x: 5, y: 5, w: 0, h: 0 });
}

// T2 moveCorner：拖單角 + clamp
{
  const base = defaultCorners(200, 100);
  const out = moveCorner(base, 0, -50, 500, 200, 100);   // 溢出 → clamp
  check('T2a idx0 clamp [0,200]', out[0], { x: 0, y: 100 });
  check('T2b 其餘角不動', out[1], base[1]);
  check('T2c idx 越界 → 回拷貝不變', moveCorner(base, 9, 5, 5, 200, 100), base);
  const mid = moveCorner(base, 2, 150, 60, 200, 100);
  check('T2d idx2 正常到位', mid[2], { x: 150, y: 60 });
}

// T3 defaultCorners：中央 60% 框
{
  const c = defaultCorners(200, 100);
  check('T3a 長度 4', c.length, 4);
  check('T3b 左上=(40,20)', c[0], { x: 40, y: 20 });
  check('T3c 右上=(160,20)', c[1], { x: 160, y: 20 });
  check('T3d 右下=(160,80)', c[2], { x: 160, y: 80 });
  check('T3e 左下=(40,80)', c[3], { x: 40, y: 80 });
}

// T4 untangleCorners：自交矯正
{
  // 真正自交（bowtie / X 形）：邊0-1=(0,0)-(2,2) 與 邊2-3=(0,2)-(2,0) 在 (1,1) 交叉
  const bowtie = [
    { x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 },
  ];
  const fixed = untangleCorners(bowtie, 100, 100);
  // 應矯正回包圍矩形 {0,0,2,2}
  check('T4a 自交(X形) → 回包圍矩形', fixed, [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 },
  ]);
  // 非自交凸四邊形（例：梯形，非軸向）→ 不被強制拉回矩形，只 clamp——保住「任意四邊形」
  const trapezoid = [
    { x: 10, y: 10 }, { x: 80, y: 20 }, { x: 70, y: 90 }, { x: 20, y: 85 },
  ];
  const kept = untangleCorners(trapezoid, 100, 100);
  check('T4b 凸梯形保留四角（不強制矩形）', kept, [
    { x: 10, y: 10 }, { x: 80, y: 20 }, { x: 70, y: 90 }, { x: 20, y: 85 },
  ]);
  // 退化：單點（三點同）非自交 → 原樣 clamp
  const degenerated = untangleCorners([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }], 100, 100);
  check('T4c 退化單點保持', degenerated[0], { x: 5, y: 5 });
  // 邊界 clamp：非自交但出界 → 各自收進 [0,disp]
  const clampOk = [
    { x: -5, y: 0 }, { x: 50, y: 10 }, { x: 40, y: 200 }, { x: 0, y: 100 },
  ];
  const clamped = untangleCorners(clampOk, 100, 100);
  check('T4d 非自交出界 → 各自 clamp', clamped, [
    { x: 0, y: 0 }, { x: 50, y: 10 }, { x: 40, y: 100 }, { x: 0, y: 100 },
  ]);
}

// T5 mapCornersToSource / defaultMapToSource：顯示→原圖映像
{
  const src = mapCornersToSource([
    { x: 40, y: 20 }, { x: 160, y: 20 }, { x: 160, y: 80 }, { x: 40, y: 80 },
  ], 200, 100, 4000, 2000);
  check('T5a 四角映射', src, [
    { x: 800, y: 400 }, { x: 3200, y: 400 }, { x: 3200, y: 1600 }, { x: 800, y: 1600 },
  ]);
  const src2 = mapCornersToSource([{ x: 0, y: 0 }], 200, 100, 4000, 2000);  // 非四角
  check('T5b 非四角 → null', src2, null);
  const single = defaultMapToSource(5000, 3000, 200, 100, 4000, 2000);  // 超出 → clamp 到原圖邊
  check('T5c 顯示→原圖 越界 clamp', single, { sx: 4000, sy: 2000 });
}

// T6 touchActionFor / bindsCropPointer：preview 態可捲動／不綁切割 pointer
{
  check('T6a preview touch-action = auto（可捲動）', touchActionFor('preview'), 'auto');
  check('T6b preview 不綁切割 pointer', bindsCropPointer('preview'), false);
  check('T6c cutting touch-action = none（切割態鎖）', touchActionFor('cutting'), 'none');
  check('T6d cutting 綁切割 pointer', bindsCropPointer('cutting'), true);
}

// NC 負控制：把 _cropMode 預設當成 'cutting' → 鎖 scroll → 重現「進 OCR 頁影響滑動」
{
  check('NC1 預設誤為 cutting → touch-action=none（鎖滑動）', touchActionFor('cutting'), 'none');
  check('NC2 預設誤為 cutting → wrap 綁切割 pointer（吃滑頁事件）', bindsCropPointer('cutting'), true);
  // 對照：正確 preview → 兩者皆解
  check('NC3 正確 preview → touch-action=auto', touchActionFor('preview'), 'auto');
  check('NC4 正確 preview → 不綁切割 pointer', bindsCropPointer('preview'), false);
}

// NCS 靜態釘：ocr.js 的實際 DOM/事件束縛（B′ 兩態落地碼）
{
  // CSS：.ocr-img-wrap 不能再有 touch-action:none；.ocr-crop-handle 才有
  const wrapCss = OCR_SRC.match(/\.ocr-img-wrap\{[^}]*\}/)?.[0] || '';
  check('NCS1 .ocr-img-wrap 無 touch-action:none', /touch-action:none/.test(wrapCss), false);
  // wrap 上不直接綁 pointerdown 切割（舊版 wrap.addEventListener('pointerdown'...) 已移除）
  check('NCS2 wrap 無直接 pointerdown 切割綁定', /wrap\.addEventListener\('pointerdown'/.test(OCR_SRC), false);
  // 四角 handle 各自綁 pointerdown，且 guard 要求 _cropMode==='cutting'
  check('NCS3 四角 handle 綁 pointerdown', /handles\.forEach\(\(h, i\)/.test(OCR_SRC), true);
  check('NCS4 handle pointerdown guard cutting 態', /_cropMode !== 'cutting'/.test(OCR_SRC), true);
  check('NCS5 有「切割」進入鈕', /\bocrCutStartBtn\b/.test(OCR_SRC), true);
  check('NCS6 preview 初始化（let 行，fail-closed：剝離此釘精准重現）', /let _cropMode = 'preview'/.test(OCR_SRC), true);
  check('NCS7 handle pointerdown 綁在 handle 非 wrap', /h\.addEventListener\('pointerdown'/.test(OCR_SRC), true);
  // NCS8（審查 D1）svg 不得有固定 viewBox（否則切割框座標系錯位 2.5~4 倍、出界不可見）
  const svgTag = /<svg[^>]*ocr-crop-svg[^>]*>/.exec(OCR_SRC)?.[0] || '';
  check('NCS8 ocr-crop-svg 無固定 viewBox', /viewBox/.test(svgTag), false);
  // NCS9（審查 D2）「取消」回退 enterCutting 前快照（不再 no-op 保留被污染框）
  check('NCS9 enterCutting 存 _savedCrop 快照', /_savedCrop = _crop \?/.test(OCR_SRC), true);
  check('NCS9b 取消回退 _savedCrop（非 _crop || null no-op）', /_crop = _savedCrop/.test(OCR_SRC), true);
  // NCS10（審查 D3）cutting 態 wrap 鎖 touch-action
  check('NCS10 .ocr-img-wrap.cutting 鎖 touch-action:none', /\.ocr-img-wrap\.cutting\{[^}]*touch-action:none/.test(OCR_SRC), true);
  // NCS11（審查 D4）死碼 .ocr-crop-overlay 已移除
  check('NCS11 無 .ocr-crop-overlay 殘留', /ocr-crop-overlay/.test(OCR_SRC), false);
}

console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
process.exit(failures === 0 ? 0 : 1);