# 📱 DroidDrop

[![CI](https://github.com/iamjatinyadav/Droiddrop/actions/workflows/ci.yml/badge.svg)](https://github.com/iamjatinyadav/Droiddrop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9%E2%80%933.15-blue.svg)](pyproject.toml)

**Move files between your computer and an Android phone over a USB cable or Wi-Fi, from a clean web UI.**

No phone app to install and no Python packages to install. You run one command and it opens in your browser.

<!-- Add a screenshot: docs/screenshot.png -->

## Features

- 🔌 **USB or 📶 Wi-Fi.** Wi-Fi works through Android 11+ pairing codes, or on any Android by switching an existing USB connection to Wi-Fi.
- 🗂 **File browser** with shortcuts (Download, Camera, Pictures, WhatsApp…), a filter box, sorting and storage usage.
- ⬆ **Upload** files *or whole folders* with drag-and-drop and live progress.
- ⬇ **Download** files, or folders and multi-selections as a single zip. The zip is built while it downloads, so it starts instantly and uses no extra space on the phone.
- 🖼 **Grid view** with photo and video thumbnails, and **list view**.
- 👁 **Preview** images (including HEIC), video and audio (with seeking), PDFs and text files. Use ← → to browse.
- ✏️ Rename, delete and create folders.
- 🌗 Light and dark mode, and it works at phone width too.

## Install

You need **Python 3.9+** and **adb** (Android platform-tools):

| OS      | Install adb                                          |
| ------- | ---------------------------------------------------- |
| macOS   | `brew install --cask android-platform-tools`         |
| Windows | `winget install Google.PlatformTools`                |
| Linux   | `sudo apt install adb` (or your distro's equivalent) |

Then install the app, either with pipx:

```bash
pipx install git+https://github.com/iamjatinyadav/Droiddrop
droiddrop
```

…or run it straight from a clone:

```bash
git clone https://github.com/iamjatinyadav/Droiddrop
cd Droiddrop
python3 -m droiddrop
```

Your browser opens at <http://localhost:8765>.

```
droiddrop [-p PORT] [--no-browser] [-v] [--version]
```

If the port is busy, the next free one is used.

## Platform support

| Computer | Status | Notes |
| -------- | ------ | ----- |
| macOS    | ✅ Tested | Thumbnails work out of the box (built-in `sips`). |
| Windows 10/11 | ✅ Supported | USB may need the [Google USB driver](https://developer.android.com/studio/run/win-usb) or your phone maker's driver. Install `ffmpeg` or `Pillow` for thumbnails. |
| Linux    | ✅ Supported | USB needs [udev rules](https://developer.android.com/studio/run/device#setting-up). Wi-Fi *pairing* needs adb from platform-tools 30+; older distro packages lack it, so use Google's [platform-tools](https://developer.android.com/tools/releases/platform-tools) or the "Using USB first" Wi-Fi option. |

**Phone:** Android 7.0 or newer is recommended, and the app is developed and tested on Android 16. Wi-Fi pairing codes need Android 11+, while "Switch to Wi-Fi" over USB works on older versions too. Phone-side commands are the same on every computer, since they run on the phone's built-in tools.

## Connect your phone

**One-time setup:** on the phone, open **Settings → About phone** and tap **Build number** 7 times to unlock **Developer options**.

**USB**
1. Turn on **Developer options → USB debugging**.
2. Plug in the cable and tap **Allow** on the phone.

**Wi-Fi** (phone and computer on the same network), click **Connect via Wi-Fi** in the app:
- **Android 11+:** turn on **Developer options → Wireless debugging**, tap **Pair device with pairing code**, and enter the IP, port and code. Then connect using the port shown on the main Wireless debugging screen.
- **Any Android:** connect with USB once, click **Switch to Wi-Fi**, then unplug.

## How it works

```
Browser (web UI)  ⇄  local Python server (127.0.0.1)  ⇄  adb  ⇄  phone (USB / Wi-Fi)
```

The server is a small standard-library HTTP app that turns UI actions into `adb` commands:

| Action              | Command used                                       |
| ------------------- | -------------------------------------------------- |
| List a folder       | one `find … -exec stat` per folder                 |
| Download or preview | `adb exec-out cat` (`tail`/`head` for byte ranges) |
| Upload              | `adb push`                                         |
| Zips                | `tar` on the phone, re-packed as zip on the fly    |

Thumbnails use macOS's built-in `sips`, or `ffmpeg`, or Pillow (`pipx install "droiddrop[thumbnails]"`). They're cached in your user cache folder, which is capped at about 300 MB. Video thumbnails need `ffmpeg`, which reads only the bytes it needs, not the whole video.

## Security

- The server listens on **127.0.0.1 only**, so other devices on your network can't reach it.
- Requests from other websites are rejected. Origin and Host checks stop cross-site requests and DNS rebinding.
- Phone files shown in previews are sandboxed, so an HTML or SVG file on the phone can't run scripts in the app.
- USB debugging gives a computer full access to the phone. Only allow computers you trust, and turn it off when you're done if you like.

## Troubleshooting

| Problem | Fix |
| ------- | --- |
| Phone not listed | Try another cable (some only charge), unlock the phone, and check USB debugging is on. |
| Shows **unauthorized** | Unlock the phone and tap **Allow** on the popup. Still stuck? Revoke USB debugging authorizations in Developer options and reconnect. |
| Not found on Windows | Install the [Google USB driver](https://developer.android.com/studio/run/win-usb) or your phone maker's driver. |
| Not found on Linux | Set up [udev rules](https://developer.android.com/studio/run/device#setting-up) for your phone. |
| Device keeps disconnecting | Close other adb tools (Android Studio, scrcpy) that may restart the adb server. |
| Wi-Fi connect fails | Phone and computer must be on the same network, and some guest or office networks block device-to-device traffic. |
| No thumbnails | Install `ffmpeg` or `Pillow` (macOS works out of the box). |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
