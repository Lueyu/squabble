/**
 * System update service（系统更新服务）。
 *
 * 职责边界：Docker 部署下的 Web 自更新编排——查询 GitHub 最新 release
 * （1 分钟缓存）、校验仅安装属主可操作、启动前先做数据库+密钥备份
 * （createUpdateBackup），备份成功后延迟 500ms 通知 updater 容器执行
 * 实际的镜像替换。本进程在替换过程中通常会被杀死；若进程还活着，
 * 说明替换没有发生（按失败收尾）。非 docker 模式（SQUABBLE_UPDATE_MODE
 * != 'docker'）下整体功能关闭。
 *
 * 上下游：import node:child_process/fs/path、@nestjs/common、DRIZZLE_
 * DATABASE（common/platform）、users（database/schema）、createUpdateBackup
 * （./backup）、parseLatestRelease（./update-core）；由
 * system-update.controller.ts 调用。
 *
 * 关键约定：phase 状态机 idle→backingUp→updating（或 failed），进程内
 * 单例，backingUp/updating 期间拒绝并发 start（409）；GitHub 查询
 * RELEASE_API 带版本化 User-Agent，10s 超时，结果缓存 60s；pg_dump
 * --format=custom 120s 超时、PGCONNECT_TIMEOUT=10s；updater 触发走
 * 内网 http://updater:8080/v1/update（Bearer /app/.secrets/update-token），
 * 10 分钟超时——正常情况下该调用期间本进程已被替换消失。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { users } from '../../database/schema';
import { createUpdateBackup } from './backup';
import { parseLatestRelease } from './update-core';

type UpdatePhase = 'idle' | 'backingUp' | 'updating' | 'failed';

/** 对前端暴露的更新状态视图。 */
export interface WebUpdateStatus {
  enabled: boolean;
  currentVersion: string;
  available: { version: string; releaseUrl: string } | null;
  phase: UpdatePhase;
  error?: string;
}

/** GitHub Releases 最新版查询端点（本项目仓库）。 */
const RELEASE_API = 'https://api.github.com/repos/Lueyu/squabble/releases/latest';
/** 当前应用版本：启动时从 package.json 读取一次（模块加载期）。 */
const APP_VERSION = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * 数据库备份回调：起一个 pg_dump 子进程写 custom 格式转储。
 * 连接串来自 DATABASE_URL；120 秒未结束则杀掉并按失败处理。
 */
function dumpDatabase(destination: string): Promise<void> {
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error('DATABASE_URL is required for the update backup');
  return new Promise((done, fail) => {
    const child = spawn(
      'pg_dump',
      ['--format=custom', '--file', destination, '--dbname', connection],
      {
        stdio: 'ignore',
        // 限制 pg_dump 的连接等待时间（避免卡死备份窗口）。
        env: { ...process.env, PGCONNECT_TIMEOUT: '10' },
      },
    );
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) done();
      else fail(new Error(`pg_dump exited with code ${code}`));
    });
  });
}

@Injectable()
export class SystemUpdateService {
  private readonly logger = new Logger(SystemUpdateService.name);
  /** 更新阶段（进程内状态；重启后回到 idle）。 */
  private phase: UpdatePhase = 'idle';
  private error: string | undefined;
  /** release 查询缓存（until 为过期时刻毫秒值）。 */
  private releaseCache: { until: number; value: WebUpdateStatus['available'] } | null = null;

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 仅 docker 部署模式启用 Web 更新。 */
  private get enabled(): boolean {
    return process.env.SQUABBLE_UPDATE_MODE === 'docker';
  }

  /**
   * 仅安装属主（users 表按创建时间最早的那个账号）可执行更新操作。
   * 其他登录用户一律 403。
   */
  private async requireOwner(userId: string): Promise<void> {
    const [owner] = await this.db
      .select({ id: users.id })
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1);
    if (!owner || owner.id !== userId)
      throw new ForbiddenException('Only the installation owner can update Squabble');
  }

  /**
   * 查询可用新版本（60 秒缓存）。GitHub 不可达抛错；无新版本返回 null
   * （parseLatestRelease 已完成 draft/prerelease/URL 防伪过滤）。
   */
  private async availableRelease(): Promise<WebUpdateStatus['available']> {
    if (this.releaseCache && Date.now() < this.releaseCache.until) return this.releaseCache.value;
    const response = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Squabble/${APP_VERSION}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const value = parseLatestRelease(await response.json(), APP_VERSION);
    this.releaseCache = { until: Date.now() + 60_000, value };
    return value;
  }

  /** 状态查询：非 docker 模式直接报未启用；GitHub 不可达时降级为 error 文案。 */
  async status(userId: string): Promise<WebUpdateStatus> {
    if (!this.enabled)
      return { enabled: false, currentVersion: APP_VERSION, available: null, phase: 'idle' };
    await this.requireOwner(userId);
    try {
      return {
        enabled: true,
        currentVersion: APP_VERSION,
        available: await this.availableRelease(),
        phase: this.phase,
        ...(this.error ? { error: this.error } : {}),
      };
    } catch {
      return {
        enabled: true,
        currentVersion: APP_VERSION,
        available: null,
        phase: this.phase,
        error: this.error ?? 'Could not reach GitHub Releases',
      };
    }
  }

  /**
   * 启动更新：mode/属主/并发三道闸 → 确认有新版本 → 备份（失败则状态
   * 置 failed 并 503，绝不无备份更新）→ 备份成功后延迟 500ms 触发
   * updater，并立即返回备份路径（响应先于替换进程杀掉本进程）。
   */
  async start(userId: string): Promise<{ started: true; backup: string }> {
    // 第一道闸：非 docker 部署禁止 Web 更新。
    if (!this.enabled)
      throw new ForbiddenException('Web updates are unavailable in this deployment');
    // 第二道闸：仅安装属主。
    await this.requireOwner(userId);
    // 第三道闸：已有更新在跑（backingUp/updating）时拒绝并发启动。
    if (this.phase === 'backingUp' || this.phase === 'updating')
      throw new ConflictException('An update is already running');
    // 确认确实存在新版本（GitHub 不可达视为服务暂不可用）。
    const release = await this.availableRelease().catch(() => {
      throw new ServiceUnavailableException('Could not check GitHub Releases');
    });
    if (!release) throw new ConflictException('Squabble is already up to date');
    // 备份阶段：数据库转储 + 密钥复制；任何失败都中止更新。
    this.phase = 'backingUp';
    this.error = undefined;
    try {
      const backup = await createUpdateBackup(
        process.env.SQUABBLE_UPDATE_BACKUP_DIR ?? '/app/.backups',
        '/app/.secrets',
        dumpDatabase,
      );
      // 更新阶段：延迟 500ms 触发 updater（给响应留出发送窗口），
      // unref 保证该定时器不阻止进程退出。
      this.phase = 'updating';
      setTimeout(() => {
        void this.triggerHelper();
      }, 500).unref();
      return { started: true, backup };
    } catch (error) {
      // 失败路径：备份失败 = 更新未开始，状态落 failed 并保留错误文案。
      this.logger.error(
        `Update backup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.phase = 'failed';
      this.error = 'Database backup failed; the update was not started';
      throw new ServiceUnavailableException(this.error);
    }
  }

  /**
   * 通知 updater 容器执行镜像替换（Bearer token 来自 /app/.secrets/
   * update-token）。正常情况下本进程在替换中被杀死、请求不了了之；
   * 若 fetch 正常返回或抛错，都说明替换没有发生——按失败收尾并记录
   * 指向 updater 容器日志的错误文案。
   */
  private async triggerHelper(): Promise<void> {
    try {
      const token = readFileSync('/app/.secrets/update-token', 'utf8').trim();
      const response = await fetch('http://updater:8080/v1/update', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!response.ok) throw new Error(`Update helper returned HTTP ${response.status}`);
      // If this process survives the scan, no replacement happened.
      // （如果本进程在扫描后还活着，说明没有新镜像被安装。）
      this.phase = 'failed';
      this.error = 'No new image was installed; see the updater container logs';
    } catch (error) {
      this.logger.error(
        `Update helper failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.phase = 'failed';
      this.error = 'Update failed; see the updater container logs';
    }
  }
}
