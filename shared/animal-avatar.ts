/** Stable appearance IDs shared by agents and frozen conversation snapshots. */
export const ANIMAL_AVATAR_IDS = ['value', 'growth', 'risk', 'technical', 'news', 'macro', 'moderator'] as const;
export type AnimalAvatarId = typeof ANIMAL_AVATAR_IDS[number];

export const ANIMAL_AVATAR_LABELS: Record<AnimalAvatarId, { zh: string; en: string }> = {
  value: { zh: '小牛', en: 'Bull' },
  growth: { zh: '兔子', en: 'Rabbit' },
  risk: { zh: '小熊', en: 'Bear' },
  technical: { zh: '猫咪', en: 'Cat' },
  news: { zh: '狐狸', en: 'Fox' },
  macro: { zh: '鲸鱼', en: 'Whale' },
  moderator: { zh: '猫头鹰', en: 'Owl' },
};
