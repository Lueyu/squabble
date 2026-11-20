/**
 * update-check.mts — 手动更新检查：查询 GitHub 最新 release 并严格校验其地址可信。
 *
 * 职责边界：
 *  - isNewerVersion 做三段语义化版本比较；checkForUpdate 调 GitHub Releases API，
 *    解析 tag/正文/资产，并返回一个经 URL 白名单校验的下载地址。
 * 上下游：
 *  - 上游（谁调用）：desktop/main.mts 在不支持自动更新的平台或非打包环境下走本文件；
 *    desktop/update-check.spec.ts 直接测试。
 *  - 下游：返回的 downloadUrl 交给 main.mts 用 shell.openExternal 打开浏览器。
 * 关键约定：
 *  - 只信任 https://github.com 且路径精确匹配 Lueyu/squabble 的 release 页与安装包资产，
 *    带 username/password/query/hash 的地址一律判无效。
 */
const RELEASE_API = 'https://api.github.com/repos/Lueyu/squabble/releases/latest';

export interface AvailableUpdate {
  version: string;
  notes: string;
  downloadUrl: string;
}

function versionParts(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

function trustedUrl(value: unknown, expectedPath: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === expectedPath
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string,
  request: typeof fetch = fetch,
): Promise<AvailableUpdate | null> {
  const response = await request(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Squabble/${currentVersion}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('Invalid GitHub release response');
  const release = value as Record<string, unknown>;
  if (typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
    throw new Error('Invalid GitHub release response');
  }
  if (release.draft || release.prerelease || !isNewerVersion(release.tag_name, currentVersion))
    return null;
  const releaseUrl = trustedUrl(
    release.html_url,
    `/Lueyu/squabble/releases/tag/${release.tag_name}`,
  );
  if (!releaseUrl) throw new Error('Invalid GitHub release URL');
  const version = release.tag_name.replace(/^v/u, '');
  const filename =
    platform === 'win32' && arch === 'x64'
      ? `Squabble-${version}-win-x64-Setup.exe`
      : platform === 'darwin' && (arch === 'x64' || arch === 'arm64')
        ? `Squabble-${version}-mac-${arch}.dmg`
        : null;
  const asset = filename
    ? (release.assets.find(
        (item: unknown) =>
          item && typeof item === 'object' && (item as Record<string, unknown>).name === filename,
      ) as Record<string, unknown> | undefined)
    : undefined;
  const assetUrl = filename
    ? trustedUrl(
        asset?.browser_download_url,
        `/Lueyu/squabble/releases/download/${release.tag_name}/${filename}`,
      )
    : null;
  return {
    version,
    notes: typeof release.body === 'string' ? release.body.slice(0, 2_000) : '',
    downloadUrl: assetUrl ?? releaseUrl,
  };
}
