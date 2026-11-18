import type { OnboardingStep } from './onboarding-state';

const steps = [
  { id: 'holdings', zh: '导入持仓', en: 'Import holdings' },
  { id: 'connection', zh: '连接服务', en: 'Connect AI' },
  { id: 'team', zh: '启动团队', en: 'Start a team' },
] as const;

export function OnboardingStepper({ step, zh }: { step: OnboardingStep; zh: boolean }) {
  const active = steps.findIndex(item => item.id === step);
  return <ol className="grid grid-cols-3 gap-2 text-xs sm:text-sm" aria-label={zh ? '开始使用的进度' : 'Setup progress'}>
    {steps.map((item, index) => <li
      key={item.id}
      aria-current={index === active ? 'step' : undefined}
      className={`min-w-0 border-t-[3px] pt-2 ${index <= active ? 'border-primary' : 'border-border'} ${index === active ? 'font-semibold text-primary' : 'text-muted-foreground'}`}
    >
      <span aria-hidden="true" className="mr-1.5">{index + 1}</span>{zh ? item.zh : item.en}
    </li>)}
  </ol>;
}
