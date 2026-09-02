// ═══════════════════════════════════════════════════════════════
// OCR 局部切割掃描（TILE-SCAN，2026-09-01 元首令）
//
// 需求實錄：「我測試過局部切割的成功率會大幅提升。但這樣會導致產生大量雜訊」
// → 局部放大掃描（每片 2x upscale）字更清楚，但切割邊界切半的字成碎片雜訊。
//
// 解法（本檔純函式層）：
//   1. tileGrid：大圖切 3×3 網格（預設），相鄰片重疊 OVERLAP_RATIO（25%）—
//      被切半的字必然在鄰片完整出現。
//   2. crossTileVote：跨片 token 投票去雜訊 —
//      完整字：在 ≥2 片出現（重疊區）或 離片緣遠（核心區）→ 保留
//      碎片：只在 1 片出現 且 貼近該片切割邊緣（edge zone）→ 丟棄
//   3. tileUpscale：片放大 2x（局部放大掃描的本體）— canvas 層由呼叫端組裝。
//
// 座標系統：網格 (col,row)，片 (x,y,w,h) 為原圖座標。
// 邊緣判定：token 在片內的 bbox 中心距片緣 < EDGE_PX 視為邊緣帶。
// ═══════════════════════════════════════════════════════════════

/** 重疊比例（相鄰片共享 25% 內容） */
export const OVERLAP_RATIO = 0.25;

/** 邊緣帶寬度（原圖 px）：token 中心距片緣小於此值 → 可能被切半 */
export const EDGE_PX = 40;

/**
 * 切割網格：大圖 → 3×3 重疊片（原圖座標）。
 * @param {{width:number, height:number}} dims 原圖尺寸
 * @param {number} [cols=3] @param {number} [rows=3]
 * @returns {Array<{x:number,y:number,w:number,h:number,col:number,row:number}>}
 */
export function tileGrid(dims, cols = 3, rows = 3) {
  const { width: W, height: H } = dims;
  if (W <= 0 || H <= 0) return [];
  const ow = W / cols, oh = H / rows;                    // 無重疊步階（格寬）
  // 片步階 = 格寬（step）；片寬 = 格寬×(1+OVERLAP)（含重疊）；
  // 第 c 格起點 = c×step（格原點），clamp 到 [0, W-tw] 保證片在圖內且非負。
  // （v1 公式 c*ow-(tw-ow)/2 在首格產生負起點 — 實測抓漏，v2 改格原點對齊）
  const stepX = ow, stepY = oh;
  const tw = Math.min(W, Math.round(ow * (1 + OVERLAP_RATIO)));
  const th = Math.min(H, Math.round(oh * (1 + OVERLAP_RATIO)));
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 起點：格原點，尾部格貼齊右/下邊界（覆蓋無殘留），中間格 clamp 上限 W-tw
      let x = Math.round(c * stepX);
      let y = Math.round(r * stepY);
      x = c === cols - 1 ? Math.max(0, W - tw) : Math.min(x, Math.max(0, W - tw));
      y = r === rows - 1 ? Math.max(0, H - th) : Math.min(y, Math.max(0, H - th));
      const w = Math.min(tw, W - x), h = Math.min(th, H - y);
      tiles.push({ x, y, w, h, col: c, row: r });
    }
  }
  return tiles;
}

/**
 * 跨片投票去雜訊（核心）。
 * @param {Array<{tile:number, tokens:Array<{t:string, cx?:number, cy?:number}>}>} perTile
 *   每片的 token 清單（cx/cy = token 在「原圖座標」的中心；引擎 bbox 回原圖座標由呼叫端換算）
 * @param {Array<{x:number,y:number,w:number,h:number}>} tiles 各片原圖座標
 * @returns {{keep:Set<string>, dropped:Set<string>}}
 *   keep：可信 token；dropped：被判碎片的（供 debug/統計）
 */
export function crossTileVote(perTile, tiles) {
  const tokenTiles = new Map();     // token → Set(tile idx)
  const tokenEdgeOnly = new Map(); // token → 是否「只在邊緣帶出現」
  perTile.forEach((entry, tileIdx) => {
    const tile = tiles[tileIdx];
    for (const { t, cx, cy } of entry.tokens) {
      if (!tokenTiles.has(t)) { tokenTiles.set(t, new Set()); tokenEdgeOnly.set(t, true); }
      tokenTiles.get(t).add(tileIdx);
      // 這次出現是否在安全核心區（距片緣 > EDGE_PX）→ 若任一次安全，標記非邊緣依賴
      const safe = cx === undefined || cy === undefined
        ? true   // 無 bbox 資訊：保守視為安全（引擎不支援 bbox 時退回「≥2 片或單片全驗」策略）
        : (cx - tile.x > EDGE_PX && (tile.x + tile.w) - cx > EDGE_PX
           && cy - tile.y > EDGE_PX && (tile.y + tile.h) - cy > EDGE_PX);
      if (safe) tokenEdgeOnly.set(t, false);
    }
  });
  const keep = new Set(), dropped = new Set();
  for (const [t, tileSet] of tokenTiles) {
    const multi = tileSet.size >= 2;                    // 多片出現（重疊區驗證）
    const safeCore = !tokenEdgeOnly.get(t);            // 任一次在安全核心區
    if (multi || safeCore) keep.add(t);
    else dropped.add(t);                              // 只在 1 片且貼緣 = 切半碎片
  }
  return { keep, dropped };
}

/**
 * 片放大倍率建議：片寬 < 900 原圖 px → 2x（局部放大的甜蜜區；
 * 900px 片 2x = 1800px 餵 tesseract，行高倍增小字可讀）。
 * @returns {number} 1 或 2
 */
export function tileUpscaleFactor(tileW) {
  return tileW < 900 ? 2 : 1;
}

/**
 * 多張照片批次描述：N 張 → 依序處理的佇列（供 UI 顯示進度）。
 * @param {Array<{name:string}>} files
 * @returns {Array<{idx:number, name:string, label:string}>}
 */
export function buildQueue(files) {
  return (files || []).map((f, i) => ({
    idx: i, name: f.name || `第 ${i + 1} 張`,
    label: `掃描中 ${i + 1}/${files.length}：${f.name || ''}`,
  }));
}
