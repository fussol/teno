#!/usr/bin/env python3
"""官方 FSRS 權重優化 — CLI 版 (fsrs-rs 6.6.1 via fsrs_rs_python binding)

取代自寫 JS 優化器 (src/core/fsrs-optimizer.js)。資料對映完全複製
src-tauri/src/lib.rs 的 optimize_fsrs command (GUI 那條官方路徑):
  - 依 word_id 分組, 依 elapsed_days 升冪排序
  - 每卡第一筆 delta_t = 0, 其後 = elapsed_days
  - rating 0-idx (JS) + 1 → 1-idx (官方), clamp [1,4]
  - 過濾: 每卡 ≥ 2 筆 且至少一筆跨日 (delta_t > 0)
  - 官方 compute_parameters (預設 TrainingConfig, 與 GUI 相同)

Usage:
  python tools/fsrs-optimize.py --db <teno.db>            # 權重輸出到 stdout (預設)
  python tools/fsrs-optimize.py --db <teno.db> --json     # JSON 輸出 {weights, loss, elapsedMs}
"""
import argparse
import json
import sqlite3
import sys
import time

from fsrs_rs_python import FSRS, FSRSItem, FSRSReview


def load_reviews(db_path, mode=None):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if mode is None:
            rows = con.execute(
                "SELECT word_id, rating, elapsed_days FROM review_log ORDER BY id"
            ).fetchall()
        else:
            # 舊資料 mode 可能為 NULL → 視同 flip（與 db.js 讀回 r.mode || 'flip' 一致）
            rows = con.execute(
                "SELECT word_id, rating, elapsed_days FROM review_log "
                "WHERE COALESCE(mode, 'flip') = ? ORDER BY id",
                (mode,),
            ).fetchall()
    finally:
        con.close()
    return rows


def build_items(rows):
    """複製 lib.rs optimize_fsrs 的 mapping → FSRSItem list (未過濾前)."""
    by_card = {}
    for word_id, rating, elapsed_days in rows:
        by_card.setdefault(word_id, []).append((rating, elapsed_days))

    items = []
    for rs in by_card.values():
        # 依 elapsed_days 升冪 (None → 0), 與 Rust unwrap_or(0) 一致
        rs.sort(key=lambda x: x[1] if x[1] is not None else 0)
        f_reviews = []
        first = True
        has_positive = False
        for rating, elapsed_days in rs:
            d = 0 if first else int(elapsed_days or 0)
            first = False
            if d > 0:
                has_positive = True
            # JS 0-idx → 官方 1-idx, clamp [1,4] (與 Rust (r.rating+1).min(4).max(1) 一致)
            f_reviews.append(FSRSReview(rating=max(1, min(4, rating + 1)), delta_t=d))
        if len(f_reviews) >= 2 and has_positive:
            items.append(FSRSItem(f_reviews))
    return items


def main():
    ap = argparse.ArgumentParser(description="官方 FSRS 權重優化 (fsrs-rs 6.6.1)")
    ap.add_argument("--db", required=True, help="teno SQLite DB 路徑")
    ap.add_argument("--mode", default=None, choices=["flip", "mc", "spell"],
                    help="只優化指定模式的複習記錄（預設：全部模式混算）")
    ap.add_argument("--json", action="store_true", help="JSON 輸出")
    args = ap.parse_args()

    def fail(msg):
        if args.json:
            print(json.dumps({"error": msg}))
        else:
            print(msg)
        sys.exit(1)

    rows = load_reviews(args.db, args.mode)
    if len(rows) < 10:
        fail(f"複習記錄不足: {len(rows)} 筆 (需 ≥ 10)")

    items = build_items(rows)
    if not items:
        fail("沒有足夠的有效複習記錄（至少需要一個包含跨日複習的卡片）")

    t0 = time.time()
    try:
        fsrs = FSRS([])  # 空 params → 官方 default 初始化
        params = fsrs.compute_parameters(items)
    except Exception as e:
        fail(f"FSRS 優化失敗: {e!r}")
    elapsed_ms = int((time.time() - t0) * 1000)

    loss = None
    try:
        loss = float(fsrs.evaluate(items).log_loss)
    except Exception:
        loss = None

    if args.json:
        print(json.dumps({
            "mode": args.mode,
            "weights": [float(x) for x in params],
            "loss": loss,
            "elapsedMs": elapsed_ms,
            "reviewCount": len(rows),
            "items": len(items),
        }))
    else:
        print(", ".join(f"{x:.4f}" for x in params))
        print(f"# loss={loss:.4f} elapsed={elapsed_ms}ms items={len(items)}" if loss is not None
              else f"# elapsed={elapsed_ms}ms items={len(items)}")


if __name__ == "__main__":
    main()
