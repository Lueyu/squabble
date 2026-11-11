"""Headless static charts; gaps remain visible and no remote resources are loaded."""
from pathlib import Path
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def returns_chart(values, output):
    plt.rcParams.update({"font.family": "DejaVu Sans", "svg.fonttype": "path"})
    fig, ax = plt.subplots(figsize=(10, 4), dpi=120)
    ax.plot(range(len(values)), [np.nan if value is None else value for value in values], color="#2563eb")
    ax.axhline(0, color="#64748b", linewidth=0.7)
    ax.set(xlabel="Observation period", ylabel="Return", title="Observed period returns (gaps preserved)")
    fig.tight_layout()
    target = Path(output)
    fig.savefig(target, metadata={"Software": "Squabble analytics worker 1.0.0"})
    plt.close(fig)
