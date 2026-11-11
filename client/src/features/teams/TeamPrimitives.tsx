import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function TeamSelect({ label, value, onChange, options, disabled = false }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string; disabled?: boolean }[]; disabled?: boolean }) {
  return <label className="team-field"><span>{label}</span><Select value={value || '__none'} onValueChange={v => onChange(v === '__none' ? '' : v)} disabled={disabled}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value || '__none'} value={option.value || '__none'} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent></Select></label>;
}
export function TeamNotice({ children, error = false }: { children: ReactNode; error?: boolean }) { return <div className={`team-notice${error ? ' team-notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>; }
export function TeamLoadError({ retry, zh, message }: { retry: () => void; zh: boolean; message?: string }) { return <TeamNotice error><p>{message || (zh ? '读取失败，未使用其他团队的数据。' : 'Loading failed. No other team data is substituted.')}</p><Button variant="outline" onClick={retry}>{zh ? '重试读取' : 'Retry reading'}</Button></TeamNotice>; }
export function TeamKeyValue({ label, children }: { label: string; children: ReactNode }) { return <div className="team-key-value"><span>{label}</span><strong>{children}</strong></div>; }
export function TeamResultDetails({ result, zh }: { result: unknown; zh: boolean }) {
  return <details className="team-result-details"><summary>{zh ? '查看服务器完整检查与影响' : 'Full server checks and impact'}</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>;
}
