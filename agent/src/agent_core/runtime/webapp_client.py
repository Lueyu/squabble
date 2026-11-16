"""NestJS webapp 的轻量 HTTP 客户端。

公开行情端点（如 ``GET /api/quote/batch``）无需 token；登录作用域端点
（如 ``GET /api/portfolio/holdings``）需要服务间网关头（Day 3 接入）。

设计约束（D4）：agent 永不直连业务数据库。所有业务读写都经本客户端走 HTTP，
使 NestJS 应用保持 auth、账本、风控规则与 schema 的唯一权威。

上游/下游：
  - 上游：``cli`` 的 ``health`` / ``quote`` / ``holdings`` 命令。
  - 下游：httpx 同步客户端 -> webapp（默认 ``http://localhost:3000``，
    见 ``config.Settings.webapp_base_url``）。

关键约定：
  - 重试：tenacity 对可重试异常最多尝试 3 次，指数退避 1~8 秒；仅重试
    httpx 传输层错误（连接失败 / 重置 / 超时）与服务端 5xx。
  - 网关头：``x-agent-token``（共享密钥）、``x-agent-user-id``（可选身份）。
  - 默认单请求超时 15 秒。
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
    """仅重试服务端 5xx；4xx（鉴权 / 参数校验）属确定性失败，不重试。"""
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
    """webapp 的同步 HTTP 客户端。

    Args:
        base_url: NestJS 应用根地址，如 ``http://localhost:3000``。
        token: 可选共享密钥，以 ``x-agent-token`` 头发送（Day 3）。
        user_id: 可选身份标识，以 ``x-agent-user-id`` 头发送（Day 3）。
        timeout: 单请求超时（秒）。
        transport: 可选 httpx transport（测试用于注入 mock）。
    """

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        user_id: str | None = None,
        timeout: float = 15.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        """创建底层 httpx 客户端，并按需组装网关头。

        Args:
            base_url: NestJS 应用根地址（尾部斜杠会被去除）。
            token: 可选共享密钥（``x-agent-token``）。
            user_id: 可选身份标识（``x-agent-user-id``）；仅在提供 token 时才会发送。
            timeout: 单请求超时（秒），默认 15.0。
            transport: 可选 httpx transport（测试注入 mock 用）。

        副作用：创建常驻的 ``httpx.Client``（需 ``close()`` 或 ``with`` 释放）。
        """
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
        """返回 ``symbol`` 对应的单条行情 dict；无法解析时返回 ``{}``。

        响应形状：``{"items": [QuoteResponse, ...]}``，服务端会跳过无法解析的
        代码。字段含 ``price``（字符串）、``change``、``changePercent``、
        ``open``、``high``、``low``、``volume``、``currency``、``market``、
        ``companyName``、``timestamp``、``delayed``。
        """
        resp = self._client.get("/api/quote/batch", params={"symbols": symbol})
        resp.raise_for_status()
        items = resp.json().get("items", [])
        return items[0] if items else {}

    @_retry_decorator
    def get_holdings(self) -> list[dict]:
        """经服务间 agent gateway 获取登录作用域的持仓列表。

        需要构造函数接入的网关头（``x-agent-token`` / ``x-agent-user-id``）；
        NestJS 网关校验 token 并在服务端解析实际所有者。
        """
        resp = self._client.get("/openapi/agent-gateway/holdings")
        resp.raise_for_status()
        body = resp.json()
        if isinstance(body, list):
            return body
        # 兼容 {items: [...]} 或 {data: [...]} 两种响应形状。
        return body.get("items", body.get("data", []))

    def close(self) -> None:
        """关闭底层 httpx 客户端并释放连接。"""
        self._client.close()

    def __enter__(self) -> "WebappClient":
        """支持 ``with`` 语句：返回自身。"""
        return self

    def __exit__(self, *exc: object) -> None:
        """退出 ``with`` 块时关闭客户端。"""
        self.close()
