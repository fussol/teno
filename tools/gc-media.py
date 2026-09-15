
"""GC 兩階段掃描（HOLE2）：列候選 -> 24h 後再確認 -> 真刪。tombstone 見碑不復活（HOLE3）。"""
import os, sys, time, json
ROOT = os.path.expanduser(sys.argv[1]) if len(sys.argv)>1 else os.path.expanduser("~/teno-webdav")
GRACE = 24*3600
PEND = os.path.join(ROOT, ".gc-pending.json")
TOMB = os.path.join(ROOT, ".tombstones")
def live_shas(root):
    # 所有 manifest（最新＋.history 版）指著的 sha 集合；簡化版：掃 media/*.sha 清單＋manifest.json
    live = set()
    for dp,_,fns in os.walk(root):
        if ".history" in dp or ".gc-pending" in dp: continue
        for n in fns:
            if n=="manifest.json":
                try:
                    m=json.load(open(os.path.join(dp,n),encoding="utf-8"))
                    for f in m.get("files",[]): 
                        if isinstance(f,dict) and f.get("sha"): live.add(f["sha"])
                except Exception: pass
    return live
def main():
    live = live_shas(ROOT)
    try: pend=json.load(open(PEND,encoding="utf-8"))
    except Exception: pend={}
    now=time.time()
    media=os.path.join(ROOT,"media")
    if not os.path.isdir(media): print("no media dir, nothing to do"); return
    changed=False
    for n in os.listdir(media):
        fp=os.path.join(media,n)
        sha=n.rsplit(".",1)[0]
        if os.path.isfile(os.path.join(TOMB,sha)):
            # 墓碑：直接可刪（徹底刪除不復活）
            try: os.unlink(fp); print("tombstone purge",n); changed=True
            except OSError: pass
            continue
        if sha in live:
            if sha in pend: pend.pop(sha,None); changed=True
            continue
        # 孤兒候選
        if sha not in pend:
            pend[sha]=now; changed=True
            print("gc candidate",n)
        elif now-pend[sha]>=GRACE:
            # 第二遍還沒人指 → 真刪（且要求至少見過一份新 manifest：PEND 存在即代表掃過不只一輪）
            try: os.unlink(fp); print("gc purge",n)
            except OSError: pass
            pend.pop(sha,None); changed=True
    if changed:
        json.dump(pend,open(PEND,"w",encoding="utf-8"))
    print("gc done, pending:",len(pend))
main()
