import { useTranslation } from 'react-i18next';
import { useResearchMemoryActions, useResearchMemoryPreferences } from '@/hooks/use-research-memory';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { workflowCopy } from '@/pages/Council/workflow-copy';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

export default function ResearchMemorySettings() {
  const { i18n } = useTranslation();
  const copy = workflowCopy[i18n.language.startsWith('zh') ? 'zh-CN' : 'en'];
  const prefs = useResearchMemoryPreferences();
  const actions = useResearchMemoryActions();
  const error = prefs.error ?? actions.preferences.error;
  return <Card id="research-memory"><CardHeader><CardTitle>{copy.preferences}</CardTitle><CardDescription>{copy.preferencesHint}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="text-sm text-destructive">{errorMessage(error, copy.memoryFailed)}</p>}
      {prefs.data && (['autoArchive', 'recallEnabled'] as const).map(key => <Label key={key} className="gap-3">
        <Switch checked={prefs.data[key]} disabled={actions.preferences.isPending} onCheckedChange={value =>
          actions.preferences.mutate({ ...prefs.data!, [key]: value })} />{key === 'autoArchive' ? copy.archive : copy.recallSetting}
      </Label>)}
    </CardContent></Card>;
}
