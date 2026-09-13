#!/usr/bin/env python3
"""Teno 本地雲 WebDAV server（零依賴，stdlib only）.

 canonical：~/teno-webdav-app/server.py（獨立 App，Teno 附屬）
 本檔是鏡像，harness（tools/verify-webdav1.mjs）用，不 hand-edit；
 改功能請改 canonical 那支再 cp 回來。

跑法：
  python3 scripts/webdav-server.py --dir ~/teno-webdav --port 8080 --user teno --pass <密碼>
  或 ./scripts/webdav-serve.sh [port] [user] [pass]

支援：GET / HEAD / PUT / DELETE / MKCOL / PROPFIND(depth 0/1) / OPTIONS
認證：HTTP Basic（單帳密；LAN 裸奔可 --no-auth，但不建議對外）
儲存：--dir 目錄即雲空間，teno.db 由 App PUT 上來
"""
import argparse
import base64
import email.utils
import hashlib
import hmac
import os
import posixpath
import threading
import types
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape as xml_escape

ARGS = types.SimpleNamespace(dir=os.path.expanduser("~/teno-webdav"), port=8080,
                               user="teno", password="", no_auth=False)


def check_auth(handler: BaseHTTPRequestHandler) -> bool:
    if ARGS.no_auth:
        return True
    got = handler.headers.get("Authorization", "")
    if not got.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(got[6:]).decode("utf-8", "replace")
    except Exception:
        return False
    want = f"{ARGS.user}:{ARGS.password}"
    return hmac.compare_digest(decoded, want)


def send_401(handler: BaseHTTPRequestHandler):
    body = b"auth required"
    handler.send_response(401)
    handler.send_header("WWW-Authenticate", 'Basic realm="teno-webdav"')
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def fs_path(url_path: str) -> str:
    rel = urllib.parse.unquote(url_path)
    rel = posixpath.normpath(rel).lstrip("/")
    if rel in ("", "."):
        return ARGS.dir
    # 防穿越：normpath 後仍限 dir 內
    full = os.path.join(ARGS.dir, rel)
    if os.path.commonpath([os.path.abspath(full), os.path.abspath(ARGS.dir)]) != os.path.abspath(ARGS.dir):
        return ARGS.dir
    return full


def http_date(ts: float) -> str:
    return email.utils.formatdate(ts, usegmt=True)


def fmt_size(n: int) -> str:
    try:
        n = int(n)
    except (ValueError, TypeError):
        return '—'
    if n < 1024:
        return f'{n} B'
    if n < 1024 * 1024:
        return f'{n / 1024:.1f} KB'
    if n < 1024 * 1024 * 1024:
        return f'{n / 1024 / 1024:.1f} MB'
    return f'{n / 1024 / 1024 / 1024:.2f} GB'


def fmt_time(ts: float) -> str:
    try:
        return datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S')
    except (ValueError, OSError, OverflowError):
        return '—'


def dashboard_html(files: list, total_size: int) -> bytes:
    rows = []
    for f in files:
        name = f['name']
        href = urllib.parse.quote(name) + ('/' if f['isdir'] else '')
        dl = (f'<a href="{href}"'
              + ('' if f['isdir'] else ' download') + '>下載</a>'
              ) if not f['isdir'] else f'<a href="{href}">開啟</a>'
        rows.append(
            '<tr>'
            f'<td class="name">{xml_escape(name)}{" /" if f["isdir"] else ""}</td>'
            f'<td class="num">{fmt_size(f["size"])}</td>'
            f'<td class="num">{fmt_time(f["mtime"])}</td>'
            f'<td class="ops">{dl} '
            f'<button data-del="{xml_escape(name)}">刪除</button></td>'
            '</tr>')
    body_rows = '\n'.join(rows) if rows else \
        '<tr><td colspan="4" class="empty">空間是空的 — 從下面上傳第一個檔吧</td></tr>'
    html = f"""<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>teno-webdav 本地雲</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:system-ui,'Noto Sans TC',sans-serif;background:#0b0911;color:#b9b2cc;line-height:1.6;padding:24px}}
.wrap{{max-width:860px;margin:0 auto}}
h1{{font-size:20px;color:#f3eefb;margin-bottom:4px}}
.sub{{font-size:13px;color:#837b9c;margin-bottom:16px}}
.sub b{{color:#b69dff}}
.card{{background:#14111c;border:1px solid rgba(185,178,204,.13);border-radius:16px;padding:20px;margin-bottom:16px}}
table{{width:100%;border-collapse:collapse;font-size:14px}}
th{{text-align:left;font-size:12px;color:#837b9c;font-weight:600;padding:8px 10px;border-bottom:1px solid rgba(185,178,204,.13)}}
td{{padding:10px;border-bottom:1px solid rgba(185,178,204,.07)}}
tr:last-child td{{border-bottom:none}}
td.name{{color:#f3eefb;font-weight:600;word-break:break-all}}
td.num{{white-space:nowrap;color:#b9b2cc;font-variant-numeric:tabular-nums}}
td.ops{{white-space:nowrap}}
td.empty{{text-align:center;color:#837b9c;padding:24px 10px}}
a{{color:#b69dff;text-decoration:none}}
a:hover{{text-decoration:underline}}
button{{border:1px solid rgba(185,178,204,.2);background:#1c1825;color:#f3eefb;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer}}
button:hover{{border-color:#b69dff}}
button.danger{{color:#f88a8a}}
.uprow{{display:flex;gap:10px;align-items:center;flex-wrap:wrap}}
#status{{font-size:13px;color:#5ed98f;min-height:20px;margin-top:10px}}
input[type=file]{{font-size:13px;color:#b9b2cc;max-width:100%}}
.foot{{font-size:12px;color:#57506e;text-align:center;margin-top:8px}}
</style>
</head>
<body>
<div class="wrap">
<h1>📦 teno-webdav 本地雲</h1>
<div class="sub"><b>{len(files)}</b> 個檔案 · 共 <b>{fmt_size(total_size)}</b></div>
<div class="card">
<table>
<thead><tr><th>檔名</th><th>大小</th><th>上傳 / 修改時間</th><th>操作</th></tr></thead>
<tbody>{body_rows}</tbody>
</table>
</div>
<div class="card">
<div class="uprow">
<input type="file" id="up" multiple>
<button id="upBtn">上傳</button>
</div>
<div id="status"></div>
</div>
<div class="foot">Teno 本地雲 · 同 LAN / Tailscale 自建空間 · stdlib only</div>
</div>
<script>
const status = document.getElementById('status');
const say = (t, ok=true) => {{ status.textContent = t; status.style.color = ok ? '#5ed98f' : '#f88a8a'; }};
document.getElementById('upBtn').addEventListener('click', async () => {{
  const files = document.getElementById('up').files;
  if (!files.length) {{ say('請先選擇檔案', false); return; }}
  for (const f of files) {{
    say('上傳中：' + f.name + ' …');
    try {{
      const r = await fetch('/' + encodeURIComponent(f.name), {{ method: 'PUT', body: f }});
      if (!r.ok && r.status !== 201 && r.status !== 204) throw new Error('HTTP ' + r.status);
    }} catch (e) {{
      say('上傳失敗：' + f.name + '（' + e.message + '）', false);
      return;
    }}
  }}
  say('上傳完成，重新整理…');
  setTimeout(() => location.reload(), 500);
}});
document.querySelectorAll('[data-del]').forEach(btn => {{
  btn.addEventListener('click', async () => {{
    const name = btn.dataset.del;
    if (!confirm('確定刪除「' + name + '」？')) return;
    try {{
      const r = await fetch('/' + encodeURIComponent(name), {{ method: 'DELETE' }});
      if (!r.ok && r.status !== 204) throw new Error('HTTP ' + r.status);
      location.reload();
    }} catch (e) {{
      say('刪除失敗：' + e.message, false);
    }}
  }});
}});
</script>
</body>
</html>"""
    return html.encode('utf-8')


def propfind_xml(url_path: str, fspath: str, depth: str) -> bytes:
    base = url_path if url_path.endswith("/") else url_path + "/"
    entries = [(url_path if url_path != "/" else "/", fspath)]
    if depth != "0" and os.path.isdir(fspath):
        try:
            for name in sorted(os.listdir(fspath)):
                if name.startswith("."):
                    continue
                entries.append((base.rstrip("/") + "/" + urllib.parse.quote(name)
                                + ("/" if os.path.isdir(os.path.join(fspath, name)) else ""),
                                os.path.join(fspath, name)))
        except OSError:
            pass
    out = ['<?xml version="1.0" encoding="utf-8"?>',
           '<D:multistatus xmlns:D="DAV:">']
    for href, fp in entries:
        isdir = os.path.isdir(fp)
        try:
            st = os.stat(fp)
            size = st.st_size
            mtime = http_date(st.st_mtime)
        except OSError:
            size, mtime = 0, http_date(datetime.now(timezone.utc).timestamp())
        rtype = "<D:resourcetype><D:collection/></D:resourcetype>" if isdir else "<D:resourcetype/>"
        out.append(
            "<D:response>"
            f"<D:href>{xml_escape(href)}</D:href>"
            "<D:propstat><D:prop>"
            f"<D:getcontentlength>{size}</D:getcontentlength>"
            f"<D:getlastmodified>{mtime}</D:getlastmodified>"
            f"{rtype}"
            "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>"
            "</D:response>")
    out.append("</D:multistatus>")
    return "\n".join(out).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "TenoWebDAV/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)

    def _guard(self) -> bool:
        if not check_auth(self):
            send_401(self)
            return False
        return True

    def do_OPTIONS(self):
        if not self._guard():
            return
        self.send_response(200)
        self.send_header("DAV", "1")
        self.send_header("Allow", "OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,PROPFIND")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PROPFIND(self):
        if not self._guard():
            return
        # 讀掉 body（App 不送 body，但相容各 client）
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 0:
                self.rfile.read(min(length, 65536))
        except (ValueError, OSError):
            pass
        depth = self.headers.get("Depth", "1")
        upath = urllib.parse.urlparse(self.path).path or "/"
        fp = fs_path(upath)
        if not os.path.exists(fp):
            self.send_error(404, "not found")
            return
        body = propfind_xml(upath, fp, depth)
        self.send_response(207)
        self.send_header("Content-Type", "application/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_MKCOL(self):
        if not self._guard():
            return
        fp = fs_path(urllib.parse.urlparse(self.path).path or "/")
        if os.path.exists(fp):
            self.send_error(405, "exists")
            return
        try:
            os.makedirs(fp)
            self.send_response(201)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except OSError as e:
            self.send_error(409, str(e))

    def _serve_file(self, head_only: bool):
        if not self._guard():
            return
        fp = fs_path(urllib.parse.urlparse(self.path).path or "/")
        if os.path.isdir(fp):
            # 目錄：回 dashboard（檔名＋大小＋上傳時間＋上傳鈕；WebDAV 語義不動）
            try:
                names = sorted(n for n in os.listdir(fp) if not n.startswith("."))
            except OSError as e:
                self.send_error(403, str(e))
                return
            files, total = [], 0
            for n in names:
                p = os.path.join(fp, n)
                try:
                    st = os.stat(p)
                    isdir = os.path.isdir(p)
                    sz = 0 if isdir else st.st_size
                    total += sz
                    files.append({'name': n, 'size': sz,
                                  'mtime': st.st_mtime, 'isdir': isdir})
                except OSError:
                    continue
            body = dashboard_html(files, total)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return
        if not os.path.isfile(fp):
            self.send_error(404, "not found")
            return
        st = os.stat(fp)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-sqlite3"
                         if fp.endswith(".db") else "application/octet-stream")
        self.send_header("Content-Length", str(st.st_size))
        self.send_header("Last-Modified", http_date(st.st_mtime))
        self.send_header("ETag", f'"{int(st.st_mtime)}-{st.st_size}"')
        self.end_headers()
        if not head_only:
            with open(fp, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

    def do_GET(self):
        self._serve_file(head_only=False)

    def do_HEAD(self):
        self._serve_file(head_only=True)

    def do_PUT(self):
        if not self._guard():
            return
        fp = fs_path(urllib.parse.urlparse(self.path).path or "/")
        if fp == ARGS.dir or fp.endswith("/"):
            self.send_error(405, "use file path")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(411, "length required")
            return
        if length > 512 * 1024 * 1024:
            self.send_error(413, "too large")
            return
        existed = os.path.exists(fp)
        try:
            os.makedirs(os.path.dirname(fp) or ARGS.dir, exist_ok=True)
            remaining = length
            with open(fp + ".part", "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            os.replace(fp + ".part", fp)
            self.send_response(204 if existed else 201)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except OSError as e:
            try:
                os.unlink(fp + ".part")
            except OSError:
                pass
            self.send_error(500, str(e))

    def do_DELETE(self):
        if not self._guard():
            return
        fp = fs_path(urllib.parse.urlparse(self.path).path or "/")
        if not os.path.exists(fp) or fp == ARGS.dir:
            self.send_error(404, "not found")
            return
        try:
            if os.path.isdir(fp):
                os.rmdir(fp)
            else:
                os.unlink(fp)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except OSError as e:
            self.send_error(500, str(e))


def main():
    global ARGS
    ap = argparse.ArgumentParser(description="Teno 本地雲 WebDAV server")
    ap.add_argument("--dir", default=os.path.expanduser("~/teno-webdav"))
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--user", default="teno")
    ap.add_argument("--password", default="")
    ap.add_argument("--no-auth", action="store_true", help="關閉認證（僅 LAN 測試用）")
    ARGS = ap.parse_args()
    os.makedirs(ARGS.dir, exist_ok=True)
    if not ARGS.no_auth and not ARGS.password:
        ap.error("--password 不能為空（或用 --no-auth 明示裸奔）")
    srv = ThreadingHTTPServer(("0.0.0.0", ARGS.port), Handler)
    mode = "無認證（LAN 測試）" if ARGS.no_auth else f"帳號 {ARGS.user}"
    print(f"✅ teno-webdav listening on 0.0.0.0:{ARGS.port} dir={ARGS.dir} {mode}", flush=True)
    print("   LAN:  http://192.168.50.69:%d" % ARGS.port, flush=True)
    print("   Tailscale: http://100.105.166.123:%d（手機走這個也通）" % ARGS.port, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
