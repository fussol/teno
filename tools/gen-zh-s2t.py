#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""產生 src-tauri/src/zh_s2t.tsv（簡→繁字表，給 SIMPLIFIED-LOCK 用）並自我驗證

用法：python3 tools/gen-zh-s2t.py   （需要系統 opencc + fcitx5 的 gbks2t.tab）
重新產生後務必跑 `cargo test --lib zhlock_tests`（8 條，含安全性質）。

來源①：fcitx gbks2t.tab（簡體→繁體；含「本身合法」資訊）
來源②：opencc jp2t（日文漢字→繁體；模型多語混入時會吐日文形）

安全規則（兩者共用）：
  若某字「本身即合法繁體」→ 不轉（例：台/后/里/系/只，避免把「台語」「皇后」轉壞）
"""
import json, os, pathlib
from collections import defaultdict
from opencc import OpenCC

FCI = "/usr/share/fcitx5/chttrans/gbks2t.tab"
OUT_TSV = str(pathlib.Path(__file__).resolve().parent.parent / "src-tauri/src/zh_s2t.tsv")
# JSON 只是驗證用的中間產物，不進 repo（前端透過 zh_traditional 命令取表，維持單一來源）
OUT_JSON = os.path.join(os.path.dirname(OUT_TSV), ".zh_s2t.build.json")

# ── 來源①  ────────────────────────────────────────────
pairs = defaultdict(list)
with open(FCI, encoding="utf-8") as f:
    for line in f:
        line = line.rstrip("\n")
        if len(line) != 2:
            continue
        pairs[line[0]].append(line[1])

self_valid = set()          # 本身即合法繁體的簡體字
table = {}
for s, ts in pairs.items():
    if s in ts:
        self_valid.add(s)
        continue
    # 保序去重後取第一候選
    seen, first = set(), None
    for t in ts:
        if t not in seen:
            seen.add(t)
            if first is None:
                first = t
    if first:
        table[s] = first

# ── 來源②  日文漢字 ───────────────────────────────────
jp2t = OpenCC("jp2t")
jp_added = 0
jp_skipped = 0
for cp in range(0x4E00, 0xA000):          # CJK 統一表意文字基本區
    c = chr(cp)
    t = jp2t.convert(c)
    if t == c or len(t) != 1:
        continue
    if c in self_valid:                    # 本身合法繁體 → 不動
        jp_skipped += 1
        continue
    if c in table:                         # 已有簡體來源的映射 → 以簡體來源為準
        continue
    table[c] = t
    jp_added += 1

print(f"來源① fcitx：{len(table) - jp_added} 條")
print(f"來源② jp2t ：補 {jp_added} 條（略過 self-valid {jp_skipped}）")
print(f"本身即合法繁體而略過（不轉）：{len(self_valid)} 字")
print(f"合計：{len(table)} 條")

# ── 驗證 ──────────────────────────────────────────────
def conv(s): return "".join(table.get(c, c) for c in s)

keep = ["鑰匙,關鍵,鎖定","奔跑,經營,流傳","光,光亮,淡色","邀請,請柬,引誘",
        "手工藝人,藝匠,工匠","磁鐵,吸引物,磁力","出汗","違反,侵犯,破壞",
        "保護,保存,維護","永久地,永久,永久性","完成的,嫻熟的,有造詣的",
        "皇后","台灣","系統","只是","裡面","後面","頭髮","經濟","實現"]
kbad = [s for s in keep if conv(s) != s]

fix = ["这个单词的意思是钥匙","学习英语很难","开发软件","面对困难","门","问题",
       "経済","実現","変対","発図","帰気","単読","訳戦","験価","楽"]
print("\n  ① 正確繁體零改動：", "✅ 全部" if not kbad else f"❌ {kbad}")
print("  ② 漏字（含日文漢字）修復：")
for s in fix:
    print(f"     {s}  →  {conv(s)}")

# ── 輸出 ──────────────────────────────────────────────
with open(OUT_TSV, "w", encoding="utf-8") as f:
    for s in sorted(table):
        f.write(f"{s}\t{table[s]}\n")
with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump(table, f, ensure_ascii=False, separators=(",", ":"))
print(f"\n  TSV → {OUT_TSV}（{os.path.getsize(OUT_TSV)} bytes）")
print(f"  JSON→ {OUT_JSON}（{os.path.getsize(OUT_JSON)} bytes）")
