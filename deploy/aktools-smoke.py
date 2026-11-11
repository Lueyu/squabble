"""Actual bundled MCP metadata and one public historical-data call; no models."""
import json
from pathlib import Path
import time
import urllib.request
import urllib.error

token = Path('/run/secrets/aktools-token').read_text().strip()
base = 'http://127.0.0.1:8081/mcp'


def rpc(identifier, method, params):
    payload = json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params}).encode()
    req = urllib.request.Request(base, payload, headers={'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
    with urllib.request.urlopen(req, timeout=90) as response:
        data = response.read().decode()
        if response.headers.get('Content-Type', '').startswith('text/event-stream'):
            data = '\n'.join(line[6:] for line in data.splitlines() if line.startswith('data: '))
        return json.loads(data)


started = time.monotonic()
initial = rpc(1, 'initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'squabble-bundle-fixture', 'version': '1'}})
assert 'result' in initial, initial
catalog = rpc(2, 'tools/list', {})
tools = catalog['result']['tools']
assert len(tools) == 1 and tools[0]['name'] == 'get_data'
assert tools[0]['inputSchema']['additionalProperties'] is False
denied = rpc(3, 'tools/call', {'name': 'get_data', 'arguments': {'name': 'arbitrary_function', 'params': {}, 'max_rows': 10, 'offset': 0}})
assert denied.get('error', {}).get('code') == -32602
print(json.dumps({'metadata': 'passed', 'server': initial['result']['serverInfo'], 'schema': tools[0]['inputSchema'], 'unsupportedOperationDenied': True}), flush=True)
try:
    result = rpc(4, 'tools/call', {'name': 'get_data', 'arguments': {'name': 'stock_zh_a_hist', 'params': {
        'symbol': '600000', 'period': 'daily', 'start_date': '20250102', 'end_date': '20250110', 'adjust': ''}, 'max_rows': 1000, 'offset': 0}})
    if 'error' in result:
        raise RuntimeError('MCP upstream returned protocol error')
    body = result['result']
    text = next((block['text'] for block in body.get('content', []) if block.get('type') == 'text'), '{}')
    data = json.loads(text)
    if body.get('isError') or not isinstance(data.get('rows'), list) or not data['rows']:
        print(json.dumps({'publicQuery': 'upstream_unavailable', 'seconds': round(time.monotonic() - started, 3)}))
    else:
        print(json.dumps({'publicQuery': 'passed', 'operation': data['name'], 'rows': len(data['rows']), 'totalRows': data['total_rows'],
            'columns': data['columns'], 'seconds': round(time.monotonic() - started, 3)}, ensure_ascii=False))
except (urllib.error.URLError, ValueError, RuntimeError, KeyError) as error:
    print(json.dumps({'publicQuery': 'upstream_unavailable', 'error': type(error).__name__, 'seconds': round(time.monotonic() - started, 3)}))
