/**
 * AgentGatewayGuard —— 服务间（service-to-service）鉴权，供 Python 分析 agent 调用。
 *
 * 职责边界：只服务于 `/openapi/agent-gateway/*` 路由的机器身份认证；
 * 与浏览器侧的人工会话鉴权（bearer JWT，见 AuthGlobalGuard）完全独立、互不通配。
 * 浏览器侧 API 用 bearer JWT 认证人类会话；可选的 Python agent 从另一个进程
 * 调用后端，用 `x-agent-token` 请求头里的共享密钥证明自己的身份。
 *
 * 上下游：import timingSafeEqual（node:crypto）；被 agent-gateway 控制器
 * 以 @UseGuards 方式使用；通过后把 AgentContext 挂到 req.agentContext。
 *
 * 配置（环境变量）：
 *  - AGENT_GATEWAY_ENABLED         必须严格等于 "true" 才启用网关；
 *  - AGENT_GATEWAY_TOKEN           共享密钥，与 x-agent-token 比较；
 *  - AGENT_GATEWAY_DEFAULT_USER_ID 未发送 x-agent-user-id 时使用的默认属主；
 *  - AGENT_GATEWAY_ALLOWED_USER_IDS 可选的逗号分隔白名单；设置后显式发送的
 *                                    x-agent-user-id 必须命中白名单。
 *
 * 安全性质：
 *  - 关闭或未配置 -> 404（整个入口表现得像不存在，而不是暴露一个 403 端点）；
 *  - 缺失/错误的 token -> 401；
 *  - 认证通过但请求的身份不在白名单 -> 403；
 *  - token 用常数时间比较，避免计时侧信道；
 *  - 代理身份（acting user）始终由服务端解析：调用方不能假定任意未在
 *    白名单/默认配置内的身份。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** 通过 agent gateway guard 后附加到请求上的身份。 */
export interface AgentContext {
  /** 服务代为操作的属主 id。 */
  userId: string;
  /** 认证完成的 ISO 时间戳（便于审计日志）。 */
  authenticatedAt: string;
}

/** 附加了已解析服务身份的 Express request。 */
export interface AgentGatewayRequest extends Request {
  agentContext?: AgentContext;
}

/** 常数时间字符串比较，长度不一致时也不抛异常。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // 长度不同时仍对同长度的 dummy buffer 做一次比较，避免通过耗时差异泄露
    // 长度信息；无论结果如何都返回 false。
    const dummy = Buffer.alloc(ab.length, 0);
    timingSafeEqual(ab, dummy);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** 解析可选的逗号分隔用户白名单：trim 并去重。 */
function parseAllowedUserIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/**
 * 认证携带共享 `x-agent-token` 的请求，并解析 agent 被允许代理的属主。
 * 只能应用在 `/openapi/agent-gateway/*` 控制器上。
 */
@Injectable()
export class AgentGatewayGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AgentGatewayRequest>();

    // 第 1 步：开关检查。网关关闭（AGENT_GATEWAY_ENABLED !== 'true'）或未配置
    // 密钥时，直接 404，把整个入口隐藏掉。
    const enabled = process.env.AGENT_GATEWAY_ENABLED === 'true';
    const configuredToken = process.env.AGENT_GATEWAY_TOKEN;
    if (!enabled || !configuredToken) {
      // 网关关闭时把入口完全隐藏。
      throw new NotFoundException('Not Found');
    }

    // 第 2 步：token 校验。先查存在性与类型，再做常数时间比较；两种失败都
    // 返回 401，但不区分"缺失"与"错误"以外的额外信息。
    const providedToken = req.headers['x-agent-token'];
    if (typeof providedToken !== 'string' || !providedToken) {
      throw new UnauthorizedException('missing agent token');
    }
    if (!safeEqual(providedToken, configuredToken)) {
      throw new UnauthorizedException('invalid agent token');
    }

    // 第 3 步：解析代理身份（默认拒绝策略）。可信身份集合 = 显式白名单
    // （若配置），否则仅为单个默认用户。即使 token 有效，调用方也不能假定
    // 任何未显式可信的身份。
    const defaultUserId = process.env.AGENT_GATEWAY_DEFAULT_USER_ID;
    const whitelist = parseAllowedUserIds(process.env.AGENT_GATEWAY_ALLOWED_USER_IDS);
    const trustedUsers = whitelist.length > 0 ? whitelist : defaultUserId ? [defaultUserId] : [];
    const headerUserId = req.headers['x-agent-user-id'];
    let userId: string;
    if (typeof headerUserId === 'string' && headerUserId.trim()) {
      // 请求显式指定了身份：必须在可信集合内，否则 403。
      const candidate = headerUserId.trim();
      if (!trustedUsers.includes(candidate)) {
        throw new ForbiddenException('agent user not allowed');
      }
      userId = candidate;
    } else {
      // 请求未指定身份：回退到默认属主；连默认属主都未配置则 401。
      if (!defaultUserId) {
        throw new UnauthorizedException('no agent user configured');
      }
      userId = defaultUserId;
    }

    // 第 4 步：认证通过，把身份上下文挂到 request 上供控制器使用。
    req.agentContext = {
      userId,
      authenticatedAt: new Date().toISOString(),
    };
    return true;
  }
}
