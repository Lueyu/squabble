import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { shouldSendCouncilMessage } from '@/utils/council-state';
import type { ResearchSkillDescriptor } from '@shared/research-skills.interface';

export default function QuickQuestion({ onSubmit, pending, contextLabel, onRemoveContext, replyLabel, onRemoveReply, initialText = '', value, onValueChange, readOnlyText = false, skills, selectedSkill, onSkillSelect }: {
  onSubmit: (message: string) => Promise<boolean>; pending: boolean; contextLabel?: string;
  onRemoveContext?: () => void; replyLabel?: string; onRemoveReply?: () => void; initialText?: string;
  value?: string; onValueChange?: (value: string) => void; readOnlyText?: boolean;
  skills?: ResearchSkillDescriptor[]; selectedSkill?: ResearchSkillDescriptor;
  onSkillSelect?: (skill: ResearchSkillDescriptor | null) => void;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [localText, setLocalText] = useState(initialText); const composing = useRef(false); const submitting = useRef(false);
  const text = value ?? localText;
  const latestText = useRef(text);
  latestText.current = text;
  const setText = (next: string) => { if (onValueChange) onValueChange(next); else setLocalText(next); };
  const input = useRef<HTMLTextAreaElement>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const command = /^\/[a-z-]*$/iu.test(text.trim()) ? text.trim().toLowerCase() : null;
  const matches = !readOnlyText && !dismissed && command ? skills?.filter(skill => skill.command.startsWith(command)) ?? [] : [];
  const pick = (skill: ResearchSkillDescriptor) => {
    onSkillSelect?.(skill);
    setText('');
    setMenuIndex(0);
    input.current?.focus();
  };
  useEffect(() => { if (replyLabel) input.current?.focus(); }, [replyLabel]);
  const submit = async () => {
    if (!text.trim() || pending || submitting.current) return;
    submitting.current = true;
    const submitted = text;
    try { if (await onSubmit(submitted.trim()) && latestText.current === submitted) {
      if (input.current) input.current.style.height = 'auto';
      setText('');
    } }
    finally { submitting.current = false; }
  };
  return <form className="research-composer min-w-0 shrink-0 space-y-2 border-t bg-card p-3 sm:p-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {matches.length > 0 && <div id="research-skill-list" className="research-skill-menu" role="listbox" aria-label={zh ? '选择技能' : 'Choose a skill'}>
      <p>{zh ? '选择技能' : 'Choose a skill'}</p>
      {matches.map((skill, index) => <button key={skill.id} id={`research-skill-${skill.id}`} type="button" role="option"
        aria-selected={Math.min(menuIndex, matches.length - 1) === index} onClick={() => pick(skill)}>
        <code>{skill.command}</code><strong>{zh ? skill.title : skill.titleEn}</strong><span>{zh ? skill.description : skill.descriptionEn}</span>
      </button>)}
    </div>}
    {selectedSkill && <div className="research-selected-skill"><span>{selectedSkill.command} · {zh ? selectedSkill.title : selectedSkill.titleEn}</span>
      <button type="button" disabled={readOnlyText || pending} aria-label={zh ? '移除技能' : 'Remove skill'} onClick={() => onSkillSelect?.(null)}><X size={14} /></button></div>}
    {contextLabel && <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs"><span className="min-w-0 flex-1 break-words">{contextLabel}</span>{onRemoveContext && <button type="button" className="inline-flex size-8 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={zh ? '移除上下文' : 'Remove context'} onClick={onRemoveContext}><X size={14} /></button>}</div>}
    {replyLabel && <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="line-clamp-2 min-w-0 flex-1">{zh ? '回复：' : 'Reply to: '}{replyLabel}</span><button type="button" className="p-1" aria-label={zh ? '取消回复' : 'Cancel reply'} onClick={onRemoveReply}><X size={14} /></button></div>}
    <label htmlFor="quick-question" className="sr-only">{zh ? '向 AI 股友提问' : 'Ask your AI research team'}</label>
    <div className="flex min-w-0 items-end gap-2"><Textarea ref={input} id="quick-question" value={text} readOnly={readOnlyText} onChange={event => {
      setText(event.target.value); setMenuIndex(0); setDismissed(false); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 144)}px`;
    }}
      className="max-h-36 min-h-16 min-w-0 flex-1 resize-none overflow-y-auto [overflow-wrap:anywhere]" maxLength={2000} placeholder={zh ? '任何投资问题都可以直接问…' : 'Ask any investment question…'}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      aria-expanded={matches.length > 0} aria-controls={matches.length ? 'research-skill-list' : undefined}
      onKeyDown={event => {
        if (!composing.current && !event.nativeEvent.isComposing && matches.length) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length); return; }
          if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); pick(matches[Math.min(menuIndex, matches.length - 1)]); return; }
        }
        if (shouldSendCouncilMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); void submit(); }
      }} />
      <Button type="submit" size="icon" className="shrink-0" disabled={!text.trim() || pending} aria-label={zh ? '发送问题' : 'Send question'}><Send size={17} /></Button></div>
    <p className="research-composer-hint text-xs leading-5 text-muted-foreground">{skills && <span>{zh ? '输入 / 选择技能 · ' : 'Type / for skills · '}</span>}{zh ? 'Enter 发送 · Shift+Enter 换行。观点不会自动变成交易指令。' : 'Enter to send · Shift+Enter for a new line. Views do not authorize trades.'}</p>
  </form>;
}
