#!/usr/bin/env python3
"""下載快照圖片到本機（2026-09-08 使用者裁示：Drive 圖太慢，全部下載）。

流程：export-web-snapshot.py（遠端 lh3 URL）→ 本腳本（下載＋壓縮＋改寫本地路徑）。
- 讀 public/real-data.json，逐唯一 URL 下載到 public/img/<drive-id>.<ext>。
- 已存在的檔案跳過（增量：以後 DB 新增圖片才抓新的）。
- GIF 原樣保留動畫（逐幀縮到 800 以內）；PNG 有透明留 PNG、無透明轉 JPG；
  JPG 最長邊 800、quality 72、progressive（carousel 最寬 440px，夠看）。
- 改寫快照 images[].data 為相對路徑 img/<id>.<ext>（vite 會從 public/ 拷進 dist/）。
- public/img/ 已進 .gitignore（使用者私密圖，不上 GitHub）。
跑法：python3 tools/download-snapshot-images.py
"""
import io
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SNAP = ROOT / 'public/real-data.json'
IMG_DIR = ROOT / 'public/img'
WORKERS = 8
MAX_SIDE = 800
TIMEOUT = 30
try:
    RESAMPLE = Image.Resampling.LANCZOS
except AttributeError:  # Pillow < 9
    RESAMPLE = Image.LANCZOS  # type: ignore[attr-defined]
UA = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'}

_stats = {'ok': 0, 'reuse': 0, 'fail': []}


def existing(id_):
    for ext in ('jpg', 'png', 'gif'):
        p = IMG_DIR / f'{id_}.{ext}'
        if p.exists() and p.stat().st_size > 0:
            return f'img/{id_}.{ext}'
    return None


def process(raw, id_):
    """raw bytes -> (ext, bytes)。GIF 保動畫，其餘壓到 800/72。"""
    head = raw[:6]
    if head in (b'GIF87a', b'GIF89a'):
        im = Image.open(io.BytesIO(raw))
        frames = []
        try:
            n = getattr(im, 'n_frames', 1)
        except Exception:
            n = 1
        for i in range(n):
            try:
                im.seek(i)
            except EOFError:
                break
            f = im.copy()
            f.thumbnail((MAX_SIDE, MAX_SIDE), RESAMPLE)
            frames.append(f)
        dur = im.info.get('duration', 100)
        loop = im.info.get('loop', 0)
        buf = io.BytesIO()
        if len(frames) > 1:
            frames[0].save(buf, format='GIF', save_all=True, append_images=frames[1:],
                           duration=dur, loop=loop, optimize=True)
        else:
            frames[0].save(buf, format='GIF', optimize=True)
        return 'gif', buf.getvalue()
    im = Image.open(io.BytesIO(raw))
    has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
    im.thumbnail((MAX_SIDE, MAX_SIDE), RESAMPLE)
    buf = io.BytesIO()
    if has_alpha:
        im.save(buf, format='PNG', optimize=True)
        return 'png', buf.getvalue()
    if im.mode != 'RGB':
        im = im.convert('RGB')
    im.save(buf, format='JPEG', quality=72, progressive=True, optimize=True)
    return 'jpg', buf.getvalue()


def fetch_one(id_, url):
    hit = existing(id_)
    if hit:
        _stats['reuse'] += 1
        return id_, hit
    last = None
    for _ in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=TIMEOUT)
            r.raise_for_status()
            if len(r.content) < 100:
                last = 'too small';
                continue
            ext, blob = process(r.content, id_)
            p = IMG_DIR / f'{id_}.{ext}'
            p.write_bytes(blob)
            _stats['ok'] += 1
            return id_, f'img/{id_}.{ext}'
        except Exception as e:  # noqa: BLE001
            last = str(e)[:60]
    _stats['fail'].append((id_, last))
    return id_, None


def main():
    if not SNAP.exists():
        print(f'ERR: no snapshot at {SNAP} (先跑 export-web-snapshot.py)')
        return 1
    snap = json.loads(SNAP.read_text(encoding='utf-8'))
    images = snap.get('images', {})
    jobs = {}
    for wid, lst in images.items():
        for x in lst:
            u = x.get('data', '')
            m = re.search(r'/d/([A-Za-z0-9_-]{10,})', u)
            if m and m.group(1) not in jobs:
                jobs[m.group(1)] = u
    print(f'download: {len(jobs)} unique images -> {IMG_DIR}/')
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(fetch_one, i, u) for i, u in jobs.items()]
        done = 0
        for f in futs:
            f.result()
            done += 1
            if done % 50 == 0 or done == len(jobs):
                print(f'  ... {done}/{len(jobs)} (ok={_stats["ok"]} reuse={_stats["reuse"]} fail={len(_stats["fail"])})')
    # 改寫快照：遠端 URL -> 本地相對路徑（下載失敗的保留原 URL，照樣能看）
    by_id = {}
    for id_, u in jobs.items():
        loc = existing(id_)
        if loc:
            by_id[id_] = loc
    n_local = n_remote = 0
    for wid, lst in images.items():
        for x in lst:
            m = re.search(r'/d/([A-Za-z0-9_-]{10,})', x.get('data', ''))
            if m and m.group(1) in by_id:
                x['data'] = by_id[m.group(1)]
                x['filename'] = x.get('filename') or f"{m.group(1)}"
                n_local += 1
            else:
                n_remote += 1
    SNAP.write_text(json.dumps(snap, ensure_ascii=False), encoding='utf-8')
    total_kb = sum(p.stat().st_size for p in IMG_DIR.iterdir()) // 1024
    print(f'OK: local={n_local} remote-left={n_remote} img-dir={total_kb} KB snapshot={SNAP.stat().st_size // 1024} KB')
    if _stats['fail']:
        print(f'WARN {len(_stats["fail"])} failed (kept remote URL):')
        for id_, e in _stats['fail'][:10]:
            print(f'  {id_}: {e}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
