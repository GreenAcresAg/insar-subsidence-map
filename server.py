#!/usr/bin/env python3
"""Simple static HTTP server with Range request support.

Usage: python3 server.py [port]   (default 8000)
"""
import http.server, os, sys

class RangeHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        range_header = self.headers.get('Range')
        if not range_header:
            return super().do_GET()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return

        file_size = os.path.getsize(path)
        # Parse "bytes=start-end"
        byte_range = range_header.strip().split('=')[1]
        parts = byte_range.split('-')
        start = int(parts[0])
        end = int(parts[1]) if parts[1] else file_size - 1
        length = end - start + 1

        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        with open(path, 'rb') as f:
            f.seek(start)
            self.wfile.write(f.read(length))

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving http://localhost:{port}  (Ctrl-C to stop)")
    http.server.HTTPServer(('', port), RangeHTTPRequestHandler).serve_forever()
