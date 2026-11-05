import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { shouldSendCouncilMessage } from '@/utils/council-state';

export default function QuickQuestion({ onSubmit, pending, contextLabel, onRemoveContext, replyLabel, onRemoveReply, initialText = '' }: {
  onSubmit: (message: string) => Promise<boolean>; pending: boolean; contextLabel?: string;
  onRemoveContext?: () => void; replyLabel?: string; onRemoveReply?: () => void; initialText?: string;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [text, setText] = useState(initialText); const composing = useRef(false); const submitting = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (replyLabel) input.current?.focus(); }, [replyLabel]);
  const submit = async () => {
    if (!text.trim() || pending || submitting.current) return;
    submitting.current = true;
    const submitted = text;
    try { if (await onSubmit(submitted.trim())) setText(current => current === submitted ? '' : current); }
    finally { submitting.current = false; }
  };
  return <form className="shrink-0 space-y-2 border-t bg-card p-3 sm:p-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {contextLabel && <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs"><span className="min-w-0 flex-1 break-words">{contextLabel}</span>{onRemoveContext && <button type="button" className="shrink-0 p-1" aria-label={zh ? '移除上下文' : 'Remove context'} onClick={onRemoveContext}><X size={14} /></button>}</div>}
    {replyLabel && <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="line-clamp-2 min-w-0 flex-1">{zh ? '回复：' : 'Reply to: '}{replyLabel}</span><button type="button" className="p-1" aria-label={zh ? '取消回复' : 'Cancel reply'} onClick={onRemoveReply}><X size={14} /></button></div>}
    <label htmlFor="quick-question" className="sr-only">{zh ? '向 AI 股友提问' : 'Ask your AI research team'}</label>
    <div className="flex items-end gap-2"><Textarea ref={input} id="quick-question" value={text} onChange={event => setText(event.target.value)}
      className="max-h-40 min-h-20 flex-1 resize-y" maxLength={2000} placeholder={zh ? '任何投资问题都可以直接问…' : 'Ask any investment question…'}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => { if (shouldSendCouncilMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); void submit(); } }} />
      <Button type="submit" size="icon" className="shrink-0" disabled={!text.trim() || pending} aria-label={zh ? '发送问题' : 'Send question'}><Send size={17} /></Button></div>
    <p className="text-xs leading-5 text-muted-foreground">{zh ? 'Enter 发送 · Shift+Enter 换行。讨论中的观点不会自动变成交易指令。' : 'Enter to send · Shift+Enter for a new line. Discussion does not automatically authorize a trade.'}</p>
  </form>;
}
