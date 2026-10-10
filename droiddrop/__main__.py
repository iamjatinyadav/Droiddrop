"""Command-line entry point: `droiddrop` or `python -m droiddrop`."""

import argparse
import sys
import threading
import webbrowser

from . import __version__, adb, thumbs
from .server import Handler, make_server


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="droiddrop",
        description="Transfer files between this computer and an Android phone over USB or Wi-Fi.")
    parser.add_argument("-p", "--port", type=int, default=8765, help="port to listen on (default: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every HTTP request")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = parser.parse_args(argv)
    # Windows consoles/pipes may not be UTF-8; never crash on the emoji in our messages.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    if not adb.find_adb():
        print("⚠️  adb was not found. Install Android platform-tools first:")
        print("   macOS:   brew install --cask android-platform-tools")
        print("   Windows: winget install Google.PlatformTools")
        print("   Linux:   sudo apt install adb   (or your distro's equivalent)")
        print("   The app will still open and show these instructions.\n")

    Handler.verbose = args.verbose
    server = make_server(args.port)
    url = f"http://localhost:{server.server_port}"
    print(f"📱 DroidDrop {__version__} running at {url}  (Ctrl+C to stop)", flush=True)
    threading.Thread(target=thumbs.prune_cache, daemon=True).start()
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBye!")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
