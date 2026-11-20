"""Tiny logging setup; replaced by structured/tracing logging in M5/M6."""

import logging

# 以下第三方库每个请求都以 INFO 打一行日志；压到 WARNING 以保持 CLI 输出
# 可读。排查问题时可改为 DEBUG 查看线路级细节。
_NOISY_LOGGERS = ("httpx", "httpcore")


def setup_logging(level: str = "INFO") -> None:
    root_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        level=root_level,
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    )

    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    # 本包自己的 logger 保持显式指定的级别。
    logging.getLogger("agent_core").setLevel(root_level)
