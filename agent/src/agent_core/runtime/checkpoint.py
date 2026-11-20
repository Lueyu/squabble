"""Append-only JSONL event log for run checkpointing.

This is the Day 3 foundation for long-run reliability (the full resume feature
lands in M3). The design is event sourcing:

  - A run never mutates stored state in place. It *appends* immutable events to
    ``<checkpoint_dir>/<run_id>.jsonl``, one JSON object per line.
  - State is reconstructed by replaying the event log from the beginning through
    a reducer (``replay``). Appending is cheap and crash-safe: if the process dies
    mid-run, everything already on disk is a valid prefix, and replaying it
    rebuilds the state reached so far.

Each event is ``{"seq": int, "type": str, "ts": float, "payload": dict}``.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

#: 单条日志事件的形状。
Event = dict[str, Any]


@dataclass(frozen=True)
class Checkpoint:
    """Handle identifying one run's append-only log."""

    run_id: str
    path: Path


class CheckpointStore:
    """Creates and appends to per-run JSONL logs under a root directory."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self, run_id: str | None = None) -> Checkpoint:
        """Return a checkpoint handle for a run (generates an id if absent)."""
        run_id = run_id or uuid.uuid4().hex[:12]
        return Checkpoint(run_id=run_id, path=self.root / f"{run_id}.jsonl")

    def append(
        self,
        cp: Checkpoint,
        event_type: str,
        payload: dict | None = None,
    ) -> Event:
        """Append one event and return the stored record.

        ``seq`` is derived from the existing line count so events are numbered
        consecutively even across process restarts.
        """
        # 确保目录存在，并以现有行数推导连续序号。
        cp.path.parent.mkdir(parents=True, exist_ok=True)
        seq = self._count_lines(cp.path)

        # 组装事件并追加写入（utf-8，保留非 ASCII 字符）。
        event: Event = {
            "seq": seq,
            "type": event_type,
            "ts": time.time(),
            "payload": payload or {},
        }
        with cp.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
        return event

    def load(self, cp: Checkpoint) -> list[Event]:
        """Read all events back in append order (empty list if the log is absent)."""
        if not cp.path.exists():
            return []

        # 逐行解析非空行，保持追加顺序。
        events: list[Event] = []
        with cp.path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    events.append(json.loads(line))
        return events

    @staticmethod
    def _count_lines(path: Path) -> int:
        if not path.exists():
            return 0
        count = 0
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    count += 1
        return count


def replay(
    events: Iterable[Event],
    initial: Any,
    reducer: Callable[[Any, Event], Any],
) -> Any:
    """Fold an event log into state by applying ``reducer`` left to right.

    Args:
        events: Ordered events, typically from ``CheckpointStore.load``.
        initial: Starting state before any event.
        reducer: Pure function ``(state, event) -> next_state``.
    """
    state = initial
    for event in events:
        state = reducer(state, event)
    return state
