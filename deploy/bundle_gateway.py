"""Private, authenticated allowlisted gateway for the two bundled upstreams.

The upstream binds loopback inside this container. Only this bounded gateway is
reachable on the Compose network; URL-import, UI and management are not exposed.
"""
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time

MAX_UPLOAD = 9 * 1024 * 1024
MAX_RESPONSE = 32 * 1024 * 1024
AKTOOLS_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {'name': {'type': 'string'}, 'params': {'type': 'object', 'additionalProperties': {'type': 'string'}},
                   'max_rows': {'type': 'integer', 'minimum': 1, 'maximum': 1000}, 'offset': {'type': 'integer', 'minimum': 0}},
    'required': ['name', 'params', 'max_rows', 'offset'],
}


def financial_call_allowed(call):
    if not isinstance(call, dict) or set(call) != {'name', 'arguments'} or call['name'] != 'get_data':
        return False
    args = call['arguments']
    if not isinstance(args, dict) or set(args) != {'name', 'params', 'max_rows', 'offset'}:
        return False
    if type(args['max_rows']) is not int or not 1 <= args['max_rows'] <= 1000 or type(args['offset']) is not int or not 0 <= args['offset'] <= 100000:
        return False
    params = args['params']
    if not isinstance(params, dict) or any(not isinstance(value, str) or len(value) > 40 for value in params.values()):
        return False
    if args['name'] == 'stock_zh_a_hist':
        return set(params) == {'symbol', 'period', 'start_date', 'end_date', 'adjust'} and re.fullmatch(r'\d{6}', params['symbol']) is not None and params['period'] == 'daily' and params['adjust'] in ['', 'qfq', 'hfq'] and all(re.fullmatch(r'\d{8}', params[name]) for name in ['start_date', 'end_date'])
    if args['name'] == 'stock_financial_hk_report_em':
        return set(params) == {'stock', 'symbol', 'indicator'} and re.fullmatch(r'\d{5}', params['stock']) is not None and params['symbol'] == '利润表' and params['indicator'] == '报告期'
    return False


def route_allowed(engine, method, path):
    if engine == 'aktools':
        return method == 'POST' and path == '/mcp'
    if method == 'POST' and path == '/v1/convert/file/async':
        return True
    return method == 'GET' and re.fullmatch(r'/v1/(?:status/poll|result)/[A-Za-z0-9_-]{1,200}', path) is not None


def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def create_manifest(root):
    return [{'path': str(path.relative_to(root)), 'size': path.stat().st_size, 'sha256': digest_file(path)}
            for path in sorted(root.rglob('*')) if path.is_file()]


def verify_manifest(root, manifest):
    if not manifest:
        return False
    try:
        for entry in manifest:
            path = root / entry['path']
            if '..' in Path(entry['path']).parts or not path.is_file() or path.stat().st_size != entry['size'] or digest_file(path) != entry['sha256']:
                return False
        return True
    except (OSError, KeyError, TypeError):
        return False


def run():
    engine = os.environ['BUNDLE_ENGINE']
    key = Path(os.environ['BUNDLE_TOKEN_FILE']).read_text().strip()
    if len(key) < 32:
        raise RuntimeError('BUNDLE_TOKEN_INVALID')
    model_hash = None
    if engine == 'docling':
        model_file = Path('/opt/squabble/model-manifest.json')
        if not verify_manifest(Path(os.environ['DOCLING_SERVE_ARTIFACTS_PATH']), json.loads(model_file.read_text())):
            raise RuntimeError('BUNDLE_MODELS_INVALID')
        model_hash = digest_file(model_file)
        os.environ['DOCLING_SERVE_API_KEY'] = key
        command, port = ['docling-serve', 'run'], 5001
        os.environ.update(UVICORN_HOST='127.0.0.1', UVICORN_PORT='5001')
    else:
        command, port = [sys.executable, '-m', 'aktools'], 8080
        # Bind loopback while allowing the proxy's fixed Host. No public raw API.
        os.environ.update(AKTOOLS_HOST='127.0.0.1', AKTOOLS_PORT='8080')
    upstream = subprocess.Popen(command)
    version = importlib.metadata.version('docling-serve' if engine == 'docling' else 'aktools')

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def answer(self, status, data, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def handle_request(self):
            if self.path == '/health' and self.command == 'GET':
                ready = False
                try:
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                    connection.request('GET', '/health' if engine == 'docling' else '/openapi.json')
                    response = connection.getresponse()
                    ready = upstream.poll() is None and response.status == 200
                    response.read(MAX_RESPONSE)
                    connection.close()
                except OSError:
                    pass
                self.answer(200 if ready else 503, json.dumps({'ready': ready, 'engine': engine, 'engineVersion': version,
                    'modelsVerified': bool(model_hash), 'modelManifestSha256': model_hash}).encode())
                return
            expected = self.headers.get('X-Api-Key', '') if engine == 'docling' else self.headers.get('Authorization', '').removeprefix('Bearer ')
            if not hmac.compare_digest(expected, key):
                self.answer(401, b'{"error":"unauthorized"}')
                return
            if not route_allowed(engine, self.command, self.path):
                self.answer(404, b'{"error":"route_unavailable"}')
                return
            try:
                if self.headers.get('Transfer-Encoding'):
                    self.answer(400, b'{"error":"content_length_required"}')
                    return
                length = int(self.headers.get('Content-Length', '0'))
                if length < 0 or length > MAX_UPLOAD:
                    self.answer(413, b'{"error":"request_too_large"}')
                    return
                self.connection.settimeout(30)
                body = self.rfile.read(length)
                if len(body) != length:
                    self.answer(400, b'{"error":"incomplete_request"}')
                    return
                if engine == 'aktools':
                    request = json.loads(body)
                    method = request.get('method') if isinstance(request, dict) else None
                    if method == 'tools/list':
                        self.answer(200, json.dumps({'jsonrpc': '2.0', 'id': request.get('id'), 'result': {'tools': [{
                            'name': 'get_data', 'description': 'Read public CN daily prices or HK income through fixed reviewed operations.',
                            'inputSchema': AKTOOLS_SCHEMA, 'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True, 'openWorldHint': True}
                        }]}}).encode())
                        return
                    if method not in ['initialize', 'notifications/initialized', 'ping'] and not (method == 'tools/call' and financial_call_allowed(request.get('params'))):
                        self.answer(200, json.dumps({'jsonrpc': '2.0', 'id': request.get('id'), 'error': {'code': -32602, 'message': 'Operation unavailable in bundled financial facade'}}).encode())
                        return
                headers = {name: value for name, value in self.headers.items() if name.lower() in
                    ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id']}
                if engine == 'docling':
                    headers['X-Api-Key'] = key
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=610)
                connection.request(self.command, self.path, body=body, headers=headers)
                response = connection.getresponse()
                data = response.read(MAX_RESPONSE + 1)
                if len(data) > MAX_RESPONSE:
                    connection.close()
                    self.answer(502, b'{"error":"response_too_large"}')
                    return
                self.answer(response.status, data, response.getheader('Content-Type', 'application/json'))
                connection.close()
            except (OSError, ValueError, http.client.HTTPException):
                self.answer(502, b'{"error":"upstream_unavailable"}')

        do_GET = handle_request
        do_POST = handle_request
        do_DELETE = handle_request
        do_PUT = handle_request

    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ['BUNDLE_PORT'])), Handler)
    server.daemon_threads = True

    def stop(*_):
        upstream.terminate()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=lambda: (upstream.wait(), stop()), daemon=True).start()
    try:
        server.serve_forever()
    finally:
        upstream.terminate()
        try:
            upstream.wait(timeout=10)
        except subprocess.TimeoutExpired:
            upstream.kill()


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'manifest':
        Path(sys.argv[3]).write_text(json.dumps(create_manifest(Path(sys.argv[2])), indent=2))
    else:
        run()
