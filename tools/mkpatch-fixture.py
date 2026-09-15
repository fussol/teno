"""PATCHDIFF1 harness fixture: build v0 container + 1-page patch (no NUL literals in shell)."""
import gzip
import struct
import hashlib
import random

PS = 4096
rnd = random.Random(42).randbytes(8 * PS)
teno = b"SQLite format 3" + bytes([0]) + bytes(PS - 17) + rnd
tg, lg = gzip.compress(teno), gzip.compress(b"")
v0 = b"TENOC" + bytes([2]) + struct.pack("<I", len(tg)) + tg + struct.pack("<I", len(lg)) + lg
open("/tmp/v0.bin", "wb").write(v0)

cur = bytearray(teno)
cur[5000] ^= 0xFF
cur = bytes(cur)
tg2, lg2 = gzip.compress(cur), gzip.compress(b"")
v1 = b"TENOC" + bytes([2]) + struct.pack("<I", len(tg2)) + tg2 + struct.pack("<I", len(lg2)) + lg2

print(hashlib.sha256(v0).hexdigest(), hashlib.sha256(v1).hexdigest())

pages = []
for i in range(9):
    a, b = teno[i * PS:(i + 1) * PS], cur[i * PS:(i + 1) * PS]
    if a != b:
        pg = bytearray(PS)
        pg[:len(b)] = b
        pages.append((i, bytes(pg)))
raw = b"".join(struct.pack("<I", no) + pg for no, pg in pages)
open("/tmp/pp.gz", "wb").write(gzip.compress(raw))
