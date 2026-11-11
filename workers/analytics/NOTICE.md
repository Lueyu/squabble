# Independent analytics worker notices

This directory is an independent GPL-3.0-or-later worker. Its source is licensed
under the included GNU GPL version 3; redistribution must preserve this license
and provide the corresponding worker source and build/dependency information.
The application's root MIT license does not replace the worker's license.

The worker communicates with the application by versioned JSON files. It does
not import the application's database, model, account or order implementation.

Direct dependencies and recorded upstream licenses:

- Backtrader 1.9.78.123 — GPL-3.0-or-later, Daniel Rodriguez; see `LICENSE`.
- QuantStats 0.0.86 — Apache-2.0; see `licenses/QuantStats-Apache-2.0.txt`.
- pandas 2.3.3 — BSD-3-Clause.
- NumPy 2.3.5 — BSD-3-Clause.
- Matplotlib 3.10.7 — Matplotlib/PSF compatible license; bundled DejaVu Sans
  retains its upstream font license in the installed Matplotlib distribution.
- uv 0.13.1 — MIT OR Apache-2.0, Astral Software Inc.; the container's retained
  build-tool binary is accompanied by `licenses/uv-LICENSE-MIT.txt` and
  `licenses/uv-LICENSE-APACHE.txt`. These exact texts were obtained from the
  upstream `astral-sh/uv` tag `0.13.1` (`LICENSE-MIT`, `LICENSE-APACHE`), with
  SHA-256 `860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c`
  and `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`.

`uv.lock` records all transitive packages and hashes. A deployed template must
retain the installed distributions' license and notice files, including those
of transitive packages. No dependency license is relabeled MIT.
