"""Thin HTTP client for the NestJS webapp.

Public market-data endpoints (e.g. ``GET /api/quote/batch``) need no token.
Login-scoped endpoints (e.g. ``GET /api/portfolio/holdings``) require the
service-to-service gateway headers, which are wired up on Day 3.

Design constraint (D4): the agent never connects to the business database
directly. Every business read/write goes through this client over HTTP, so the
NestJS app stays the single authority for auth, ledger, risk rules and schema.
"""

from __future__ import annotations

import httpx
from tenacity import (
    retry,
    retry_if_exception,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)


def _is_retryable_status(exc: BaseException) -> bool:
    """Retry only server-side 5xx; 4xx (auth/validation) is deterministic."""
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500


# httpx.TransportError 涵盖连接失败、连接重置与超时。
_retry_decorator = retry(
    retry=(
        retry_if_exception_type(httpx.TransportError)
        | retry_if_exception(_is_retryable_status)
    ),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    reraise=True,
)


class WebappClient:
    """Synchronous HTTP client for the webapp.

    Args:
        base_url: Root URL of the NestJS app, e.g. ``http://localhost:3000``.
        token: Optional shared secret sent as ``x-agent-token`` (Day 3).
        user_id: Optional identity sent as ``x-agent-user-id`` (Day 3).
        timeout: Per-request timeout in seconds.
        transport: Optional httpx transport (used by tests to inject a mock).
    """

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        user_id: str | None = None,
        timeout: float = 15.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        # 规整根地址，并按需组装网关头。
        self.base_url = base_url.rstrip("/")
        headers: dict[str, str] = {"Accept": "application/json"}
        if token:
            headers["x-agent-token"] = token
            # 仅在显式提供身份时发送 x-agent-user-id；否则由网关在服务端
            # 解析其配置的默认所有者。
            if user_id:
                headers["x-agent-user-id"] = user_id

        # 创建共享的 httpx 同步客户端（超时与自定义 transport 一并生效）。
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=timeout,
            headers=headers,
            transport=transport,
        )

    @_retry_decorator
    def get_quote(self, symbol: str) -> dict:
        """Return one quote dict for ``symbol``; ``{}`` if it cannot be resolved.

        Response shape: ``{"items": [QuoteResponse, ...]}`` where unresolved
        symbols are skipped server-side. Fields include ``price`` (a string),
        ``change``, ``changePercent``, ``open``, ``high``, ``low``, ``volume``,
        ``currency``, ``market``, ``companyName``, ``timestamp``, ``delayed``.
        """
        resp = self._client.get("/api/quote/batch", params={"symbols": symbol})
        resp.raise_for_status()
        items = resp.json().get("items", [])
        return items[0] if items else {}

    @_retry_decorator
    def get_holdings(self) -> list[dict]:
        """Login-scoped holdings via the service-to-service agent gateway.

        Requires the gateway headers (``x-agent-token`` / ``x-agent-user-id``)
        wired through the constructor; the NestJS gateway validates the token and
        resolves the acting owner server-side.
        """
        resp = self._client.get("/openapi/agent-gateway/holdings")
        resp.raise_for_status()
        body = resp.json()
        if isinstance(body, list):
            return body
        # 兼容 {items: [...]} 或 {data: [...]} 两种响应形状。
        return body.get("items", body.get("data", []))

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "WebappClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
