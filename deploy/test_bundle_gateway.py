import importlib.util
from pathlib import Path
import tempfile
import unittest


class GatewayContract(unittest.TestCase):
    def module(self):
        spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('bundle_gateway.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_docling_only_accepts_adapter_routes(self):
        allowed = self.module().route_allowed
        self.assertTrue(allowed('docling', 'POST', '/v1/convert/file/async'))
        self.assertTrue(allowed('docling', 'GET', '/v1/status/poll/task-123'))
        self.assertTrue(allowed('docling', 'GET', '/v1/result/task-123'))
        for path in ['/v1/convert/source', '/v1/convert/source/async', '/docs', '/v1/clear/converters', '/v1/result/a/b', '/v1/result/..', '/v1/result/a?url=https://example.com']:
            self.assertFalse(allowed('docling', 'POST', path), path)
            self.assertFalse(allowed('docling', 'GET', path), path)
        self.assertFalse(allowed('aktools', 'GET', '/api/public/get_data'))
        self.assertTrue(allowed('aktools', 'POST', '/mcp'))

    def test_model_manifest_detects_corruption_and_missing_files(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'weights.bin').write_bytes(b'synthetic model fixture')
            manifest = module.create_manifest(root)
            self.assertTrue(module.verify_manifest(root, manifest))
            (root / 'weights.bin').write_bytes(b'changed')
            self.assertFalse(module.verify_manifest(root, manifest))
            (root / 'weights.bin').unlink()
            self.assertFalse(module.verify_manifest(root, manifest))

    def test_mcp_facade_only_exposes_fixed_financial_queries(self):
        module = self.module()
        valid = {'name': 'get_data', 'arguments': {'name': 'stock_zh_a_hist', 'params': {'symbol': '600000', 'period': 'daily', 'start_date': '20250101', 'end_date': '20250110', 'adjust': ''}, 'max_rows': 1000, 'offset': 0}}
        self.assertTrue(module.financial_call_allowed(valid))
        for invalid in [dict(valid, name='other_tool'), {'name': 'get_data', 'arguments': dict(valid['arguments'], name='arbitrary_akshare_function')},
                        {'name': 'get_data', 'arguments': dict(valid['arguments'], offset=-1)},
                        {'name': 'get_data', 'arguments': dict(valid['arguments'], params=dict(valid['arguments']['params'], url='http://localhost'))}]:
            self.assertFalse(module.financial_call_allowed(invalid))


if __name__ == '__main__':
    unittest.main()
