import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { TelemetryFeedback as Feedback } from '@shared/telemetry.interface';
import { TelemetryPanel } from './TelemetryPrimitives';
import { useTelemetryFeedback } from './use-telemetry';

export default function TelemetryFeedback({ id, feedback }: { id: string; feedback: Feedback | null }) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const [rating, setRating] = useState<Feedback['rating'] | null>(feedback?.rating ?? null);
  const [comment, setComment] = useState<string>(feedback?.comment ?? '');
  const [saved, setSaved] = useState<boolean>(Boolean(feedback));
  const mutation = useTelemetryFeedback(id);
  const submit = async (): Promise<void> => {
    if (!rating) return;
    setSaved(false);
    try {
      await mutation.mutateAsync({ rating, comment: comment.trim() });
      setSaved(true);
    } catch {
      // Mutation state exposes a retryable inline error; unsaved text is retained.
    }
  };
  return <TelemetryPanel title={zh ? '运行反馈' : 'Run feedback'} description={zh ? '反馈单独保存，不改写交付状态或报告采纳。' : 'Feedback is stored separately from delivery acceptance and report adoption.'}>
    <form className="telemetry-feedback" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="telemetry-feedback-ratings"><Button type="button" variant={rating === 'positive' ? 'secondary' : 'outline'} aria-pressed={rating === 'positive'} disabled={mutation.isPending} onClick={() => { setRating('positive'); setSaved(false); }}><ThumbsUp size={15} />{zh ? '有帮助' : 'Helpful'}</Button>
        <Button type="button" variant={rating === 'negative' ? 'secondary' : 'outline'} aria-pressed={rating === 'negative'} disabled={mutation.isPending} onClick={() => { setRating('negative'); setSaved(false); }}><ThumbsDown size={15} />{zh ? '需要改进' : 'Needs improvement'}</Button></div>
      <label><span>{zh ? '补充说明（可选）' : 'Comment (optional)'}</span><Textarea aria-label={zh ? '反馈说明' : 'Feedback comment'} maxLength={2000} value={comment} disabled={mutation.isPending} onChange={event => { setComment(event.target.value); setSaved(false); }} placeholder={zh ? '哪些步骤有帮助，或还缺少什么？' : 'What helped, or what was missing?'} /></label>
      {mutation.isError && <p role="alert" className="telemetry-negative">{zh ? '反馈保存失败，文字已保留，请重试。' : 'Feedback could not be saved. Your text is retained; please retry.'}</p>}
      {saved && <p role="status" className="telemetry-positive">{zh ? '反馈已保存' : 'Feedback saved'}</p>}
      <Button type="submit" disabled={!rating || mutation.isPending}>{mutation.isPending ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存反馈' : 'Save feedback')}</Button>
    </form>
  </TelemetryPanel>;
}
