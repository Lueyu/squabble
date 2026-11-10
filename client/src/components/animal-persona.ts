import type { CouncilMember, CouncilMessage } from '@shared/council.interface';

export function councilPersona(avatar: CouncilMember['avatar'], role: CouncilMessage['role']) {
  if (role === 'user') return 'user';
  return avatar ?? (role === 'manager' ? 'moderator' : role === 'challenger' ? 'risk' : 'value');
}
