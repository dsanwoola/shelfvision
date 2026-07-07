#!/usr/bin/env python3
"""ShelfVision dev server with ERPNext API proxy.

Serves the app directory and forwards /api/* (and /files/*) to an ERPNext
site, so the app and the API share one origin and no CORS configuration is
needed on the ERPNext side. In the app's Settings, leave the Site URL as
this server's own origin (e.g. http://localhost:4180).

Usage:
    python dev-proxy.py [port] [erpnext_url]
    ERPNEXT_URL=https://erp.example.com python dev-proxy.py 4180
"""
import http.server
import os
import sys
import urllib.request
import urllib.error

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4180
TARGET = (sys.argv[2] if len(sys.argv) > 2 else os.environ.get('ERPNEXT_URL', 'http://localhost:8080')).rstrip('/')
PROXY_PREFIXES = ('/api/', '/files/')
HOP_HEADERS = {'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
               'proxy-authenticate', 'proxy-authorization', 'upgrade', 'host',
               'accept-encoding', 'content-length'}


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _proxy(self):
        url = TARGET + self.path
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() not in HOP_HEADERS:
                req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                payload = res.read()
                self.send_response(res.status)
                for k, v in res.getheaders():
                    if k.lower() not in HOP_HEADERS:
                        self.send_header(k, v)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            for k, v in e.headers.items():
                if k.lower() not in HOP_HEADERS:
                    self.send_header(k, v)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:  # target unreachable
            msg = ('{"exception": "dev-proxy: cannot reach %s (%s)"}' % (TARGET, e)).encode()
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_GET(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy()
        self.send_error(405)

    def do_PUT(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy()
        self.send_error(405)

    def do_DELETE(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy()
        self.send_error(405)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'ShelfVision on http://localhost:{PORT}  →  proxying /api/* to {TARGET}')
    http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
