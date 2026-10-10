"""Thin wrapper around the `adb` command-line tool, plus the phone-side file operations."""

import os
import posixpath
import re
import shlex
import shutil
import subprocess
import time

TCPIP_PORT = 5555


class AdbError(Exception):
    """An error with a message that is safe and useful to show to the user."""


_adb_path = None


def find_adb():
    """Locate the adb binary on PATH or in the usual SDK locations (result is cached once found)."""
    global _adb_path
    if _adb_path and os.path.isfile(_adb_path):
        return _adb_path
    candidates = [
        shutil.which("adb"),
        "/opt/homebrew/bin/adb",
        "/usr/local/bin/adb",
        os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"),
        os.path.expanduser("~/Android/Sdk/platform-tools/adb"),
        os.path.expandvars(r"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"),
    ]
    _adb_path = next((c for c in candidates if c and os.path.isfile(c)), None)
    return _adb_path


def adb_cmd(*args, serial=None):
    exe = find_adb()
    if not exe:
        raise AdbError("adb is not installed")
    return [exe] + (["-s", serial] if serial else []) + list(args)


def adb(*args, serial=None, timeout=30, check=True):
    """Run adb and return its combined output. Raises AdbError on failure when `check` is set."""
    try:
        res = subprocess.run(adb_cmd(*args, serial=serial), capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AdbError("adb timed out: " + " ".join(args[:2])) from None
    out = (res.stdout + res.stderr).strip()
    if check and res.returncode != 0:
        raise AdbError(out or "adb command failed")
    return out


def shell(serial, command, timeout=30):
    """Run a command on the phone. `command` is a single string for the phone's sh."""
    return adb("shell", command, serial=serial, timeout=timeout)


def popen(serial, command):
    """Start a phone command whose raw (binary) stdout is streamed back."""
    return subprocess.Popen(adb_cmd("exec-out", command, serial=serial),
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


q = shlex.quote


# ---------- names and paths ----------

def safe_name(name):
    """A single file/folder name: no slashes, not empty, not "." or ".."."""
    name = (name or "").strip()
    if not name or "/" in name or "\0" in name or name in (".", ".."):
        raise AdbError("Invalid name")
    return name


def safe_relpath(rel):
    """A relative path like "Photos/2024/a.jpg" (from a folder upload); no "..", no absolute paths."""
    return "/".join(safe_name(part) for part in (rel or "").split("/"))


def is_wifi_serial(serial):
    return ":" in serial or "._adb-tls-connect" in serial


# ---------- devices ----------

def parse_devices(output):
    devices = []
    # The first run also prints "* daemon started" lines before the header, so skip up to the header.
    lines = output.splitlines()
    header = next((i for i, line in enumerate(lines) if line.startswith("List of devices")), -1)
    for line in lines[header + 1:]:
        parts = line.split()
        if len(parts) < 2 or line.startswith("*"):
            continue
        serial, state = parts[0], parts[1]
        props = dict(p.split(":", 1) for p in parts[2:] if ":" in p)
        devices.append({
            "serial": serial,
            "state": state,  # device | unauthorized | offline
            "model": props.get("model", "").replace("_", " "),
            "transport": "wifi" if is_wifi_serial(serial) else "usb",
        })
    return devices


def list_devices():
    return parse_devices(adb("devices", "-l"))


def device_info(serial):
    out = shell(serial, "getprop ro.product.manufacturer; getprop ro.product.model; "
                        "getprop ro.build.version.release; df -k /sdcard 2>/dev/null | tail -n 1")
    lines = out.splitlines() + [""] * 4
    info = {"manufacturer": lines[0].strip(), "model": lines[1].strip(), "android": lines[2].strip()}
    cols = lines[3].split()
    if len(cols) >= 4 and cols[1].isdigit() and cols[3].isdigit():
        info["total"] = int(cols[1]) * 1024
        info["free"] = int(cols[3]) * 1024
    return info


# ---------- files ----------

def parse_listing(output):
    entries = []
    for line in output.splitlines():
        parts = line.split("|", 3)
        if len(parts) != 4 or not parts[1].isdigit():
            continue
        ftype, size, mtime, name = parts
        is_dir = ftype.startswith("directory")
        entries.append({
            "name": posixpath.basename(name),
            "dir": is_dir,
            "size": 0 if is_dir else int(size),
            "mtime": int(mtime) if mtime.isdigit() else 0,
        })
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return entries


def list_dir(serial, path):
    # One round trip: stat every entry (following symlinks, e.g. /sdcard) in a single command.
    cmd = (f"cd {q(path)} 2>/dev/null || {{ echo __NO_DIR__; exit 0; }}; "
           "find . -mindepth 1 -maxdepth 1 -exec stat -L -c '%F|%s|%Y|%n' {} + 2>/dev/null")
    out = shell(serial, cmd, timeout=60)
    if out.strip() == "__NO_DIR__":
        raise AdbError(f"Cannot open folder: {path}")
    return parse_listing(out)


def stat_file(serial, path):
    """Return (type, size) of a path, e.g. ("regular file", 1234)."""
    out = shell(serial, f"stat -L -c '%F|%s' {q(path)} 2>/dev/null || echo __MISSING__")
    if "__MISSING__" in out or "|" not in out:
        raise AdbError(f"File not found: {path}")
    ftype, size = out.strip().split("|", 1)
    return ftype, int(size) if size.isdigit() else None


def make_dir(serial, path):
    shell(serial, f"mkdir -p {q(path)}")


def delete(serial, path):
    path = posixpath.normpath(path)
    if path.count("/") < 2 or path in ("/sdcard", "/storage/emulated/0"):
        raise AdbError("Refusing to delete a top-level folder")
    if "__OK__" not in shell(serial, f"rm -rf {q(path)} && echo __OK__"):
        raise AdbError("Delete failed")


def rename(serial, src, new_name):
    dst = posixpath.join(posixpath.dirname(src), safe_name(new_name))
    out = shell(serial, f"if [ -e {q(dst)} ]; then echo __EXISTS__; else mv {q(src)} {q(dst)} && echo __OK__; fi")
    if "__EXISTS__" in out:
        raise AdbError(f'"{new_name}" already exists')
    if "__OK__" not in out:
        raise AdbError(out or "Rename failed")


def push(serial, local_path, remote_path):
    adb("push", local_path, remote_path, serial=serial, timeout=3600)


def check_exist(serial, folder, names):
    targets = " ".join(q("./" + n) for n in names)
    out = shell(serial, f"cd {q(folder)} 2>/dev/null && ls -d {targets} >/dev/null 2>&1 && echo __OK__ || true")
    return "__OK__" in out


def tar_stream(serial, folder, names):
    """Stream a tar of `names` (inside `folder`) from the phone. "./" stops names acting as flags."""
    targets = " ".join(q("./" + n) for n in names)
    return popen(serial, f"cd {q(folder)} && tar -cf - {targets} 2>/dev/null")


def read_stream(serial, path, start=0, length=None):
    """Stream a file (or a byte range of it) from the phone."""
    if length is None:
        return popen(serial, "cat " + q(path))
    return popen(serial, f"tail -c +{start + 1} {q(path)} | head -c {length}")


# ---------- Wi-Fi ----------

def _target(host, port):
    host = (host or "").strip()
    if not re.fullmatch(r"[\w.\-:\[\]]+", host):
        raise AdbError("Invalid IP address")
    return f"{host}:{int(port)}"


def pair(host, port, code):
    out = adb("pair", _target(host, port), str(code).strip(), timeout=30, check=False)
    if "Successfully paired" in out:
        return out
    if "unknown command" in out.lower() or "usage:" in out.lower():
        # e.g. the adb from older Debian/Ubuntu repos (platform-tools < 30)
        raise AdbError("Your adb is too old for Wi-Fi pairing (needs platform-tools 30 or newer). Get the latest "
                       "from https://developer.android.com/tools/releases/platform-tools, or use the "
                       '"Using USB first" option instead.')
    raise AdbError(out or "Pairing failed")


def connect(host, port):
    target = _target(host, port)
    out = adb("connect", target, timeout=20, check=False)
    if "connected to" not in out:
        raise AdbError(out or "Connection failed")
    return target, out


def disconnect(serial):
    return adb("disconnect", serial, check=False)


def device_wifi_ip(serial):
    m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", shell(serial, "ip -f inet addr show wlan0 2>/dev/null"))
    if not m:
        raise AdbError("The phone doesn't seem to be on Wi-Fi. Connect it to the same network as this computer.")
    return m.group(1)


def switch_to_wifi(serial):
    """Classic method (works on any Android): restart adbd in TCP mode over USB, then connect."""
    ip = device_wifi_ip(serial)
    adb("tcpip", str(TCPIP_PORT), serial=serial)
    target = f"{ip}:{TCPIP_PORT}"
    last = ""
    for _ in range(8):
        time.sleep(1)
        last = adb("connect", target, check=False)
        if "connected to" in last:
            return {"serial": target, "message": last}
    raise AdbError(last or f"Could not connect to {target}")
