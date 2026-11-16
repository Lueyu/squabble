function versionParts(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

export function parseLatestRelease(
  release: unknown,
  currentVersion: string,
): { version: string; releaseUrl: string } | null {
  if (!release || typeof release !== 'object') throw new Error('Invalid GitHub release');
  const value = release as Record<string, unknown>;
  if (typeof value.tag_name !== 'string') throw new Error('Invalid GitHub release tag');
  const next = versionParts(value.tag_name);
  const current = versionParts(currentVersion);
  if (!next || !current || value.draft || value.prerelease) return null;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] < current[index]) return null;
    if (next[index] > current[index]) break;
    if (index === 2) return null;
  }
  const expected = `https://github.com/Lueyu/squabble/releases/tag/${value.tag_name}`;
  if (value.html_url !== expected) throw new Error('Invalid GitHub release URL');
  return { version: value.tag_name.replace(/^v/u, ''), releaseUrl: expected };
}
