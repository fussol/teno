#!/usr/bin/env python3
"""MEDIAPEEL1 一次性搬遷：word_images data: URL → media/<sha1>.<ext> ＋回填 sha1＋清空 data。
冪等可重跑（已有 sha 的列跳過；同內容去重天然合一）。
用法：python3 tools/peel-media-once.py <db> <media_dir> [--execute]
預設 dry-run 只報表；--execute 才寫。
"""
import sqlite3, re, base64, hashlib, os, sys

def parse_data_url(s):
    s = (s or '').strip()
    if not s.startswith('data:'): return None
    c = s.find(',')
    if c < 0: return None
    head, b64 = s[:c], s[c+1:]
    if ';base64' not in head: return None
    mime = head[5:].split(';')[0]
    if not mime.startswith('image/'): return None
    try: raw = base64.b64decode(b64)
    except Exception: return None
    return mime, raw

MIME_EXT = {'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/gif':'gif',
            'image/webp':'webp','image/bmp':'bmp','image/svg+xml':'svg','image/avif':'avif'}

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(2)
    db, mdir = sys.argv[1], sys.argv[2]
    do = '--execute' in sys.argv
    os.makedirs(mdir, exist_ok=True)
    c = sqlite3.connect(db)
    try: c.execute("SELECT sha1 FROM word_images LIMIT 0"); has_sha = True
    except Exception: has_sha = False
    if not has_sha:
        print("無 sha1 欄（v15 未跑），先升級再搬"); sys.exit(1)
    rows = c.execute("SELECT id, word_id, filename, data, sha1 FROM word_images").fetchall()
    todo, skip_http, skip_have, bad = [], 0, 0, 0
    for i, wid, fn, data, sha in rows:
        if (sha or '').strip(): skip_have += 1; continue
        t = (data or '').strip()
        if t.startswith('http'): skip_http += 1; continue
        p = parse_data_url(t)
        if not p: bad += 1; print(f"  BAD id={i} wid={wid} fn={fn[:30]}"); continue
        todo.append((i, wid, fn, p))
    print(f"總列 {len(rows)}：待搬 {len(todo)}，已有 sha {skip_have}，直連保留 {skip_http}，壞圖 {bad}")
    # 去重預覽
    seen = {}
    for i, wid, fn, (mime, raw) in todo:
        h = hashlib.sha1(raw).hexdigest()
        seen.setdefault(h, []).append((i, wid))
    print(f"待搬去重後 {len(seen)} 個檔")
    for h, v in seen.items():
        if len(v) > 1: print(f"  去重合一 sha={h[:12]} 列={[x[0] for x in v]}")
    if not do:
        print("dry-run，未寫入。加 --execute 執行。"); return
    nfiles = 0
    for h, v in seen.items():
        mime, raw = None, None
        for i, wid, fn, p in todo:
            if hashlib.sha1(p[1]).hexdigest() == h: mime, raw = p; break
        ext = MIME_EXT.get(mime or '', 'bin')
        fp = os.path.join(mdir, f"{h}.{ext}")
        if not os.path.isfile(fp):
            open(fp, 'wb').write(raw); nfiles += 1
    for i, wid, fn, (mime, raw) in todo:
        h = hashlib.sha1(raw).hexdigest()
        ext = MIME_EXT.get(mime or '', 'bin')
        fn2 = fn if fn and '.' in fn else f"{(fn or 'img')}.{ext}" if fn else f"img.{ext}"
        # data 欄清空（瘦身本體），sha 回填
        c.execute("UPDATE word_images SET sha1=?, filename=?, data='' WHERE id=?", (h, fn2, i))
    c.commit()
    # VACUUM 收回空間
    c.execute("VACUUM"); c.commit()
    sz = os.path.getsize(db)
    print(f"搬完：新檔 {nfiles} 個，DB 大小 {sz/1048576:.2f} MB")
    c.close()

main()
