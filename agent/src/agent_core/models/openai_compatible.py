"""OpenAI-compatible 聊天模型 provider。

flash / pro 两档在 Volcengine Ark 上使用同一套 OpenAI-compatible 聊天协议，
仅 API key 与 model id 不同。本类保持该接缝最小化，使后续里程碑加入
streaming、用量统计、重试与路由时无需改动调用方。

上游/下游：
  - 上游：``cli.modelping`` 经 ``build_provider`` 使用本模块。
  - 下游：OpenAI SDK（``openai.OpenAI``）-> ``settings.model_base_url`` 指向的端点。

关键约定：
  - 构造时缺失 API key 即抛 ``ValueError``（提示设置 ``FLASH_API_KEY`` /
    ``PRO_API_KEY``）。
  - ``ping`` 请求 ``max_tokens=64``、``temperature=0``；SDK 客户端默认超时 20 秒。
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from openai import OpenAI

from ..config import Settings


@dataclass(frozen=True)
class PingResult:
    """一次最小 chat 往返的结果。

    Attributes:
        tier: 档位名（``flash`` / ``pro``）。
        model: 服务端返回的 model id（优先于构造时传入的 id）。
        reply: 可见回复文本（已去首尾空白，可能为空串）。
        reasoning: 推理模型的隐藏 ``reasoning_content``（无则空串）。
        prompt_tokens: 输入 token 用量（无 usage 时为 0）。
        completion_tokens: 输出 token 用量（无 usage 时为 0）。
        latency_ms: 往返耗时（毫秒）。
    """

    tier: str
    model: str
    reply: str
    reasoning: str
    prompt_tokens: int
    completion_tokens: int
    latency_ms: int


class OpenAICompatibleProvider:
    """对 OpenAI-compatible 厂商的 OpenAI SDK 薄封装。"""

    def __init__(
        self,
        tier: str,
        base_url: str,
        api_key: str | None,
        model: str,
        timeout: float = 20.0,
    ) -> None:
        """构造 provider 并创建底层 OpenAI SDK 客户端。

        Args:
            tier: 档位名（``flash`` / ``pro``），用于标识与报错信息。
            base_url: OpenAI-compatible 根地址（如 Ark 的 ``.../api/v3``）。
            api_key: 该档位的 API key；缺失时抛 ``ValueError``。
            model: 模型 id。
            timeout: SDK 客户端超时（秒），默认 20.0。

        Raises:
            ValueError: ``api_key`` 缺失时。
        """
        if not api_key:
            raise ValueError(
                f"missing API key for '{tier}' tier (set {tier.upper()}_API_KEY)"
            )
        self.tier = tier
        self.model = model
        self._client = OpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
        )

    def ping(self, prompt: str = "Reply with exactly one word: pong") -> PingResult:
        """发送一个极简 prompt，返回回复内容、token 用量与延迟。

        鉴权 / 限流 / 网络 / 模型失败时抛出 ``openai.*`` 异常，使 CLI 能原样
        展示厂商错误信息。推理模型可能先在隐藏的 ``reasoning_content`` 链上
        花费 token；max_tokens 预算保持足够大，以仍能返回可见答案。
        """
        # 发送单轮最小请求并计时。
        started = time.perf_counter()
        resp = self._client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=64,
            temperature=0,
        )
        latency_ms = int((time.perf_counter() - started) * 1000)

        # 提取可见回复、隐藏 reasoning 与用量信息。
        message = resp.choices[0].message
        reasoning = getattr(message, "reasoning_content", None) or ""
        usage = resp.usage

        return PingResult(
            tier=self.tier,
            model=resp.model or self.model,
            reply=(message.content or "").strip(),
            reasoning=reasoning.strip(),
            prompt_tokens=usage.prompt_tokens if usage else 0,
            completion_tokens=usage.completion_tokens if usage else 0,
            latency_ms=latency_ms,
        )


def build_provider(
    settings: Settings,
    tier: str | None = None,
) -> OpenAICompatibleProvider:
    """按档位（"flash" 或 "pro"）构造 provider。

    Args:
        settings: 已解析的应用配置。
        tier: ``"flash"`` / ``"pro"``；缺省时使用 ``settings.default_tier``。

    Raises:
        ValueError: 档位名无法识别时。
    """
    chosen = (tier or settings.default_tier).strip().lower()

    if chosen == "flash":
        return OpenAICompatibleProvider(
            "flash",
            settings.model_base_url,
            settings.flash_api_key,
            settings.flash_model,
        )

    if chosen == "pro":
        return OpenAICompatibleProvider(
            "pro",
            settings.model_base_url,
            settings.pro_api_key,
            settings.pro_model,
        )

    raise ValueError(f"unknown model tier '{chosen}' (expected 'flash' or 'pro')")
