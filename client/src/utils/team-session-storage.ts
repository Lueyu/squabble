/** Clear private setup inputs and receipts on sign-out. */
export function clearTeamDraftStorage(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (
      key === 'squabble.team-create' ||
      key === 'squabble.team-quick-start' ||
      key === 'squabble.team-guided-create' ||
      key?.startsWith('squabble.team-guided-create.') ||
      key?.startsWith('squabble.team-draft.') ||
      key?.startsWith('squabble.recovery.')
    ) {
      storage.removeItem(key);
    }
  }
}
