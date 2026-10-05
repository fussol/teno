// EXAMGEST：測驗頁共用手勢追蹤（翻卡判分／多選選項移動共用）
// 一輪 = pointerdown → pointerup/pointercancel，分辨「點擊 vs 拖曳」。
// 捲動分工靠頁面掛 .exam-gest（touch-action:pan-y）：
//   垂直拖＝瀏覽器捲動 → pointercancel → onCancel 回彈；水平拖＝手勢本體。
//   桌機 mouse 不受 touch-action 影響 → 四向皆可判。
//   ponytail: 觸控 ↑↓ 判分先不做（要做得改 touch-action:none＋手動捲動，
//   代價＝快速甩動頁面會被誤判成答題）；先以水平為觸控主手勢。
const TAP = 10;

export function dragTrack(el, cb) {
  if (!el) return () => {};
  let sx = 0, sy = 0, down = false, moved = false, downT = null, capId = null;
  const release = () => { if (capId != null) { try { el.releasePointerCapture(capId); } catch {} capId = null; } };
  const onDown = (ev) => {
    if (ev.button != null && ev.button > 0) return;
    if (cb.when && !cb.when(ev)) return;   // 區域外（非本頁活頁）→ 不追蹤、不擷 pointer capture
    if (cb.ignore && ev.target && ev.target.closest && ev.target.closest(cb.ignore)) return;
    down = true; moved = false; downT = ev.target;
    sx = ev.clientX; sy = ev.clientY;
    cb.onDown && cb.onDown(ev);
    capId = ev.pointerId;
    try { el.setPointerCapture(ev.pointerId); } catch {}
  };
  const onMove = (ev) => {
    if (!down) return;
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!moved) {
      if (Math.hypot(dx, dy) <= TAP) return;
      moved = true;
    }
    cb.onMove && cb.onMove(dx, dy, ev);
  };
  const onUp = (ev) => {
    if (!down) return;
    down = false;
    release();   // 顯式釋放（mobile：capture 未釋放會讓後續原生捲動被常駐元素吃住）
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!moved) { cb.onTap && cb.onTap(downT || ev.target, ev); return; }
    cb.onEnd && cb.onEnd(dx, dy, dirOf(dx, dy));
  };
  const onCancel = () => {
    if (!down) return;
    down = false;
    release();
    cb.onCancel && cb.onCancel();
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  // 回傳清理器：離頁時移除監聽並釋放任何殘留 capture（#contentArea 為常駐節點，不清會累積）
  return () => {
    release();
    down = false;
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
  };
}

export function dirOf(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy < 0 ? 'up' : 'down';
}
