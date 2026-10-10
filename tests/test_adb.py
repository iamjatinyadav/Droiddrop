import unittest
from unittest import mock

from droiddrop import adb
from droiddrop.adb import AdbError


class ParseDevicesTest(unittest.TestCase):
    def test_usb_wifi_and_unauthorized(self):
        out = (
            "* daemon started successfully\n"
            "List of devices attached\n"
            "RZCX11KSV6J            device usb:1-1 product:a15 model:SM_A156E device:a15 transport_id:1\n"
            "192.168.1.5:5555       device product:panther model:Pixel_7 device:panther transport_id:2\n"
            "adb-XYZ._adb-tls-connect._tcp device model:Pixel_8 transport_id:3\n"
            "0123456789ABCDEF       unauthorized usb:1-2 transport_id:4\n"
        )
        devices = adb.parse_devices(out)
        self.assertEqual([d["serial"] for d in devices],
                         ["RZCX11KSV6J", "192.168.1.5:5555", "adb-XYZ._adb-tls-connect._tcp", "0123456789ABCDEF"])
        self.assertEqual(devices[0], {"serial": "RZCX11KSV6J", "state": "device", "model": "SM A156E",
                                      "transport": "usb"})
        self.assertEqual([d["transport"] for d in devices], ["usb", "wifi", "wifi", "usb"])
        self.assertEqual(devices[3]["state"], "unauthorized")

    def test_no_devices(self):
        self.assertEqual(adb.parse_devices("List of devices attached\n\n"), [])


class ParseListingTest(unittest.TestCase):
    def test_dirs_first_then_case_insensitive(self):
        out = (
            "regular file|1200|1700000000|./b.jpg\n"
            "directory|3452|1700000001|./DCIM\n"
            "regular empty file|0|1700000002|./A.txt\n"
            "directory|3452|1700000003|./alarms\n"
            "regular file|5|1700000004|./name|with|pipes.txt\n"
            "garbage line\n"
        )
        entries = adb.parse_listing(out)
        self.assertEqual([e["name"] for e in entries], ["alarms", "DCIM", "A.txt", "b.jpg", "name|with|pipes.txt"])
        self.assertEqual(entries[1], {"name": "DCIM", "dir": True, "size": 0, "mtime": 1700000001})
        self.assertEqual(entries[3]["size"], 1200)


class SafeNamesTest(unittest.TestCase):
    def test_safe_name(self):
        self.assertEqual(adb.safe_name("  résumé (1).pdf "), "résumé (1).pdf")
        for bad in ["", "  ", ".", "..", "a/b", "x\0y", None]:
            with self.assertRaises(AdbError, msg=repr(bad)):
                adb.safe_name(bad)

    def test_safe_relpath(self):
        self.assertEqual(adb.safe_relpath("Photos/2024/a.jpg"), "Photos/2024/a.jpg")
        for bad in ["../evil", "/etc/passwd", "a//b", "a/../b", "a/./b", ""]:
            with self.assertRaises(AdbError, msg=bad):
                adb.safe_relpath(bad)


class CommandQuotingTest(unittest.TestCase):
    """Phone commands go through the phone's sh, so every path must be quoted."""

    def test_list_dir_quotes_path(self):
        with mock.patch.object(adb, "shell", return_value="") as shell:
            adb.list_dir("SERIAL", "/sdcard/it's here; rm -rf /")
        cmd = shell.call_args[0][1]
        self.assertIn("cd '/sdcard/it'\"'\"'s here; rm -rf /'", cmd)

    def test_delete_refuses_top_level(self):
        with mock.patch.object(adb, "shell") as shell:
            for path in ["/", "/sdcard", "/sdcard/", "/storage/emulated/0", "/data", "/sdcard/.."]:
                with self.assertRaises(AdbError, msg=path):
                    adb.delete("S", path)
            shell.assert_not_called()

    def test_rename_reports_existing_target(self):
        with mock.patch.object(adb, "shell", return_value="__EXISTS__"):
            with self.assertRaisesRegex(AdbError, "already exists"):
                adb.rename("S", "/sdcard/a.txt", "b.txt")

    def test_pair_explains_old_adb(self):
        old_adb = "adb: unknown command pair\nAndroid Debug Bridge version 1.0.39\n"
        with mock.patch.object(adb, "adb", return_value=old_adb):
            with self.assertRaisesRegex(AdbError, "too old for Wi-Fi pairing"):
                adb.pair("192.168.1.5", 37000, "123456")

    def test_connect_rejects_odd_hosts(self):
        with mock.patch.object(adb, "adb") as run:
            with self.assertRaises(AdbError):
                adb.connect("1.2.3.4 --evil", 5555)
            run.assert_not_called()


class DeviceInfoTest(unittest.TestCase):
    def test_parses_props_and_storage(self):
        out = "samsung\nSM-A156E\n16\n/dev/fuse 110602240 81952896 28649344  75% /storage/emulated\n"
        with mock.patch.object(adb, "shell", return_value=out):
            info = adb.device_info("S")
        self.assertEqual(info["model"], "SM-A156E")
        self.assertEqual(info["android"], "16")
        self.assertEqual(info["total"], 110602240 * 1024)
        self.assertEqual(info["free"], 28649344 * 1024)


if __name__ == "__main__":
    unittest.main()
