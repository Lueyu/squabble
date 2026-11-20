"""OpenAI-compatible chat model provider.

Both tiers (flash / pro) speak the same OpenAI-compatible chat protocol on
Volcengine Ark; only the API key and model id differ. This class keeps that seam
minimal so M1 can add streaming, usage accounting, retries and routing without
changing call sites.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from openai import OpenAI

from ..config import Settings


@dataclass(frozen=True)
class PingResult:
    """Outcome of a single minimal chat round-trip."""

    tier: str
    model: str
    reply: str
    reasoning: str
    prompt_tokens: int
    completion_tokens: int
    latency_ms: int


class OpenAICompatibleProvider:
    """Thin wrapper over the OpenAI SDK for an OpenAI-compatible vendor."""

    def __init__(
        self,
        tier: str,
        base_url: str,
        api_key: str | None,
        model: str,
        timeout: float = 20.0,
    ) -> None:
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
        """Send a trivial prompt and report the reply, token usage and latency.

        Raises an ``openai.*`` error on auth/rate-limit/network/model failure so
        the CLI can surface the vendor's exact message. Reasoning models may spend
        tokens on a hidden ``reasoning_content`` chain before answering; the token
        budget is kept large enough to still return a visible answer.
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
    """Construct a provider for a model tier ("flash" or "pro").

    Args:
        settings: Resolved application settings.
        tier: ``"flash"`` / ``"pro"``; defaults to ``settings.default_tier``.
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
