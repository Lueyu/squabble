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

`uv.lock` records all transitive packages and hashes. A deployed template must
retain the installed distributions' license and notice files, including those
of transitive packages. No dependency license is relabeled MIT.
