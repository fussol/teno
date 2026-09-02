// ═══════════════════════════════════════════════════════════════
// OCR 切割 B′ — 兩態狀態機 + 四角 handle 的「純運算層」
// （OCR-OPTIMIZE-plan B 段 B-1′）
//
// 需求（總統裁示 2026-08-30, 取代原 B-1 信框）：預覽圖純瀏覽可滑動 →
// 按「切割」進切割態 → 拖「四角 handle」四點連線成形（定位置+形狀，
// 可任意四邊形）→ 完成/取消回預覽。
//
// 本檔＝純函式層（零 DOM），只做座標/狀態運算，供 ocr.js slimmer 使用
// 並供 node harness 無頭測試（對齊 preprocess.js 模式）。
// cropToFile 現行實作是「軸向矩形」——本 B′ 依計畫 B.6 的選項：四角連線
// 成形（視覺任意四邊形），實際裁切取四角的包圍矩形 minX/minY/maxX/maxY
// （維持既有 AXIS-ALIGNED 裁切路徑，不引進透視）。
// ═══════════════════════════════════════════════════════════════

/**
 * 四角 handle 的角點索引（順時針：0=左上, 1=右上, 2=右下, 3=左下）。
 * corners 為長度 4 的 [{x,y},...]。
 */
export const CORNER_COUNT = 4;

/**
 * 由四角顯示座標 → 軸向包圍矩形 {x,y,w,h}（顯示座標系）。
 * 供 cropToFile 裁切用：取四角 minX/minY/maxX/maxY。
 * @param {{x:number,y:number}[]} corners 長度4
 * @returns {{x:number,y:number,w:number,h:number}|null} （corners 不完整時 null）
 */
export function cornersToRect(corners) {
  if (!Array.isArray(corners) || corners.length !== CORNER_COUNT) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of corners) {
    if (!c || typeof c.x !== 'number' || typeof c.y !== 'number') return null;
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 把四個「顯示座標」角點經 mapToSource 映射為「原圖座標」角點。
 * @param {{x:number,y:number}[]} dispCorners
 * @param {number} dispW 顯示寬
 * @param {number} dispH 顯示高
 * @param {number} imgW 原圖寬
 * @param {number} imgH 原圖高
 * @param {(sx:number,sy:number,dW:number,dH:number,iW:number,iH:number)=>any} [mapToSource]
 * @returns {{x:number,y:number}[] | null} 原圖座標四角
 */
export function mapCornersToSource(dispCorners, dispW, dispH, imgW, imgH, mapToSource = defaultMapToSource) {
  if (!Array.isArray(dispCorners) || dispCorners.length !== CORNER_COUNT) return null;
  return dispCorners.map(c => {
    const s = mapToSource(c.x, c.y, dispW, dispH, imgW, imgH);
    return { x: s.sx, y: s.sy };
  });
}

/** 預設映射：顯示座標 → 原圖座標（與 ocr.js mapToSource 同構，純函式） */
export function defaultMapToSource(sx, sy, dispW, dispH, imgW, imgH) {
  const sxr = dispW > 0 ? imgW / dispW : 0;
  const syr = dispH > 0 ? imgH / dispH : 0;
  return {
    sx: Math.max(0, Math.min(imgW, Math.round(sx * sxr))),
    sy: Math.max(0, Math.min(imgH, Math.round(sy * syr))),
  };
}

/**
 * 把第 idx 個角點拖到 (nx,ny)，clamp 在 [0,dispW]×[0,dispH]。
 * 回新的 corners 陣列（immutable）。
 * @param {{x:number,y:number}[]} corners
 * @param {number} idx 0..3
 * @param {number} nx 顯示 x（未 clamp）
 * @param {number} ny 顯示 y（未 clamp）
 * @param {number} dispW
 * @param {number} dispH
 * @returns {{x:number,y:number}[]}
 */
export function moveCorner(corners, idx, nx, ny, dispW, dispH) {
  if (idx < 0 || idx >= CORNER_COUNT) return corners.slice();
  const out = corners.length === CORNER_COUNT ? corners.map(c => ({ x: c.x, y: c.y })) : defaultCorners(dispW, dispH);
  out[idx] = {
    x: Math.max(0, Math.min(dispW, nx)),
    y: Math.max(0, Math.min(dispH, ny)),
  };
  return out;
}

/**
 * 預設四角：影像中央 60% 框（顯示座標），供初進切割態/未動前預置。
 * @param {number} dispW
 * @param {number} dispH
 * @returns {{x:number,y:number}[]} [左上,右上,右下,左下]
 */
export function defaultCorners(dispW, dispH) {
  const mx = dispW * 0.2, my = dispH * 0.2;
  const w = dispW * 0.6, h = dispH * 0.6;
  return [
    { x: mx, y: my },                       // 0 左上
    { x: mx + w, y: my },                   // 1 右上
    { x: mx + w, y: my + h },               // 2 右下
    { x: mx, y: my + h },                   // 3 左下
  ];
}

/**
 * 依 cropMode 決定 touch-action（preview 可捲動 / cutting 鎖定）。
 * 純函式供 harness 負控制（把預設改回 'cutting' → 鎖 scroll 重現原 bug）。
 * @param {'preview'|'cutting'} mode
 * @returns {string}
 */
export function touchActionFor(mode) {
  return mode === 'cutting' ? 'none' : 'auto';
}

/**
 * 依 cropMode 決定「wrap 是否綁切割 pointer 事件」。
 * preview 態回 false（不綁 → 手機可正常滑頁）。
 * @param {'preview'|'cutting'} mode
 * @returns {boolean}
 */
export function bindsCropPointer(mode) {
  return mode === 'cutting';
}

/**
 * 防誤判：拖動單角後若四角成自交（bowtie：非相鄰邊相交），滾回包圍矩形；
 * 否則只各自 clamp 在顯示範圍。回新的 corners。
 * 自交判定：檢查「非相鄰邊」邊0-1 vs 邊2-3、邊1-2 vs 邊3-0 是否相交。
 *   ——不能用對角線(ac vs bd)測：正常凸四邊形的對角線本就必交於內部，
 *     會把每個合法四邊形誤判成自交、強制拉回軸向矩形（毀掉任意四邊形）。
 * @param {{x:number,y:number}[]} corners
 * @param {number} dispW
 * @param {number} dispH
 * @returns {{x:number,y:number}[]} corners（已矯正不自交）
 */
export function untangleCorners(corners, dispW, dispH) {
  if (!Array.isArray(corners) || corners.length !== CORNER_COUNT) return corners;
  // 檢查自交：非相鄰邊相交（0-1 vs 2-3；1-2 vs 3-0）
  const selfCross =
    segmentsIntersect(corners[0], corners[1], corners[2], corners[3]) ||
    segmentsIntersect(corners[1], corners[2], corners[3], corners[0]);
  if (selfCross) {
    const r = cornersToRect(corners);
    if (!r) return corners;
    return [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ];
  }
  // 非自交 → 讓角點各自 clamp 在顯示範圍（bounds sanity）
  return corners.map(c => ({
    x: Math.max(0, Math.min(dispW, c.x)),
    y: Math.max(0, Math.min(dispH, c.y)),
  }));
}

/** 線段 AB 與 CD 是否相交（含端點相接除外）。純幾何。 */
function segmentsIntersect(a, b, c, d) {
  function ccw(p, q, r) {
    return (r.y - p.y) * (q.x - p.x) - (q.y - p.y) * (r.x - p.x);
  }
  const d1 = ccw(c, d, a), d2 = ccw(c, d, b);
  const d3 = ccw(a, b, c), d4 = ccw(a, b, d);
  return (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
          ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)));
}