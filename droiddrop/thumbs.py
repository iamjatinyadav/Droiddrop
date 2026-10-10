"""Image/video thumbnails, made with whatever tool this machine has and cached on disk."""

import hashlib
import os
import posixpath
import shutil
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlencode

from . import adb
from .adb import AdbError

VIDEO_EXT = {".mp4", ".mkv", ".mov", ".webm", ".3gp", ".avi"}
MAX_SOURCE_BYTES = 60 * 1024 * 1024  # don't pull huge images just for a thumbnail
CACHE_LIMIT_BYTES = 300 * 1024 * 1024
_slots = threading.BoundedSemaphore(3)  # leave adb bandwidth for clicks and previews


def cache_dir():
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Caches")
    elif os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "droiddrop", "thumbs")


def prune_cache(limit=CACHE_LIMIT_BYTES):
    """Delete the oldest thumbnails once the cache grows past `limit` (keeps ~2/3 of it)."""
    folder = cache_dir()
    try:
        files = [e for e in os.scandir(folder) if e.is_file()]
    except FileNotFoundError:
        return
    files.sort(key=lambda e: e.stat().st_atime)
    total = sum(e.stat().st_size for e in files)
    for entry in files:
        if total <= limit * 2 // 3:
            break
        try:
            total -= entry.stat().st_size
            os.unlink(entry.path)
        except OSError:
            pass


def _resize_image(src, dst, px):
    """Make a JPEG thumbnail with whatever tool exists. Returns False if none is available."""
    if shutil.which("sips"):  # macOS built-in, also reads HEIC
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "75", "-Z", str(px), src,
                        "--out", dst], capture_output=True, timeout=60, check=True)
        return True
    if shutil.which("ffmpeg"):
        fit = f"scale='min({px},iw)':'min({px},ih)':force_original_aspect_ratio=decrease"
        subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-vf", fit, "-y", dst],
                       capture_output=True, timeout=60, check=True)
        return True
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return False
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((px, px))
        im.convert("RGB").save(dst, "JPEG", quality=75)
    return True


def _video_frame(serial, path, dst, px, port):
    if not shutil.which("ffmpeg"):
        raise AdbError("Install ffmpeg for video thumbnails")
    # ffmpeg reads the video through our own Range-capable endpoint, so only the bytes it
    # needs cross the cable instead of the whole video.
    url = f"http://127.0.0.1:{port}/api/raw?" + urlencode({"serial": serial, "path": path})
    for seek in ("1", "0"):  # videos shorter than 1s have no frame at 1s
        subprocess.run(["ffmpeg", "-v", "error", "-ss", seek, "-i", url, "-frames:v", "1",
                        "-vf", f"scale='min({px},iw)':-2", "-y", dst], capture_output=True, timeout=60)
        if os.path.exists(dst) and os.path.getsize(dst):
            return
    raise AdbError("Could not read a frame from this video")


def get_thumb(serial, path, version, px, port):
    """Return the path of a cached JPEG thumbnail, or None if this machine has no thumbnail tool.

    `version` (mtime + size from the listing) is part of the cache key, so edited files get new thumbs.
    """
    key = hashlib.sha1(f"{serial}|{path}|{version}|{px}".encode()).hexdigest()
    out = os.path.join(cache_dir(), key + ".jpg")
    if os.path.exists(out):
        return out
    os.makedirs(cache_dir(), exist_ok=True)
    ext = posixpath.splitext(path)[1].lower()
    with _slots:
        if os.path.exists(out):  # made by another request while we waited
            return out
        tmp_out = f"{out}.{threading.get_ident()}.tmp.jpg"
        try:
            if ext in VIDEO_EXT:
                _video_frame(serial, path, tmp_out, px, port)
            else:
                _, size = adb.stat_file(serial, path)
                if size and size > MAX_SOURCE_BYTES:
                    raise AdbError("Image too large for a thumbnail")
                fd, src = tempfile.mkstemp(suffix=ext)
                try:
                    with os.fdopen(fd, "wb") as f:
                        subprocess.run(adb.adb_cmd("exec-out", "cat " + adb.q(path), serial=serial),
                                       stdout=f, stderr=subprocess.DEVNULL, timeout=120, check=True)
                    if not _resize_image(src, tmp_out, px):
                        return None
                finally:
                    os.unlink(src)
            os.replace(tmp_out, out)
        except subprocess.SubprocessError:
            raise AdbError("Could not create a thumbnail") from None
        finally:
            if os.path.exists(tmp_out):
                os.unlink(tmp_out)
    return out
