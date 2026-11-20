/**
 * local-agent-catalog.ts — 本地代理的公开连接元数据目录。
 *
 * 职责边界：
 *  - 提供 providerCatalog：每个 LocalAgentProvider 的展示名、安装引导页 URL 与登录命令，
 *    供客户端渲染"安装/登录"引导。
 *  - 只放连接元数据；可执行文件的定位与调用全部留在 native 运行时内，
 *    客户端与服务器都不接收可执行路径。
 * 上下游：
 *  - 上游：server/modules/local-agents/*（状态探测时回填 loginCommand/installUrl）与
 *    client/src 代理设置界面，共 2 个文件 import 本契约（server 2、client 0）。
 *  - 下游：import type { LocalAgentProvider }（来自 local-agents.interface.ts）。
 * 关键约定：
 *  - 键集合必须与 local-agents.interface.ts 的 LOCAL_AGENT_PROVIDERS 完全一致
 *    （Record<LocalAgentProvider, …> 由类型系统强制）。
 */

import type { LocalAgentProvider } from './local-agents.interface';

/** 公开连接元数据；可执行文件的解析留在 native 运行时内。 */
export const providerCatalog: Record<
  LocalAgentProvider,
  {
    provider: LocalAgentProvider;
    name: string;
    installUrl: string;
    loginCommand: string;
  }
> = {
  codex: {
    provider: 'codex',
    name: 'Codex',
    installUrl: 'https://developers.openai.com/codex/cli/',
    loginCommand: 'codex login',
  },
  claude: {
    provider: 'claude',
    name: 'Claude Code',
    installUrl: 'https://code.claude.com/docs/en/setup',
    loginCommand: 'claude auth login',
  },
  gemini: {
    provider: 'gemini',
    name: 'Gemini CLI',
    installUrl: 'https://geminicli.com/docs/get-started/installation/',
    loginCommand: 'gemini',
  },
  antigravity: {
    provider: 'antigravity',
    name: 'Antigravity',
    installUrl: 'https://antigravity.google/download',
    loginCommand: 'agy',
  },
  opencode: {
    provider: 'opencode',
    name: 'OpenCode',
    installUrl: 'https://opencode.ai/docs/',
    loginCommand: 'opencode auth login',
  },
  kimi: {
    provider: 'kimi',
    name: 'Kimi Code',
    installUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
    loginCommand: 'kimi login',
  },
  doubao: {
    provider: 'doubao',
    name: 'Doubao Agent',
    installUrl: 'https://github.com/Fullstop000/doubao-cli',
    loginCommand: 'doubao headless login',
  },
};
