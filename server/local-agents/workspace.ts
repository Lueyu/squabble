import { mkdir, mkdtemp, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Each invocation owns only the directory it creates, never an existing user workspace. */
export async function createNativeWorkspace(root: string): Promise<{ cwd: string; dispose: () => Promise<void> }> {
  const absolute: string = resolve(root);
  let existed: boolean = true;
  try { await stat(absolute); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('NATIVE_AGENT_WORKSPACE_FAILED');
    existed = false;
  }
  let parent: string;
  let cwd: string;
  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    parent = await realpath(absolute);
    cwd = await mkdtemp(join(parent, 'research-'));
  } catch { throw new Error('NATIVE_AGENT_WORKSPACE_FAILED'); }
  return { cwd, dispose: async (): Promise<void> => {
    if (dirname(cwd) !== parent) throw new Error('NATIVE_AGENT_CLEANUP_FAILED');
    try {
      await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (!existed) {
        // rmdir only removes an empty task root: another owner adding files is preserved.
        try { await rmdir(parent); }
        catch (error: unknown) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
    } catch { throw new Error('NATIVE_AGENT_CLEANUP_FAILED'); }
  } };
}
