"""面向 run checkpoint 的 append-only JSONL 事件日志。

这是 Day 3 的长跑可靠性基础（完整的 resume 功能在 M3 落地）。设计为事件溯源
（event sourcing）：

  - run 永不原地修改已存储状态，而是向 ``<checkpoint_dir>/<run_id>.jsonl``
    *追加*不可变事件，每行一个 JSON 对象。
  - 状态通过从头重放事件日志（reducer，见 ``replay``）重建。追加廉价且
    crash-safe：进程中途死亡时，磁盘上已有内容是合法前缀，重放即可恢复到
    当时的状态。

每条事件形如 ``{"seq": int, "type": str, "ts": float, "payload": dict}``。

上游/下游：
  - 依赖：仅 Python 标准库（json / time / uuid / pathlib / dataclasses /
    typing），不依赖包内其他模块。
  - 根目录由调用方传入；默认目录值见 ``config.Settings.checkpoint_dir``。
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
    """标识一个 run 的 append-only 日志的句柄。"""

    run_id: str
    path: Path


class CheckpointStore:
    """在根目录下创建并追加各 run 的 JSONL 日志。"""

    def __init__(self, root: str | Path) -> None:
        """初始化存储根目录（不存在则连同父目录一起创建）。

        Args:
            root: JSONL 日志的存放根目录。
        """
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self, run_id: str | None = None) -> Checkpoint:
        """返回一个 run 的 checkpoint 句柄（未提供 id 时自动生成 12 位十六进制 id）。"""
        run_id = run_id or uuid.uuid4().hex[:12]
        return Checkpoint(run_id=run_id, path=self.root / f"{run_id}.jsonl")

    def append(
        self,
        cp: Checkpoint,
        event_type: str,
        payload: dict | None = None,
    ) -> Event:
        """追加一条事件并返回落盘后的完整记录。

        ``seq`` 由现有行数推导，保证跨进程重启后事件编号依然连续。
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
        """按追加顺序读回全部事件（日志不存在时返回空列表）。"""
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
        """统计文件中的非空行数（文件不存在时返回 0）。"""
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
    """将事件日志经 ``reducer`` 从左到右折叠为状态。

    Args:
        events: 有序事件，通常来自 ``CheckpointStore.load``。
        initial: 任何事件应用之前的初始状态。
        reducer: 纯函数 ``(state, event) -> next_state``。
    """
    state = initial
    for event in events:
        state = reducer(state, event)
    return state
