#!/usr/bin/env python3
"""Static server with HTTP Range support — required for audio scrubbing."""

from __future__ import annotations

import argparse
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class RangeRequestHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        if not os.path.isfile(path):
            self.send_error(404, "File not found")
            return None

        try:
            file_obj = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        fs = os.fstat(file_obj.fileno())
        size = fs.st_size
        content_type = self.guess_type(path)
        range_header = self.headers.get("Range")

        if not range_header:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()
            return file_obj

        match = RANGE_RE.fullmatch(range_header.strip())
        if not match:
            file_obj.close()
            self.send_error(400, "Invalid Range header")
            return None

        start_s, end_s = match.groups()
        if start_s == "" and end_s:
            suffix = int(end_s)
            start = max(0, size - suffix)
            end = size - 1
        else:
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else size - 1

        if start >= size or end < start:
            file_obj.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        end = min(end, size - 1)
        length = end - start + 1
        file_obj.seek(start)

        self.send_response(206)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
        self.end_headers()

        original_read = file_obj.read
        remaining = length

        def limited_read(n=-1, _remaining=None):
            nonlocal remaining
            if remaining <= 0:
                return b""
            if n is None or n < 0:
                n = remaining
            chunk = original_read(min(n, remaining))
            remaining -= len(chunk)
            return chunk

        file_obj.read = limited_read  # type: ignore[method-assign]
        return file_obj


def main():
    parser = argparse.ArgumentParser(description="Serve Lappendag with Range support")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)
    httpd = ThreadingHTTPServer((args.bind, args.port), RangeRequestHandler)
    print(f"Lappendag server (Range OK) → http://{args.bind}:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        httpd.server_close()


if __name__ == "__main__":
    main()
