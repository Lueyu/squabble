"""Stock Agent CLI。

子命令演进：Day 1 ``init``；Day 2 ``health``、``quote``（webapp 公开端点）；
Day 3 ``holdings``（带鉴权的 agent gateway）、``modelping``（OpenAI-compatible LLM）。

上游/下游：
  - 下游：``config``（读取配置并初始化目录）、``logging_conf``（初始化日志）、
    ``models.openai_compatible.build_provider``（构造模型 provider）、
    ``runtime.webapp_client.WebappClient``（webapp HTTP 客户端）。
  - 上游：typer 应用入口（``agent = agent_core.cli:app``，见 agent/pyproject.toml）。

关键约定：
  - ``holdings`` 走网关需要 ``WEBAPP_AGENT_TOKEN``（以 ``x-agent-token`` 头发送）。
  - 所有失败路径均以非零退出码结束（``typer.Exit(code=1)``），便于脚本判断。
  - ``health`` 固定用 ``AAPL`` 经公开行情端点探测 webapp 可达性。
"""

import typer
from rich.console import Console
from rich.table import Table

from .config import ensure_dirs, get_settings
from .logging_conf import setup_logging
from .models.openai_compatible import build_provider
from .runtime.webapp_client import WebappClient

app = typer.Typer(help="Stock Agent CLI")
console = Console()


@app.callback()
def _main() -> None:
    """根命令组（即使只有一个子命令也保持显式声明）。"""


@app.command()
def init() -> None:
    """初始化配置与目录，打印解析后的设置（key 仅显示是否已配置）。"""
    s = get_settings()
    setup_logging(s.log_level)
    ensure_dirs(s)
    console.print("[green]stock-agent initialized[/green]")
    console.print(f"webapp = {s.webapp_base_url}")
    console.print(f"default tier = {s.default_tier}")
    console.print(f"flash key configured = {bool(s.flash_api_key)} ({s.flash_model})")
    console.print(f"pro key configured   = {bool(s.pro_api_key)} ({s.pro_model})")
    console.print(f"checkpoint dir = {s.checkpoint_dir}")


@app.command()
def health() -> None:
    """通过公开行情端点探测 webapp 可达性。"""
    s = get_settings()
    setup_logging(s.log_level)

    # 取一次 AAPL 行情作探针；网络 / HTTP 错误 -> 非零退出码，便于脚本判断。
    try:
        with WebappClient(s.webapp_base_url) as client:
            quote = client.get_quote("AAPL")
    except Exception as exc:
        console.print(f"[red]webapp unreachable:[/red] {type(exc).__name__}: {exc}")
        raise typer.Exit(code=1)

    # webapp 可达但未返回行情：同样视为异常并以非零退出码结束。
    if not quote:
        console.print("[yellow]webapp reachable, but no quote returned for AAPL[/yellow]")
        raise typer.Exit(code=1)

    console.print(
        f"[green]webapp OK[/green]  AAPL {quote.get('price')} "
        f"({quote.get('changePercent')}%)  {quote.get('currency')}"
    )


@app.command()
def quote(
    symbol: str = typer.Argument("AAPL", help="Ticker, e.g. AAPL / 0700.HK / 600519"),
) -> None:
    """通过 webapp 公开行情端点获取实时报价。

    Args:
        symbol: 股票代码，如 AAPL / 0700.HK / 600519（默认 AAPL）。
    """
    s = get_settings()
    setup_logging(s.log_level)

    # 公开端点无需鉴权；请求失败即非零退出。
    try:
        with WebappClient(s.webapp_base_url) as client:
            data = client.get_quote(symbol)
    except Exception as exc:
        console.print(f"[red]request failed:[/red] {type(exc).__name__}: {exc}")
        raise typer.Exit(code=1)

    # 未返回行情：提示并以非零退出码结束。
    if not data:
        console.print(f"[yellow]no quote returned for {symbol}[/yellow]")
        raise typer.Exit(code=1)

    console.print_json(data=data)


@app.command()
def holdings() -> None:
    """通过带鉴权的 agent gateway 列出所有者的持仓。"""
    s = get_settings()
    setup_logging(s.log_level)

    # 网关要求 x-agent-token 头；未配置令牌则直接失败。
    if not s.webapp_agent_token:
        console.print(
            "[red]no WEBAPP_AGENT_TOKEN configured[/red] "
            "(the gateway requires x-agent-token)"
        )
        raise typer.Exit(code=1)

    # 携带网关头请求 /openapi/agent-gateway/holdings。
    try:
        with WebappClient(
            s.webapp_base_url,
            token=s.webapp_agent_token,
            user_id=s.webapp_default_user_id or None,
        ) as client:
            rows = client.get_holdings()
    except Exception as exc:
        console.print(f"[red]gateway request failed:[/red] {type(exc).__name__}: {exc}")
        raise typer.Exit(code=1)

    # 输出汇总行；无持仓则到此结束。
    acting = s.webapp_default_user_id or "gateway default"
    console.print(f"[green]gateway OK[/green]  {len(rows)} holding(s) for "
                  f"{acting}")
    if not rows:
        return

    # 以 rich 表格逐行渲染持仓字段；缺失字段以空串或 "-" 兜底。
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Ticker")
    table.add_column("Company")
    table.add_column("Shares", justify="right")
    table.add_column("Price", justify="right")
    table.add_column("Rating")
    table.add_column("Action")
    for h in rows:
        table.add_row(
            str(h.get("ticker") or ""),
            str(h.get("company") or ""),
            str(h.get("shares") or ""),
            str(h.get("currentPrice") or ""),
            str(h.get("rating") or "-"),
            str(h.get("action") or "-"),
        )
    console.print(table)


@app.command()
def modelping(
    tier: str = typer.Argument(
        None, help="Model tier: flash | pro (defaults to DEFAULT_TIER)"
    ),
) -> None:
    """发送一次最小 chat 请求，验证指定模型档位在 Ark 上可用。

    Args:
        tier: 档位 ``flash`` | ``pro``（缺省时使用 ``DEFAULT_TIER`` 配置）。
    """
    s = get_settings()
    setup_logging(s.log_level)

    # 未显式指定档位时回退到配置的默认档位。
    chosen = tier or s.default_tier

    # 构造 provider 并发送一次最小请求；失败即非零退出。
    try:
        result = build_provider(s, chosen).ping()
    except Exception as exc:
        console.print(
            f"[red]model ping failed ({chosen}):[/red] {type(exc).__name__}: {exc}"
        )
        raise typer.Exit(code=1)

    # 输出延迟与 token 用量。
    console.print(
        f"[green]model OK[/green]  tier={result.tier}  model={result.model}  "
        f"{result.latency_ms}ms  tokens={result.prompt_tokens}+{result.completion_tokens}"
    )

    # 推理模型可能没有可见回复、只有隐藏 reasoning；此时打印其尾部片段。
    if result.reply:
        console.print(f"reply: {result.reply}")
    elif result.reasoning:
        console.print(
            f"[yellow]no visible content (reasoning model); reasoning tail:[/yellow] "
            f"{result.reasoning[-120:]}"
        )


if __name__ == "__main__":
    app()
