"""从环境变量 / .env 加载配置（12-factor）。

模型布局：flash 与 pro 两档都走 Volcengine Ark 的 OpenAI-compatible 端点；
区分的是*角色*而非厂商：

  - ``flash``：便宜、快，作为流水线常规步骤的默认档位。
  - ``pro``：更强，保留给高风险决策（评级、仓位测算）。

某任务用哪一档是调用方一行代码的选择；两档的 provider 构造完全一致。

上游/下游：
  - 下游：``cli``、``models.openai_compatible`` 等模块经 ``get_settings()`` /
    ``Settings`` 读取配置；``ensure_dirs()`` 创建 checkpoint 目录。
  - 上游：pydantic-settings 按字段名从进程环境变量与 ``.env``（utf-8）解析。

关键约定：
  - 字段名即环境变量名（大小写不敏感）：``WEBAPP_BASE_URL``、
    ``WEBAPP_AGENT_TOKEN``、``WEBAPP_DEFAULT_USER_ID``、``MODEL_BASE_URL``、
    ``DEFAULT_TIER``、``FLASH_API_KEY``、``FLASH_MODEL``、``PRO_API_KEY``、
    ``PRO_MODEL``、``CHECKPOINT_DIR``、``LOG_LEVEL``。
  - ``extra="ignore"``：环境 / .env 中的未知字段直接忽略，不报错。
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置（pydantic-settings）。

    字段按用途分组：webapp 连接、模型档位、运行时目录与日志；
    环境 / .env 中的同名字段（大小写不敏感）覆盖下列默认值。
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Webapp（NestJS 服务）
    webapp_base_url: str = "http://localhost:3000"
    webapp_agent_token: str | None = None
    webapp_default_user_id: str = "local-dev"

    # Volcengine Ark 的 OpenAI-compatible 根地址，flash / pro 两档共用。
    model_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"
    # 模型调用默认档位："flash"（便宜/快）或 "pro"（更强）。
    default_tier: str = "flash"

    # flash 档：常规任务，便宜、快。
    flash_api_key: str | None = None
    flash_model: str = "deepseek-v4-1-flash-260910"

    # pro 档：高风险决策。
    pro_api_key: str | None = None
    pro_model: str = "deepseek-v4-pro-260425"

    # 运行时
    checkpoint_dir: str = "data/checkpoints"
    log_level: str = "INFO"


def get_settings() -> Settings:
    """构造并返回 ``Settings``（每次调用都重新从环境 / .env 解析）。"""
    return Settings()


def ensure_dirs(s: Settings) -> None:
    """确保 checkpoint 目录存在（连同父目录；已存在则跳过）。

    Args:
        s: 已解析的应用配置，使用其 ``checkpoint_dir`` 字段。
    """
    Path(s.checkpoint_dir).mkdir(parents=True, exist_ok=True)
