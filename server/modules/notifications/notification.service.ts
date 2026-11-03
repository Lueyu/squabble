/**
 * @file server/modules/notifications/notification.service.ts
 * @description Self-hosted push notifications.
 *
 * Five channels, all optional, all configured by the user in their own
 * database (see docs/privacy.md — the secrets below never leave the
 * deployment):
 *  - webhook:   generic JSON POST (covers SMS gateways like Twilio)
 *  - bark:      iOS push via bark.day.app
 *  - serverchan: WeChat-ecosystem push via sctapi.ftqq.com
 *  - smtp:      email via user-configured SMTP (nodemailer)
 *  - telegram:  bot message via api.telegram.org
 *
 * Dispatch is fire-and-forget: a channel failure is logged, never thrown —
 * notifications must never block trading or the API.
 */
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import * as nodemailer from 'nodemailer';
import { firstValueFrom } from 'rxjs';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { notificationChannels } from '../../database/schema';
import type { NotificationChannel, NotificationChannelType } from '@shared/api.interface';

/** A notification to deliver. */
export interface NotificationPayload {
  /** Machine-readable event kind, e.g. 'order_filled'. */
  event: string;
  /** Short title. */
  title: string;
  /** Body text (plain). */
  body: string;
}

/** Timeout applied to every outbound HTTP call (ms). */
const HTTP_TIMEOUT_MS = 10_000;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly httpService: HttpService,
  ) {}

  /** List the caller's channels. */
  async listChannels(userId: string): Promise<NotificationChannel[]> {
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.owner, userId));
    return rows.map((r) => this.mapChannel(r));
  }

  /** Create a channel. */
  async createChannel(
    userId: string,
    input: { channelType: NotificationChannelType; label?: string; config: Record<string, string>; enabled?: boolean },
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

  /** Delete a channel by id (owner-scoped). */
  async deleteChannel(userId: string, id: string): Promise<void> {
    await this.db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.owner, userId), eq(notificationChannels.id, id)));
  }

  /** Toggle a channel (owner-scoped). */
  async setEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
    await this.db
      .update(notificationChannels)
      .set({ enabled, updatedAt: new Date() })
      .where(and(eq(notificationChannels.owner, userId), eq(notificationChannels.id, id)));
  }

  /** Send a test message through one channel (owner-scoped). */
  async sendTest(userId: string, id: string): Promise<{ ok: boolean; error?: string }> {
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.owner, userId), eq(notificationChannels.id, id)));
    const row = rows[0];
    if (!row) return { ok: false, error: '渠道不存在' };
    try {
      await this.deliver(row.channelType as NotificationChannelType, (row.config as Record<string, unknown>) ?? {}, {
        event: 'test',
        title: '吵股测试通知',
        body: '如果你看到这条消息，说明该通知渠道配置正确。',
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Fan out a notification to every enabled channel of a user. Never throws. */
  async notifyUser(userId: string, payload: NotificationPayload): Promise<void> {
    try {
      const rows = await this.db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.owner, userId));
      const enabled = rows.filter((r) => r.enabled);
      if (enabled.length === 0) return;
      await Promise.allSettled(
        enabled.map((r) =>
          this.deliver(r.channelType as NotificationChannelType, (r.config as Record<string, unknown>) ?? {}, payload),
        ),
      );
    } catch (error) {
      this.logger.warn(`notifyUser fan-out failed (non-fatal): ${String(error)}`);
    }
  }

  /** Deliver through a single channel; throws on failure (callers decide). */
  async deliverWithAcknowledgment(userId: string, payload: NotificationPayload, previous: string[] = []): Promise<{
    ok: boolean; deliveredChannelIds: string[];
  }> {
    const rows = await this.db.select().from(notificationChannels).where(and(
      eq(notificationChannels.owner, userId), eq(notificationChannels.enabled, true)));
    const delivered = new Set(previous);
    const results = await Promise.allSettled(rows.filter((row) => !delivered.has(row.id)).map(async (row) => {
      await this.deliver(row.channelType as NotificationChannelType, (row.config as Record<string, unknown>) ?? {}, payload);
      delivered.add(row.id);
    }));
    // No configured destination remains visible as undelivered and can be retried after setup.
    return { ok: rows.length > 0 && results.every((result) => result.status === 'fulfilled'),
      deliveredChannelIds: [...delivered] };
  }

  /** Deliver through a single channel; throws on failure (callers decide). */
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

  /** Generic JSON POST webhook. */
  private async deliverWebhook(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
    const url = String(config.url ?? '');
    if (!url) throw new Error('webhook 缺少 url');
    await firstValueFrom(
      this.httpService.post(url, payload, { timeout: HTTP_TIMEOUT_MS }),
    );
  }

  /** Bark (iOS push). */
  private async deliverBark(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
    const key = String(config.key ?? '');
    if (!key) throw new Error('bark 缺少 key');
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

  /** ServerChan (WeChat ecosystem). */
  private async deliverServerChan(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
    const key = String(config.key ?? '');
    if (!key) throw new Error('serverchan 缺少 sendkey');
    const base = String(config.server ?? 'https://sctapi.ftqq.com').replace(/\/+$/, '');
    const body = new URLSearchParams({ title: payload.title, desp: payload.body });
    await firstValueFrom(
      this.httpService.post(`${base}/${key}.send`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: HTTP_TIMEOUT_MS,
      }),
    );
  }

  /** SMTP email via nodemailer. */
  private async deliverSmtp(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
    const host = String(config.host ?? '');
    const to = String(config.to ?? '');
    if (!host || !to) throw new Error('smtp 缺少 host 或 to');
    const port = Number(config.port ?? 465);
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: config.user ? { user: String(config.user), pass: String(config.pass ?? '') } : undefined,
    });
    await transporter.sendMail({
      from: String(config.from ?? config.user ?? 'squabble@localhost'),
      to,
      subject: payload.title,
      text: payload.body,
    });
  }

  /** Telegram bot message. */
  private async deliverTelegram(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
    const token = String(config.token ?? '');
    const chatId = String(config.chatId ?? '');
    if (!token || !chatId) throw new Error('telegram 缺少 token 或 chatId');
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

  /** Map a DB row to the API shape (jsonb -> Record<string,string>). */
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
