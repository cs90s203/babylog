#!/usr/bin/env python3
# Minimal static file server for local dev. Exists only because stdlib `python3 -m
# http.server` calls os.getcwd() unconditionally while building its argparse parser
# (default=os.getcwd() is evaluated eagerly at add_argument() time, not lazily), which
# fails with PermissionError in some sandboxed environments even when a --directory is
# supplied. This script hardcodes the directory instead, avoiding that call entirely.
import http.server
import functools
import os
import sys

directory = os.path.dirname(os.path.abspath(__file__))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8793

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
    httpd.serve_forever()
