export interface OnboardingFacts { hasHoldings: boolean; hasFriends: boolean; hasRunningTeam: boolean }
export function onboardingSteps(facts: OnboardingFacts) {
  return [
    { id: 'holdings', complete: facts.hasHoldings, path: '/import', label: '导入持仓', labelEn: 'Import holdings' },
    { id: 'friends', complete: facts.hasFriends, path: '/friends', label: '认识并添加股友', labelEn: 'Meet your agents' },
    { id: 'team', complete: facts.hasRunningTeam, path: '/teams?guided=1', label: '创建自己的团队', labelEn: 'Create your team' },
  ];
}
