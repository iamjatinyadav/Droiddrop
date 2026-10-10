"""Local HTTP server: serves the web UI and a small JSON/streaming API on top of adb."""

import json
import mimetypes
import os
import posixpath
import re
import shutil
import sys
import tarfile
import tempfile
import time
import traceback
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

from . import __version__, adb, thumbs
from .adb import AdbError

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
}
LOCAL_HOSTS = ("127.0.0.1", "localhost", "[::1]", "::1")
CHUNK = 256 * 1024
# Already-compressed formats are stored as-is in zips; compressing them again just burns CPU.
NO_COMPRESS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".mp4", ".mkv", ".mov", ".webm",
               ".3gp", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".zip", ".rar", ".7z",
               ".gz", ".apk", ".pdf", ".docx", ".xlsx", ".pptx"}
# Phone files are served from our own origin, so never let them render as active content.
UNSAFE_INLINE = {"text/html", "application/xhtml+xml", "text/javascript", "application/javascript",
                 "text/xml", "application/xml"}

for _type, _ext in [("video/x-matroska", ".mkv"), ("video/webm", ".webm"), ("image/heic", ".heic"),
                    ("image/webp", ".webp"), ("audio/opus", ".opus"), ("audio/mp4", ".m4a"),
                    ("audio/flac", ".flac"), ("text/markdown", ".md"), ("text/vtt", ".vtt")]:
    mimetypes.add_type(_type, _ext)


class Forbidden(Exception):
    pass


def parse_range(header, size):
    """Parse an HTTP Range header. Returns (start, end) inclusive, None for "whole file",
    or raises ValueError when the range can't be satisfied."""
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", (header or "").strip())
    if not m or not size or not (m.group(1) or m.group(2)):
        return None
    if m.group(1):
        start = int(m.group(1))
        end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
    else:  # "bytes=-N" means the last N bytes
        start, end = max(size - int(m.group(2)), 0), size - 1
    if start > end:
        raise ValueError("unsatisfiable range")
    return start, end


def content_disposition(kind, name):
    return f"{kind}; filename*=UTF-8''{quote(name)}"


class Handler(BaseHTTPRequestHandler):
    server_version = f"DroidDrop/{__version__}"
    verbose = False

    def log_message(self, fmt, *args):
        if self.verbose:
            super().log_message(fmt, *args)

    # ---------- helpers ----------
    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length)) if length else {}

    def params(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def check_origin(self):
        # Block other websites from driving this API from the user's browser
        # (Host check stops DNS rebinding, Origin check stops cross-site requests).
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in LOCAL_HOSTS:
            raise Forbidden("Forbidden host")
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).hostname not in LOCAL_HOSTS:
            raise Forbidden("Forbidden origin")

    def dispatch(self, routes):
        route = urlparse(self.path).path
        try:
            self.check_origin()
            handler = routes.get(route)
            if not handler:
                return self.send_json({"error": "Not found"}, 404)
            handler()
        except Forbidden as e:
            self.send_json({"error": str(e)}, 403)
        except AdbError as e:
            self.send_json({"error": str(e)}, 400)
        except (KeyError, ValueError) as e:
            self.send_json({"error": f"Bad request: {e}"}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser went away
        except Exception as e:  # keep the server alive, and tell the UI what happened
            traceback.print_exc()
            try:
                self.send_json({"error": f"Internal error: {e}"}, 500)
            except OSError:
                pass

    # ---------- routing ----------
    def do_GET(self):
        p = self.params()
        routes = {path: (lambda path=path: self.serve_static(path)) for path in STATIC_FILES}
        routes.update({
            "/api/status": lambda: self.send_json({
                "version": __version__,
                "adb": bool(adb.find_adb()),
                "devices": adb.list_devices() if adb.find_adb() else [],
            }),
            "/api/info": lambda: self.send_json(adb.device_info(p["serial"])),
            "/api/ls": lambda: self.send_json({"path": p["path"], "entries": adb.list_dir(p["serial"], p["path"])}),
            "/api/download": lambda: self.send_file(p["serial"], p["path"]),
            "/api/raw": lambda: self.send_file(p["serial"], p["path"], inline=True),
            "/api/thumb": lambda: self.send_thumb(p),
            "/api/download-zip": lambda: self.send_zip(
                p["serial"], p["path"], [adb.safe_name(n) for n in json.loads(p["names"])]),
        })
        self.dispatch(routes)

    def do_POST(self):
        self.dispatch({
            "/api/upload": self.upload,
            "/api/pair": self.pair,
            "/api/connect": self.connect,
            "/api/disconnect": self.disconnect,
            "/api/tcpip": self.tcpip,
            "/api/mkdir": self.mkdir,
            "/api/delete": self.delete,
            "/api/rename": self.rename,
        })

    def pair(self):
        b = self.read_json()
        self.send_json({"message": adb.pair(b["host"], b["port"], b["code"])})

    def connect(self):
        b = self.read_json()
        serial, message = adb.connect(b["host"], b["port"])
        self.send_json({"serial": serial, "message": message})

    def disconnect(self):
        self.send_json({"message": adb.disconnect(self.read_json()["serial"])})

    def tcpip(self):
        self.send_json(adb.switch_to_wifi(self.read_json()["serial"]))

    def mkdir(self):
        b = self.read_json()
        adb.make_dir(b["serial"], posixpath.join(b["path"], adb.safe_relpath(b["name"])))
        self.send_json({"ok": True})

    def delete(self):
        b = self.read_json()
        adb.delete(b["serial"], b["path"])
        self.send_json({"ok": True})

    def rename(self):
        b = self.read_json()
        adb.rename(b["serial"], b["path"], b["name"])
        self.send_json({"ok": True})

    # ---------- responses ----------
    def serve_static(self, route):
        name, ctype = STATIC_FILES[route]
        with open(os.path.join(STATIC_DIR, name), "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def stream(self, proc):
        try:
            while chunk := proc.stdout.read(CHUNK):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser cancelled
        finally:
            proc.kill()
            proc.wait()

    def send_file(self, serial, path, inline=False):
        """Stream a file. inline=True is for previews: real MIME type plus HTTP Range (video seeking)."""
        ftype, size = adb.stat_file(serial, path)
        if ftype.startswith("directory"):
            raise AdbError("Folders download as a zip")
        name = posixpath.basename(path)
        try:
            rng = parse_range(self.headers.get("Range"), size) if inline else None
        except ValueError:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        proc = adb.read_stream(serial, path, *((rng[0], rng[1] - rng[0] + 1) if rng else ()))
        self.send_response(206 if rng else 200)
        if inline:
            ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
            if ctype in UNSAFE_INLINE:
                ctype = "text/plain"
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))
            self.send_header("Content-Disposition", content_disposition("inline", name))
            if ctype != "application/pdf":  # Chrome refuses to render PDFs in a sandboxed document
                self.send_header("Content-Security-Policy", "sandbox")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Accept-Ranges", "bytes")
        else:
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", content_disposition("attachment", name))
        if rng:
            self.send_header("Content-Range", f"bytes {rng[0]}-{rng[1]}/{size}")
            self.send_header("Content-Length", str(rng[1] - rng[0] + 1))
        elif size is not None:
            self.send_header("Content-Length", str(size))
        self.end_headers()
        self.stream(proc)

    def send_thumb(self, p):
        px = max(64, min(int(p.get("px", 360)), 2560))
        thumb = thumbs.get_thumb(p["serial"], p["path"], p.get("v", ""), px, self.server.server_port)
        if not thumb:  # no thumbnail tool on this machine: send the original
            return self.send_file(p["serial"], p["path"], inline=True)
        with open(thumb, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=604800")  # URL carries mtime+size
        self.end_headers()
        self.wfile.write(data)

    def send_zip(self, serial, folder, names):
        """Stream files/folders as a zip: tar on the phone, re-packed as zip on the fly."""
        if not names:
            raise AdbError("Nothing selected")
        if not adb.check_exist(serial, folder, names):
            raise AdbError("Some selected items no longer exist - refresh and try again")
        zipname = names[0] if len(names) == 1 else posixpath.basename(folder.rstrip("/")) or "files"
        proc = adb.tar_stream(serial, folder, names)
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", content_disposition("attachment", zipname + ".zip"))
        self.end_headers()  # no Content-Length: size isn't known up front; HTTP/1.0 close ends it
        try:
            with tarfile.open(fileobj=proc.stdout, mode="r|") as tar, \
                    zipfile.ZipFile(self.wfile, "w", allowZip64=True) as zf:
                for member in tar:
                    name = member.name[2:] if member.name.startswith("./") else member.name
                    if not name:
                        continue
                    date = time.localtime(max(member.mtime, 315532800))[:6]  # zip can't go before 1980
                    if member.isdir():
                        zf.writestr(zipfile.ZipInfo(name.rstrip("/") + "/", date), b"")
                        continue
                    if not member.isfile():
                        continue  # skip symlinks, devices, etc.
                    info = zipfile.ZipInfo(name, date)
                    info.external_attr = 0o644 << 16
                    info.file_size = member.size
                    stored = posixpath.splitext(name)[1].lower() in NO_COMPRESS
                    info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
                    with zf.open(info, "w", force_zip64=member.size > 2**31) as dst:
                        shutil.copyfileobj(tar.extractfile(member), dst, CHUNK)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser cancelled
        finally:
            proc.kill()
            proc.wait()

    def upload(self):
        p = self.params()
        serial, folder, rel = p["serial"], p["path"], adb.safe_relpath(p.get("name"))
        remaining = int(self.headers.get("Content-Length") or 0)
        fd, tmp = tempfile.mkstemp(prefix="droiddrop-")
        try:
            with os.fdopen(fd, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        raise AdbError("Upload interrupted")
                    f.write(chunk)
                    remaining -= len(chunk)
            # mkstemp makes the file 0600 and adb push keeps the mode; make it readable by phone apps.
            os.chmod(tmp, 0o644)
            dest = posixpath.join(folder, rel)  # adb push creates missing parent folders
            adb.push(serial, tmp, dest)
            self.send_json({"ok": True, "path": dest})
        finally:
            os.unlink(tmp)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind a port that's already in use, so a
    # second copy would silently share 8765 instead of moving on to the next free port.
    allow_reuse_address = os.name != "nt"


def make_server(port, max_tries=10):
    """Bind to 127.0.0.1 only (anyone who can reach this server can read the phone).
    If the port is taken, try the next few."""
    for candidate in range(port, port + max_tries):
        try:
            return Server(("127.0.0.1", candidate), Handler)
        except OSError:
            continue
    sys.exit(f"Ports {port}-{port + max_tries - 1} are all in use. Pick another one with --port.")
