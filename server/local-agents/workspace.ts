/**
 * local-agents 工作区隔离：为一次 native agent 调用创建专属临时目录。
 *
 * 职责边界：只管"创建可清理的一次性 cwd"（mkdir + mkdtemp + dispose 时
 * 递归删除）；不做任何文件内容操作，也不决定目录根（由调用方传入）。
 *
 * 上下游：import node:fs/promises、node:path；被 native.ts / research.ts
 * 等启动子进程的模块调用。
 *
 * 关键约定：每次调用只拥有自己新建的目录（research-* 前缀的 mkdtemp），
 * 绝不占用/清空用户既有工作区；目录权限 mode 0o700；若根目录是本次调用
 * 新建的，dispose 时还会尝试 rmdir 掉空的根目录（非空或已存在则保留）。
 */
import { mkdir, mkdtemp, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** 每次调用只拥有自己创建的目录，绝不复用用户的既有工作区。 */
export async function createNativeWorkspace(
  root: string,
): Promise<{ cwd: string; dispose: () => Promise<void> }> {
  const absolute: string = resolve(root);
  let existed: boolean = true;
  try {
    await stat(absolute);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('NATIVE_AGENT_WORKSPACE_FAILED');
    existed = false;
  }
  let parent: string;
  let cwd: string;
  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    parent = await realpath(absolute);
    cwd = await mkdtemp(join(parent, 'research-'));
  } catch {
    throw new Error('NATIVE_AGENT_WORKSPACE_FAILED');
  }
  return {
    cwd,
    dispose: async (): Promise<void> => {
      if (dirname(cwd) !== parent) throw new Error('NATIVE_AGENT_CLEANUP_FAILED');
      try {
        await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (!existed) {
          // rmdir 只删除空的任务根目录：别的属主在里面放了文件就原样保留。
          try {
            await rmdir(parent);
          } catch (error: unknown) {
            if (
              !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            )
              throw error;
          }
        }
      } catch {
        throw new Error('NATIVE_AGENT_CLEANUP_FAILED');
      }
    },
  };
}
