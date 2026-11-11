# Bundled capability notices

The Web bundle redistributes Linux container images. Each image retains its
distribution/package notices. Source references and a model-file SHA-256
inventory accompany the exact release. An image's software license does not
replace a model's license, or a financial provider's data terms.

| Component | Fixed release | Source / notices |
| --- | --- | --- |
| Docling Serve | 1.38.2 CPU amd64 | [MIT source](https://github.com/docling-project/docling-serve/tree/v1.38.2); `workers/documents/licenses/Docling-Serve-LICENSE` |
| Docling toolkit | 2.142.1 | [MIT source](https://github.com/docling-project/docling/tree/v2.142.1) |
| Heron layout | exact files in release manifest | [Apache-2.0 model card](https://huggingface.co/docling-project/docling-layout-heron) |
| TableFormer | exact files in release manifest | [model card](https://huggingface.co/docling-project/docling-models), Apache-2.0 and CDLA-Permissive-2.0; bundled texts retained |
| RapidOCR | 3.10.0 | [Apache-2.0 source](https://github.com/RapidAI/RapidOCR/tree/v3.10.0); converted PaddleOCR models retain Baidu/PaddleOCR notices |
| EasyOCR | 1.7.2 | [Apache-2.0 source](https://github.com/JaidedAI/EasyOCR/tree/v1.7.2); included upstream assets are inventoried even though the default adapter selects RapidOCR |
| AKTools / AKShare | 0.1.5 / 1.20.37 | [AKTools MIT](https://github.com/akfamily/aktools), [AKShare MIT](https://github.com/akfamily/akshare); texts in `workers/aktools/licenses/` |
| Playwright / Chromium | Playwright 1.65.0 matched image | [Apache-2.0 source](https://github.com/microsoft/playwright/tree/v1.65.0), Chromium and OS third-party notices retained in the upstream image |

The pinned upstream Docling image also includes its picture-classifier model and
all package licenses; the default adapter disables enrichment and remote model
services. The release's generated model manifest is authoritative for the actual
files present. No MinerU image or weights are part of the default bundle.

AKTools queries public providers over the deployment server's Internet
connection. Their availability, permitted uses, rate limits, redistribution and
retention rules continue to apply independently of the MIT software licenses.
The bundle does not assert a new data redistribution license.

Analytics uses the existing fixed worker lock and its existing QuantStats /
Backtrader dependency notices; see `workers/analytics/README.md`. Its builder and
the AKTools image use [uv 0.13.1](https://github.com/astral-sh/uv/tree/0.13.1),
distributed under MIT OR Apache-2.0; its upstream image and package notices are
retained. Analytics currently retains this build utility and its cache, so its
measured image size is not a minimum-runtime-size claim.
