import http.client
import json
import threading
import unittest
from unittest import mock

from droiddrop import adb, server


class ParseRangeTest(unittest.TestCase):
    def test_ranges(self):
        self.assertEqual(server.parse_range("bytes=0-99", 1000), (0, 99))
        self.assertEqual(server.parse_range("bytes=500-", 1000), (500, 999))
        self.assertEqual(server.parse_range("bytes=-100", 1000), (900, 999))
        self.assertEqual(server.parse_range("bytes=900-5000", 1000), (900, 999))
        self.assertEqual(server.parse_range("bytes=-5000", 1000), (0, 999))

    def test_whole_file(self):
        for header in [None, "", "bytes=-", "items=0-5", "bytes=0-1,5-9"]:
            self.assertIsNone(server.parse_range(header, 1000), header)
        self.assertIsNone(server.parse_range("bytes=0-10", 0))

    def test_unsatisfiable(self):
        with self.assertRaises(ValueError):
            server.parse_range("bytes=1000-", 1000)


class ApiTest(unittest.TestCase):
    """Runs the real HTTP server on a free port, with adb mocked out."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = server.make_server(0)
        cls.port = cls.httpd.server_port
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, body=body, headers={"Host": f"localhost:{self.port}", **(headers or {})})
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res, data

    def test_serves_ui(self):
        for path, ctype in [("/", "text/html"), ("/app.js", "text/javascript"), ("/app.css", "text/css")]:
            res, data = self.request("GET", path)
            self.assertEqual(res.status, 200, path)
            self.assertTrue(res.getheader("Content-Type").startswith(ctype))
            self.assertGreater(len(data), 100)

    def test_status(self):
        devices = [{"serial": "S", "state": "device", "model": "X", "transport": "usb"}]
        with mock.patch.object(adb, "find_adb", return_value="/bin/adb"), \
                mock.patch.object(adb, "list_devices", return_value=devices):
            res, data = self.request("GET", "/api/status")
        self.assertEqual(res.status, 200)
        self.assertEqual(json.loads(data)["devices"], devices)

    def test_unknown_route_and_static_traversal(self):
        for path in ["/nope", "/../server.py", "/static/../server.py"]:
            res, _ = self.request("GET", path)
            self.assertEqual(res.status, 404, path)

    def test_blocks_other_websites(self):
        res, _ = self.request("POST", "/api/delete", body="{}", headers={"Origin": "https://evil.example"})
        self.assertEqual(res.status, 403)
        res, _ = self.request("GET", "/api/status", headers={"Host": "evil.example"})
        self.assertEqual(res.status, 403)

    def test_upload_rejects_path_traversal(self):
        with mock.patch.object(adb, "push") as push:
            res, data = self.request("POST", "/api/upload?serial=S&path=/sdcard&name=../evil.txt", body=b"x")
        self.assertEqual(res.status, 400)
        self.assertIn("Invalid name", json.loads(data)["error"])
        push.assert_not_called()

    def test_upload_pushes_to_nested_path(self):
        with mock.patch.object(adb, "push") as push:
            res, data = self.request("POST", "/api/upload?serial=S&path=/sdcard/Download&name=Album/a.jpg",
                                     body=b"hello")
        self.assertEqual(res.status, 200, data)
        serial, _, remote = push.call_args[0]
        self.assertEqual((serial, remote), ("S", "/sdcard/Download/Album/a.jpg"))

    def test_missing_parameter_is_400(self):
        res, data = self.request("GET", "/api/ls?serial=S")
        self.assertEqual(res.status, 400)
        self.assertIn("path", json.loads(data)["error"])


if __name__ == "__main__":
    unittest.main()
