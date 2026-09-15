"""Server pure-helper unit tests (stdlib only, no network).
跑法：python3 tools/test-server-helpers.py（即 ~/teno-webdav-app/test-server-helpers.py 的鏡像斷言集）
測：file_sha256/quota/manifest_parent/tombstone/gc/tenoc/patch/page/is_media_put/is_log_put
"""
import hashlib
import importlib.util
import os
import struct
import sys
import tempfile

APP = os.path.expanduser("~/teno-webdav-app/server.py")
spec = importlib.util.spec_from_file_location("srv", APP)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

fails = []
def ok(name, cond, extra=""):
    print(("  ✅ " if cond else "  ❌ ") + name, extra)
    if not cond:
        fails.append(name)

# file_sha256：不存在回空；內容對得上 sha256sum
ok("sha missing→''", m.file_sha256("/nonexistent-xyz") == "")
with tempfile.NamedTemporaryFile(delete=False) as f:
    f.write(b"abc")
    fp = f.name
ok("sha abc", m.file_sha256(fp) == hashlib.sha256(b"abc").hexdigest())
os.unlink(fp)

# quota
ok("quota ok small", m.quota_ok("/tmp", 100) is True)
ok("quota blocks huge", m.quota_ok("/tmp", m.QUOTA_BYTES + 1) is False)

# manifest parent
ok("parent equal", m.manifest_parent_ok(5, 5) is True)
ok("parent stale", m.manifest_parent_ok(4, 5) is False)
ok("parent garbage", m.manifest_parent_ok("x", 5) is False)

# tombstone + gc
with tempfile.TemporaryDirectory() as d:
    m.tombstone_add(d, "a" * 40)
    ok("tombstone hit", m.tombstone_hit(d, "a" * 40) is True)
    ok("tombstone miss", m.tombstone_hit(d, "b" * 40) is False)
ok("gc orphan candidate", m.gc_is_orphan("a", set(), False) is True)
ok("gc live not orphan", m.gc_is_orphan("a", {"a"}, False) is False)
ok("gc tombstone→purgeable", m.gc_is_orphan("a", {"a"}, True) is True)
ok("gc second pass due", m.gc_second_pass_due(0, 24 * 3600 + 1) is True)
ok("gc second pass early", m.gc_second_pass_due(0, 100) is False)

# tenoc roundtrip
teno = b"SQLite format 3\x00" + b"D" * 1000
packed = m.tenoc_pack(teno, b"")
t2, l2 = m.tenoc_unpack(packed)
ok("tenoc v2 roundtrip", t2 == teno and l2 == b"")
v1 = b"TENOC\x01" + struct.pack("<I", 4) + b"DBAA" + struct.pack("<I", 0)
ok("tenoc v1 compat", m.tenoc_unpack(v1) == (b"DBAA", b""))
try:
    m.tenoc_unpack(b"TENOC\x02" + struct.pack("<I", 100) + b"short")
    ok("tenoc truncated rejects", False)
except ValueError:
    ok("tenoc truncated rejects", True)

# page patch
base = b"SQLite format 3\x00" + bytes(4096 - 16) + b"B" * 4096 + b"C" * 4096
assert m.sqlite_page_size_raw(base) == 4096
cur = bytearray(base)
cur[5000] = 65
cur = bytes(cur)
pages = m.page_diff_raw(base, cur, 4096)
ok("page diff 1 page", len(pages) == 1 and pages[0][0] == 1)
ok("patch roundtrip", m.apply_patch_raw(base, m.pack_patch_raw(pages, 4096), 4096) == cur)
try:
    m.apply_patch_raw(base, b"short", 4096)
    ok("patch misaligned rejects", False)
except ValueError:
    ok("patch misaligned rejects", True)

# media/log name gates (need fake fp under right dir)
with tempfile.TemporaryDirectory() as d:
    md = os.path.join(d, "media")
    os.makedirs(md)
    fp = os.path.join(md, "a" * 40 + ".png")
    open(fp, "wb").write(b"x")
    ok("media gate ok", m.is_media_put("/media/" + "a" * 40 + ".png", fp) is True)
    ok("media gate bad ext", m.is_media_put("/media/" + "a" * 40 + ".exe", fp) is False)
    ok("media gate short sha", m.is_media_put("/media/abc.png", fp) is False)
    ld = os.path.join(d, "logs")
    os.makedirs(ld)
    lf = os.path.join(ld, "123_abc.txt.gz")
    open(lf, "wb").write(b"x")
    ok("log gate ok", m.is_log_put("/logs/123_abc.txt.gz", lf) is True)
    ok("log gate bad name", m.is_log_put("/logs/evil.sh", lf) is False)

print("FAIL:" if fails else "SERVER-HELPERS: PASS", fails if fails else f"({19} checks)")
sys.exit(1 if fails else 0)
