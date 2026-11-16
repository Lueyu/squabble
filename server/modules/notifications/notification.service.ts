/**
 * Notification service（自托管推送通知服务）。
 *
 * 职责边界：五种通知渠道（全部可选，全部由用户在自己数据库里配置，见
 * docs/privacy.md——下列机密永不离开本部署）：
 *  - webhook:   通用 JSON POST（覆盖 Twilio 等短信网关）
 *  - bark:      经 bark.day.app 的 iOS 推送
 *  - serverchan: 经 sctapi.ftqq.com 的微信生态推送
 *  - smtp:      用户自配 SMTP 的邮件（nodemailer）
 *  - telegram:  经 api.telegram.org 的 bot 消息
 * 派发为 fire-and-forget：渠道失败仅记日志、绝不抛出——通知绝不能阻塞
 * 交易或 API。
 *
 * 上下游：import HttpService（@nestjs/axios）、DRIZZLE_DATABASE
 * （common/platform 注入）、notificationChannels 表（database/schema，
 * config 为 jsonb 存渠道机密）、nodemailer、@shared/api.interface 类型；
 * 由 notification.controller.ts 调用；notifyUser 被 paper-trading 引擎
 * （经 NotificationModule 导出）扇出事件。
 *
 * 关键约定：出站 HTTP 统一超时 HTTP_TIMEOUT_MS=10s；每次派发即时新建
 * SMTP transporter（用完即弃，不缓存连接）；enable 过滤只在
 * notifyUser 生效，sendTest 对停用渠道也照发（便于测试）。
 */
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import * as nodemailer from 'nodemailer';
import { firstValueFrom } from 'rxjs';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { notificationChannels } from '../../database/schema';
import type { NotificationChannel, NotificationChannelType } from '@shared/api.interface';

/** 待投递的一条通知。 */
export interface NotificationPayload {
  /** 机器可读的事件类型，如 'order_filled'。 */
  event: string;
  /** 简短标题。 */
  title: string;
  /** 正文（纯文本）。 */
  body: string;
}

/** 每次出站 HTTP 调用的超时（毫秒）。 */
const HTTP_TIMEOUT_MS = 10_000;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly httpService: HttpService,
  ) {}

  /** 列出调用者的渠道。 */
  async listChannels(userId: string): Promise<NotificationChannel[]> {
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.owner, userId));
    return rows.map((r) => this.mapChannel(r));
  }

  /** 新建一个渠道。 */
  async createChannel(
    userId: string,
    input: {
      channelType: NotificationChannelType;
      label?: string;
      config: Record<string, string>;
      enabled?: boolean;
    },
  ): Promise<NotificationChannel> {
    const [row] = await this.db
      .insert(notificationChannels)
      .values({
        owner: userId,
        channelType: input.channelType,
        label: input.label ?? null,
        config: input.config,
        enabled: input.enabled ?? true,
      })
      .returning();
    return this.mapChannel(row);
  }

  /** 按 id 删除渠道（owner 限定）。 */
  async deleteChannel(userId: string, id: string): Promise<void> {
    await this.db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.owner, userId), eq(notificationChannels.id, id)));
  }

  /** 切换渠道启停（owner 限定）。 */
  async setEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
    await this.db
      .update(notificationChannels)
      .set({ enabled, updatedAt: new Date() })
      .where(and(eq(notificationChannels.owner, userId), eq(notificationChannels.id, id)));
  }

  /** 通过一个渠道发送测试消息（owner 限定）。 */
  async sendTest(userId: string, id: string): Promise<{ ok: boolean; error?: string }> {
    // 先按 (owner,id) 精确取行；不存在直接返回失败（不抛 404）。
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.owner, userId), eq(notificationChannels.id, id)));
    const row = rows[0];
    if (!row) return { ok: false, error: '渠道不存在' };
    // 投递失败不抛出——把错误作为返回值交给前端展示。
    try {
      await this.deliver(
        row.channelType as NotificationChannelType,
        (row.config as Record<string, unknown>) ?? {},
        {
          event: 'test',
          title: '吵股测试通知',
          body: '如果你看到这条消息，说明该通知渠道配置正确。',
        },
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 把一条通知扇出到该用户的全部启用渠道。绝不抛出。 */
  async notifyUser(userId: string, payload: NotificationPayload): Promise<void> {
    // 整个方法包一层 try：渠道或查询出任何错都只降级为日志，不影响主流程。
    try {
      const rows = await this.db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.owner, userId));
      const enabled = rows.filter((r) => r.enabled);
      if (enabled.length === 0) return;
      // 并发扇出；Promise.allSettled 吞掉个别渠道的失败。
      await Promise.allSettled(
        enabled.map((r) =>
          this.deliver(
            r.channelType as NotificationChannelType,
            (r.config as Record<string, unknown>) ?? {},
            payload,
          ),
        ),
      );
    } catch (error) {
      this.logger.warn(`notifyUser fan-out failed (non-fatal): ${String(error)}`);
    }
  }

  /** 经单一渠道投递；失败时抛出（由调用方决定如何处理）。 */
  private async deliver(
    channelType: NotificationChannelType,
    config: Record<string, unknown>,
    payload: NotificationPayload,
  ): Promise<void> {
    switch (channelType) {
      case 'webhook':
        return this.deliverWebhook(config, payload);
      case 'bark':
        return this.deliverBark(config, payload);
      case 'serverchan':
        return this.deliverServerChan(config, payload);
      case 'smtp':
        return this.deliverSmtp(config, payload);
      case 'telegram':
        return this.deliverTelegram(config, payload);
      default:
        throw new Error(`未知通知渠道: ${String(channelType)}`);
    }
  }

  /** 通用 JSON POST webhook。 */
  private async deliverWebhook(
    config: Record<string, unknown>,
    payload: NotificationPayload,
  ): Promise<void> {
    const url = String(config.url ?? '');
    if (!url) throw new Error('webhook 缺少 url');
    await firstValueFrom(this.httpService.post(url, payload, { timeout: HTTP_TIMEOUT_MS }));
  }

  /** Bark（iOS 推送）。 */
  private async deliverBark(
    config: Record<string, unknown>,
    payload: NotificationPayload,
  ): Promise<void> {
    const key = String(config.key ?? '');
    if (!key) throw new Error('bark 缺少 key');
    // 允许自建 bark 服务端；默认官方 api.day.app，去掉尾部斜杠防止出现 //。
    const base = String(config.server ?? 'https://api.day.app').replace(/\/+$/, '');
    await firstValueFrom(
      this.httpService.post(
        `${base}/${key}`,
        { title: payload.title, body: payload.body, group: 'squabble' },
        {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          timeout: HTTP_TIMEOUT_MS,
        },
      ),
    );
  }

  /** ServerChan（微信生态）。 */
  private async deliverServerChan(
    config: Record<string, unknown>,
    payload: NotificationPayload,
  ): Promise<void> {
    const key = String(config.key ?? '');
    if (!key) throw new Error('serverchan 缺少 sendkey');
    const base = String(config.server ?? 'https://sctapi.ftqq.com').replace(/\/+$/, '');
    // ServerChan 是表单协议：title 为标题，desp 为正文。
    const body = new URLSearchParams({ title: payload.title, desp: payload.body });
    await firstValueFrom(
      this.httpService.post(`${base}/${key}.send`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: HTTP_TIMEOUT_MS,
      }),
    );
  }

  /** 经 nodemailer 的 SMTP 邮件。 */
  private async deliverSmtp(
    config: Record<string, unknown>,
    payload: NotificationPayload,
  ): Promise<void> {
    const host = String(config.host ?? '');
    const to = String(config.to ?? '');
    if (!host || !to) throw new Error('smtp 缺少 host 或 to');
    // 端口 465 视为隐式 TLS（secure=true）；其余端口走 STARTTLS 协商。
    const port = Number(config.port ?? 465);
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: config.user
        ? { user: String(config.user), pass: String(config.pass ?? '') }
        : undefined,
    });
    await transporter.sendMail({
      from: String(config.from ?? config.user ?? 'squabble@localhost'),
      to,
      subject: payload.title,
      text: payload.body,
    });
  }

  /** Telegram bot 消息。 */
  private async deliverTelegram(
    config: Record<string, unknown>,
    payload: NotificationPayload,
  ): Promise<void> {
    const token = String(config.token ?? '');
    const chatId = String(config.chatId ?? '');
    if (!token || !chatId) throw new Error('telegram 缺少 token 或 chatId');
    // bot API 走表单编码；正文首行拼应用名前缀。
    const body = new URLSearchParams({
      chat_id: chatId,
      text: `吵股 | ${payload.title}\n${payload.body}`,
    });
    await firstValueFrom(
      this.httpService.post(`https://api.telegram.org/bot${token}/sendMessage`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: HTTP_TIMEOUT_MS,
      }),
    );
  }

  /** 把 DB 行映射为 API 形状（jsonb -> Record<string,string>）。 */
  private mapChannel(row: {
    id: string;
    channelType: string;
    label: string | null;
    config: unknown;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): NotificationChannel {
    return {
      id: row.id,
      channelType: row.channelType as NotificationChannelType,
      label: row.label,
      config: (row.config as Record<string, string>) ?? {},
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
