"""轻量级日志配置；M5/M6 阶段将替换为结构化 / 链路追踪日志。

上游/下游：``cli`` 在各命令入口调用 ``setup_logging``；实现基于标准库
``logging``（``basicConfig``）。
"""

import logging

# 以下第三方库每个请求都以 INFO 打一行日志；压到 WARNING 以保持 CLI 输出
# 可读。排查问题时可改为 DEBUG 查看线路级细节。
_NOISY_LOGGERS = ("httpx", "httpcore")


def setup_logging(level: str = "INFO") -> None:
    """初始化 root logger 并压制第三方库噪音。

    Args:
        level: 日志级别名（不区分大小写）；无法识别时回退为 ``INFO``。

    副作用：``logging.basicConfig`` 全局生效；``httpx`` / ``httpcore`` 被压到
    ``WARNING``；本包 ``agent_core`` 保持显式指定的级别。
    """
    root_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        level=root_level,
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    )

    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    # 本包自己的 logger 保持显式指定的级别。
    logging.getLogger("agent_core").setLevel(root_level)
