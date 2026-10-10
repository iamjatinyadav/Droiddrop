# Contributing

Thanks for helping out! The project aims to stay **small and dependency-free**: the Python standard library plus `adb`, and plain HTML/CSS/JS with no build step.

## Layout

```
droiddrop/
  __main__.py   CLI entry point (argparse, starts the server)
  server.py     HTTP routes, streaming downloads, zips, uploads
  adb.py        adb wrapper and all phone-side commands
  thumbs.py     thumbnail generation and disk cache
  static/       the web UI (index.html, app.css, app.js)
tests/          unittest suite (adb is mocked, no phone needed)
```

## Develop

```bash
python3 -m droiddrop --no-browser -v    # run from the repo, then open http://localhost:8765
python3 -m unittest discover -s tests   # tests
pip install ruff && ruff check .        # lint
```

UI changes need no rebuild. Just refresh the browser.

## Guidelines

- **Quote every phone path** with `adb.q()`, because commands run through the phone's shell.
- **Validate names from the browser** with `adb.safe_name()` / `adb.safe_relpath()`.
- Keep the server bound to `127.0.0.1`, and don't loosen the Origin/Host checks.
- Add a test for parsing or validation changes. If you changed phone-side commands, please say in the PR which phone and Android version you tested on.
