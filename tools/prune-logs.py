#!/usr/bin/env python3
"""LOGARCHIVE1：雲端 logs/ 保留 30 天，超期刪除（跟主庫 .history 互不干擾）。
用法：python3 prune-logs.py [dir] [days]
dry-run：python3 prune-logs.py --dry-run
"""
import os
import sys
import time

DRY = "--dry-run" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]
ROOT = os.path.expanduser(args[0]) if len(args) > 0 else os.path.expanduser("~/teno-webdav")
DAYS = int(args[1]) if len(args) > 1 else 30

cut = time.time() - DAYS * 86400
removed, kept, total_b = 0, 0, 0
logdir = os.path.join(ROOT, "logs")
if not os.path.isdir(logdir):
    print("no logs dir, nothing to do")
    sys.exit(0)
for n in sorted(os.listdir(logdir)):
    if not n.endswith(".txt.gz"):
        continue
    fp = os.path.join(logdir, n)
    try:
        st = os.stat(fp)
    except OSError:
        continue
    total_b += st.st_size
    if st.st_mtime < cut:
        if DRY:
            print(f"would-remove {n} ({st.st_size}B)")
        else:
            try:
                os.unlink(fp)
                print(f"removed {n}")
            except OSError as e:
                print(f"keep(fail) {n}: {e}")
                kept += 1
                continue
        removed += 1
    else:
        kept += 1
print(f"prune-logs done: removed={removed} kept={kept} total={total_b}B dry={DRY}")
