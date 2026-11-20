/**
 * mcp.controller.ts — MCP 端点与智能体会话管理 API。
 *
 * 职责边界：
 *  - MCP 端点（POST /mcp）按 MCP Streamable HTTP 传输规范接收 JSON-RPC 2.0 消息；
 *    鉴权使用 `Authorization: Bearer <session-token>` 头，token 标识一个智能体会话（见 agent_sessions 表）。
 *  - 智能体会话 CRUD 位于 /api/mcp/sessions（面向用户管理）。
 * 上下游：
 *  - 上游：外部 MCP 客户端（协议端点）与前端会话管理页（CRUD）。
 *  - 下游：McpService。
 * 关键约定：
 *  - 协议版本 MCP_PROTOCOL_VERSION='2025-03-26'；响应为非流式单条 JSON-RPC。
 *  - JSON-RPC 错误码：-32000（一般）、-32001（未授权）、-32002（禁止）、-32601（未知方法）。
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { McpService } from './mcp.service';
import type {
  CreateAgentSessionDto,
  AgentPermission,
  AgentApprovalMode,
} from '@shared/api.interface';

/** 本服务实现的 MCP 协议版本。 */
const MCP_PROTOCOL_VERSION = '2025-03-26';

/** JSON-RPC 2.0 请求形态。 */
interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 响应形态。 */
interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

@Controller()
export class McpController {
  constructor(private readonly mcp: McpService) {}

  // ------------------------------------------------------------------
  // Agent 会话管理（面向用户，位于 /api/mcp/sessions）
  // ------------------------------------------------------------------

  /** GET /api/mcp/sessions — 列出调用者的智能体会话（token 永不返回）（登录）。 */
  @NeedLogin()
  @Get('api/mcp/sessions')
  async listSessions(@Req() req: Request) {
    return this.mcp.listSessions(req.userContext.userId);
  }

  /** POST /api/mcp/sessions — 创建智能体会话；token 仅在本次响应中返回（登录）。 */
  @NeedLogin()
  @Post('api/mcp/sessions')
  async createSession(@Req() req: Request, @Body() dto: CreateAgentSessionDto) {
    return this.mcp.createSession(req.userContext.userId, dto);
  }

  /** PUT /api/mcp/sessions/:id — 更新会话限额/模式（登录）。 */
  @NeedLogin()
  @Put('api/mcp/sessions/:id')
  async updateSession(
    @Req() req: Request,
    @Param('id') id: string,
    @Body()
    patch: {
      dailyLimitUsd?: number;
      permission?: AgentPermission;
      approvalMode?: AgentApprovalMode;
    },
  ) {
    return this.mcp.updateSession(req.userContext.userId, id, patch);
  }

  /** POST /api/mcp/sessions/:id/revoke — 撤销智能体会话（登录）。 */
  @NeedLogin()
  @Post('api/mcp/sessions/:id/revoke')
  async revokeSession(@Req() req: Request, @Param('id') id: string) {
    await this.mcp.revokeSession(req.userContext.userId, id);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // MCP Streamable HTTP 端点（POST /mcp）
  // ------------------------------------------------------------------

  /**
   * MCP Streamable HTTP 端点：一次 POST = 一条 JSON-RPC 消息。
   * 返回单条 JSON-RPC 响应（非流式，Content-Type: application/json），所有 MCP 客户端均支持。
   */
  @Post('mcp')
  async handle(@Req() req: Request, @Body() body: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { authorization } = req.headers;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const ctx = await this.mcp.authenticate(token);

    // 逐方法分发 JSON-RPC 请求；通知（notifications/initialized）也回一个空结果体。
    const id = body?.id ?? null;
    try {
      switch (body?.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'squabble', version: '2.1.0' },
            },
          };

        case 'notifications/initialized':
          // 通知类消息：不需要响应体。
          return { jsonrpc: '2.0', id: null, result: {} };

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: this.mcp.getTools() },
          };

        case 'tools/call': {
          const name = String(body?.params?.name ?? '');
          const args = (body?.params?.arguments ?? {}) as Record<string, unknown>;
          const result = await this.mcp.callTool(ctx, name, args);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            },
          };
        }

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${body?.method}` },
          };
      }
    } catch (error) {
      // 异常转 JSON-RPC 错误：未授权 -32001、禁止 -32002、其余 -32000。
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof UnauthorizedException
          ? -32001
          : error instanceof ForbiddenException
            ? -32002
            : -32000;
      return {
        jsonrpc: '2.0',
        id,
        error: { code, message },
      };
    }
  }
}
