"""Run inside the prepared, network-isolated Docling container on CC0 fixtures.

docker compose -p <unique> ... exec -T docling python - < deploy/document-smoke.py
No additional Python package, model download or public document is used.
"""
import hashlib
import json
from pathlib import Path
import time
import urllib.request
import urllib.error
import uuid
import socket

ROOT = Path('/fixtures')
TOKEN = Path('/run/secrets/docling-token').read_text().strip()
BASE = 'http://127.0.0.1:5002'

# The Compose internal network denies Internet even if a parser tries to fetch a
# missing model. This conversion must therefore succeed with local assets only.
try:
    with socket.create_connection(('1.1.1.1', 443), timeout=2):
        raise RuntimeError('Acceptance requires an isolated internal network')
except OSError:
    pass


def request(path, data=None, content_type=None):
    headers = {'X-Api-Key': TOKEN}
    if content_type:
        headers['Content-Type'] = content_type
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=620) as response:
        return json.load(response)


def submit(case):
    boundary = 'squabble-' + uuid.uuid4().hex
    values = [('to_formats', 'md'), ('to_formats', 'json'), ('image_export_mode', 'placeholder'),
              ('do_picture_description', 'false'), ('do_ocr', 'true'), ('ocr_engine', 'rapidocr'), ('ocr_lang', 'iso:zh')]
    body = b''
    for name, value in values:
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    mime = 'application/pdf' if case['file'].endswith('.pdf') else 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{case["file"]}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
    body += (ROOT / case['file']).read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    return request('/v1/convert/file/async', body, f'multipart/form-data; boundary={boundary}')


gold = json.loads((ROOT / 'gold.json').read_text())
results = []
for case in gold['cases']:
    started = time.monotonic()
    result = {'file': case['file'], 'kind': case['kind'], 'expectedState': case['expectedState']}
    assert hashlib.sha256((ROOT / case['file']).read_bytes()).hexdigest() == case['sha256']
    try:
        receipt = submit(case)
        task_id = receipt['task_id']
        while time.monotonic() - started < 620:
            state = request('/v1/status/poll/' + task_id)['task_status']
            if state not in ['pending', 'started']:
                break
            time.sleep(0.5)
        result['taskState'] = state
        if state == 'success':
            raw = request('/v1/result/' + task_id)
            document = raw['document']
            markdown = document['md_content']
            lossless = document['json_content']
            compact = markdown.replace(',', '').replace('−', '-')
            result.update(parsed=True, chars=len(markdown), expectedTextMatches={value: value in compact for value in case['expectedText']},
                          physicalPages=len(lossless.get('pages', {})),
                          textLocators=sum(len(item.get('prov', [])) for item in lossless.get('texts', [])),
                          elementIds=sum(bool(item.get('self_ref')) for item in lossless.get('texts', [])))
        else:
            result['parsed'] = False
    except urllib.error.HTTPError as error:
        result.update(parsed=False, httpStatus=error.code)
    except Exception as error:
        result.update(parsed=False, error=type(error).__name__)
    result['seconds'] = round(time.monotonic() - started, 3)
    result['stateMatches'] = result['parsed'] == (case['expectedState'] == 'parsed')
    results.append(result)
    print(json.dumps({'progress': result}, ensure_ascii=False), flush=True)

summary = {'fixtureLicense': 'CC0-1.0', 'fixtureCases': len(results), 'offline': True,
           'stateMatches': sum(case['stateMatches'] for case in results),
           'matchedExpectedValues': sum(sum(case.get('expectedTextMatches', {}).values()) for case in results),
           'expectedValues': sum(len(case.get('expectedTextMatches', {})) for case in results),
           'totalSeconds': round(sum(case['seconds'] for case in results), 3), 'cases': results}
print(json.dumps(summary, ensure_ascii=False), flush=True)
if not all(case['stateMatches'] for case in results):
    raise SystemExit(1)
chinese = next(case for case in results if case['file'] == '12-chinese-scan.pdf')
if not all(chinese.get('expectedTextMatches', {}).values()) or not chinese.get('textLocators'):
    raise SystemExit(2)
