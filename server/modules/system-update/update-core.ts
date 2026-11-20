/**
 * Update core（更新核心判断）。
 *
 * 职责边界：解析 GitHub release 元数据并判断"是否存在可升级的新版本"。
 * 只做纯判断（无 IO）：tag 语义化版本比较、draft/prerelease 过滤、以及
 * release URL 必须指向本项目 releases 域名的强校验（防止伪造的
 * html_url 把用户引到钓鱼页面）。下载/安装/回滚不在本文件。
 *
 * 上下游：无 import（纯函数模块）；导出 parseLatestRelease，由
 * system-update 模块的 service/controller 调用（传入 GitHub API 返回的
 * release 对象与当前版本号）。
 *
 * 关键约定：tag 格式 ^v?(\d+)\.(\d+)\.(\d+)$（可带 v 前缀的三段数字）；
 * 下一个版本必须严格大于当前（逐段比较，相等或更低都返回 null）；
 * html_url 必须精确等于 https://github.com/Lueyu/squabble/releases/tag/<tag>
 * ——不相等视为数据被篡改并抛错；返回的 version 已剥掉 v 前缀。
 */

/** 解析 'v1.2.3' / '1.2.3' 形态的三段版本号为数字数组；不合形态返回 null。 */
function versionParts(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

/**
 * 判断给定 release 是否是可安装的新版本。
 *
 * 返回 null 表示"无更新"（版本不新、draft/prerelease、版本号无法解析）；
 * 抛错表示"输入数据不可信"（非对象/缺 tag_name/html_url 与 GitHub 域名
 * 不符）——调用方应把抛错与 null 区别对待。
 */
export function parseLatestRelease(
  release: unknown,
  currentVersion: string,
): { version: string; releaseUrl: string } | null {
  // 第一步：结构校验——release 必须是对象且带字符串 tag_name。
  if (!release || typeof release !== 'object') throw new Error('Invalid GitHub release');
  const value = release as Record<string, unknown>;
  if (typeof value.tag_name !== 'string') throw new Error('Invalid GitHub release tag');
  // 第二步：版本比较——逐段比较 next 与 current；任一段更低即无更新；
  // 三段全部相等（index===2 时仍未 break）也无更新；某段更高则跳出。
  const next = versionParts(value.tag_name);
  const current = versionParts(currentVersion);
  if (!next || !current || value.draft || value.prerelease) return null;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] < current[index]) return null;
    if (next[index] > current[index]) break;
    if (index === 2) return null;
  }
  // 第三步：URL 防伪——只接受指向本项目 releases 的精确地址。
  const expected = `https://github.com/Lueyu/squabble/releases/tag/${value.tag_name}`;
  if (value.html_url !== expected) throw new Error('Invalid GitHub release URL');
  return { version: value.tag_name.replace(/^v/u, ''), releaseUrl: expected };
}
