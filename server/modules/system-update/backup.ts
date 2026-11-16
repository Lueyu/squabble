/**
 * Update backup（更新前备份）。
 *
 * 职责边界：在执行系统更新前创建一次性备份目录——先落 pg_dump 数据库
 * 转储（由调用方注入 dump 函数），再尽量复制两把密钥文件（jwt.key/
 * settings.key，缺失时容忍），全部成功后把临时目录原子 rename 为正式
 * 备份名并返回其路径。任何一步失败都会清掉半成品目录再抛错——绝不
 * 留下残缺备份供更新流程误用。
 *
 * 上下游：import node:crypto/node:fs/node:path；导出 createUpdateBackup
 * 供 update-core.ts（或更新编排层）在停服窗口内调用；dump 回调由调用
 * 方注入（通常包 pg_dump 子进程）。
 *
 * 关键约定：备份目录权限 0o700、转储/密钥文件 0o600（只允许属主读
 * 写，防其他本地用户读取机密）；目录名 = ISO 时间戳（冒号/点替换为
 * '-'）+ randomUUID，保证唯一且可排序；两段式 .pending- 前缀目录 +
 * rename 是"要么完整要么不存在"的原子发布约定——恢复逻辑只认无前缀
 * 的正式目录。
 */
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 创建更新前备份，返回正式备份目录的绝对路径。
 *
 * 失败路径：dump 失败、转储为 0 字节、密钥复制出现非 ENOENT 错误——
 * 任何一种都会删除 .pending- 临时目录并原样上抛，调用方应中止更新
 * （备份失败绝不能继续执行破坏性更新）。
 */
export async function createUpdateBackup(
  backupRoot: string,
  secretsRoot: string,
  dump: (destination: string) => Promise<void>,
): Promise<string> {
  // 第一步：确保备份根目录存在（0o700，仅属主可进）。
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  // 第二步：生成唯一目录名，先在 .pending- 临时目录里组装。
  const name = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
  const pending = join(backupRoot, `.pending-${name}`);
  const complete = join(backupRoot, name);
  await mkdir(pending, { mode: 0o700 });
  try {
    // 第三步：数据库转储——落进 pending 目录并校验非空（0 字节的
    // pg_dump 通常意味着 dump 命令本身失败）。
    const databaseFile = join(pending, 'database.dump');
    await dump(databaseFile);
    if ((await stat(databaseFile)).size === 0) throw new Error('Database backup is empty');
    await chmod(databaseFile, 0o600);
    // 第四步：复制两把密钥文件；ENOENT（文件不存在）容忍——跳过即
    // 可，其他错误（权限/磁盘）照样失败。
    for (const filename of ['jwt.key', 'settings.key']) {
      try {
        const target = join(pending, filename);
        await copyFile(join(secretsRoot, filename), target);
        await chmod(target, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    // 第五步：同盘 rename 原子发布——从此目录被视为"完整备份"。
    await rename(pending, complete);
    return complete;
  } catch (error) {
    // 失败回滚：删除半成品临时目录，不留残缺备份。
    await rm(pending, { recursive: true, force: true });
    throw error;
  }
}
