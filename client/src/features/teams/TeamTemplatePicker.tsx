import { useId, type ReactNode } from 'react';
import { AGENT_SPECIALTY_CATALOG } from '@shared/agent-specialty-catalog';
import type { AgentTemplateId } from '@shared/agent-roster.interface';
import { TEAM_TEMPLATES, type TeamTemplate } from '@shared/team-templates';
import AnimalAvatar from '@/components/AnimalAvatar';
import { Button } from '@/components/ui/button';
import './team-template-picker.css';

interface TeamTemplatePickerProps {
  template: TeamTemplate;
  language: keyof TeamTemplate['name'];
  onSelect: (id: string) => void;
  children: ReactNode;
}

export function TeamTemplatePicker({ template, language, onSelect, children }: TeamTemplatePickerProps) {
  const headingId = useId();
  const zh = language === 'zh-CN';
  const rolesByFriend = new Map<AgentTemplateId, string[]>();
  for (const { roleId, recommendedTemplateId } of template.staffing) {
    const [chinese, english] = (template.display.roleLabels[roleId] ?? '').split(' / ');
    const role = (zh ? chinese : english) || chinese;
    const roles = rolesByFriend.get(recommendedTemplateId) ?? [];
    if (role) roles.push(role);
    rolesByFriend.set(recommendedTemplateId, roles);
  }
  const friendsById = new Map(AGENT_SPECIALTY_CATALOG.map(friend => [friend.id, friend]));
  const friends = [
    ...rolesByFriend.keys(),
    ...AGENT_SPECIALTY_CATALOG.filter(friend => !rolesByFriend.has(friend.id)).map(friend => friend.id),
  ].flatMap(id => {
    const friend = friendsById.get(id);
    return friend ? [friend] : [];
  });

  return <div className="team-create-template-picker">
    <div className="team-create-template-layout">
      <section className="team-create-template-list">
        <h3 id={headingId}>{zh ? '固定团队模板' : 'Fixed team templates'}</h3>
        <div className="team-create-template-options" role="group" aria-labelledby={headingId}>
          {TEAM_TEMPLATES.map(item => <Button key={item.id} type="button" variant="ghost"
            aria-pressed={template.id === item.id} onClick={() => onSelect(item.id)}>
            {item.name[language]}
          </Button>)}
        </div>
        <p className="team-muted team-small">{zh ? '模板结构只读。' : 'Template structure is read-only.'}</p>
      </section>
      <div className="team-create-template-detail">
        <section className="team-create-staffing"
          aria-label={zh ? '自动配员预览' : 'Automatic staffing preview'}>
          <h3>{template.name[language]}</h3>
          <p className="team-create-staffing-count" aria-live="polite">
            {zh
              ? `自动指派 ${template.staffing.length} 个岗位 · ${friends.length} 位内置股友`
              : `${template.staffing.length} seats assigned automatically · ${friends.length} built-in friends`}
          </p>
          <p className="team-muted team-small">
            {zh ? '原型只读。创建后可在本团队调整岗位配置。'
              : 'Prototypes are read-only. Adjust assignments within this team after creation.'}
          </p>
          <ul className="team-create-staffing-grid">
            {friends.map(friend => {
              const roles = rolesByFriend.get(friend.id);
              return <li key={friend.id} data-assigned={Boolean(roles)}>
                <AnimalAvatar avatar={friend.avatar} role="researcher" className="size-8 shrink-0" />
                <div>
                  <strong>{zh ? friend.name : friend.nameEn}</strong>
                  <span className="team-create-staffing-role">
                    {roles?.join(zh ? '、' : ', ') || (zh ? '本模板未指派' : 'Not assigned in this template')}
                  </span>
                  <span>{zh ? '内置原型 · 只读' : 'Built-in prototype · Read-only'}</span>
                </div>
              </li>;
            })}
          </ul>
        </section>
        {children}
      </div>
    </div>
  </div>;
}
