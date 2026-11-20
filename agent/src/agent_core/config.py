"""Configuration loaded from environment variables / .env (12-factor).

Model layout: both tiers go through the Volcengine Ark OpenAI-compatible
endpoint. The distinction is *role*, not vendor:

  - ``flash``: cheap and fast, the default for routine pipeline steps.
  - ``pro``:   stronger, reserved for high-stakes decisions (ratings, sizing).

Routing which tier a task uses is a one-line choice on the caller side; the
provider construction is identical for both.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):

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
    return Settings()


def ensure_dirs(s: Settings) -> None:
    Path(s.checkpoint_dir).mkdir(parents=True, exist_ok=True)
