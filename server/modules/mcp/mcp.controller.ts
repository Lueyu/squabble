/**
 * @file server/modules/mcp/mcp.controller.ts
 * @description MCP endpoint + agent-session management API.
 *
 * The MCP endpoint (POST /mcp) accepts JSON-RPC 2.0 messages per the MCP
 * Streamable HTTP transport spec. Authentication is via the `Authorization:
 * Bearer <session-token>` header, where the token identifies an agent
 * session (see agent_sessions table).
 *
 * The agent-session CRUD lives under /api/paper/agent-sessions (in the
 * paper-trading controller) for user-facing management.
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

/** MCP protocol version we speak. */
const MCP_PROTOCOL_VERSION = '2025-03-26';

/** JSON-RPC 2.0 request shape. */
interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response shapes. */
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
  // Agent session management (user-facing, under /api/mcp/sessions)
  // ------------------------------------------------------------------

  /** List the caller's agent sessions (tokens never returned). */
  @NeedLogin()
  @Get('api/mcp/sessions')
  async listSessions(@Req() req: Request) {
    return this.mcp.listSessions(req.userContext.userId);
  }

  /** Create an agent session; returns the token once. */
  @NeedLogin()
  @Post('api/mcp/sessions')
  async createSession(@Req() req: Request, @Body() dto: CreateAgentSessionDto) {
    return this.mcp.createSession(req.userContext.userId, dto);
  }

  /** Update a session's limits/mode. */
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

  /** Revoke an agent session. */
  @NeedLogin()
  @Post('api/mcp/sessions/:id/revoke')
  async revokeSession(@Req() req: Request, @Param('id') id: string) {
    await this.mcp.revokeSession(req.userContext.userId, id);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // MCP Streamable HTTP endpoint (POST /mcp)
  // ------------------------------------------------------------------

  /**
   * MCP Streamable HTTP endpoint. One POST = one JSON-RPC message.
   * Returns a single JSON-RPC response (non-streaming, `Content-Type:
   * application/json`), which all MCP clients support.
   */
  @Post('mcp')
  async handle(@Req() req: Request, @Body() body: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { authorization } = req.headers;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const ctx = await this.mcp.authenticate(token);

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
          // Notification: no response body needed.
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
