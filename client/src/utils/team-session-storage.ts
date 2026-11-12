/** Clear only private team inputs, preserving independent workspace preferences. */
export function clearTeamDraftStorage(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (
      key === 'squabble.team-create' ||
      key === 'squabble.team-quick-start' ||
      key === 'squabble.team-guided-create' ||
      key?.startsWith('squabble.team-guided-create.') ||
      key?.startsWith('squabble.team-draft.')
    ) {
      storage.removeItem(key);
    }
  }
}
