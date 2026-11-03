import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWebUpdateStatus, startWebUpdate, type WebUpdateStatus } from '@/api/system-update';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function SystemUpdateCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [requestedVersion, setRequestedVersion] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const status = useQuery({
    queryKey: ['system-update'],
    queryFn: fetchWebUpdateStatus,
    retry: false,
    refetchInterval: requestedVersion ? 3_000 : false,
  });
  const start = useMutation({
    mutationFn: startWebUpdate,
    onSuccess: () => {
      const version = status.data?.available?.version;
      setTimedOut(false);
      if (version) setRequestedVersion(version);
      queryClient.setQueryData<WebUpdateStatus>(['system-update'], (current) => current
        ? { ...current, phase: 'updating' } : current);
      toast.success(t('updates.backedUp'));
    },
    onError: () => toast.error(t('updates.startFailed')),
  });

  useEffect(() => {
    if (!requestedVersion) return;
    const timer = window.setTimeout(() => setTimedOut(true), 5 * 60_000);
    return () => window.clearTimeout(timer);
  }, [requestedVersion]);

  useEffect(() => {
    if (requestedVersion && status.data?.currentVersion === requestedVersion) {
      toast.success(t('updates.complete'));
      setRequestedVersion(null);
      setTimedOut(false);
    }
  }, [requestedVersion, status.data?.currentVersion, t]);

  useEffect(() => {
    if (requestedVersion && status.data?.phase === 'failed') setRequestedVersion(null);
  }, [requestedVersion, status.data?.phase]);

  if (status.isPending) return <Card><CardContent className="flex items-center gap-2 pt-6" role="status">
    <LoaderCircle className="size-4 animate-spin" />{t('ui.settings.loading')}
  </CardContent></Card>;
  if (status.isError) return <Card><CardContent className="flex flex-wrap items-center gap-3 pt-6">
    <p role="alert" className="text-sm text-destructive">{t('settingsNav.updateLoadFailed')}</p>
    <Button variant="outline" size="sm" onClick={() => void status.refetch()}>{t('ui.settings.retry')}</Button>
  </CardContent></Card>;
  if (!status.data?.enabled) return <Card>
    <CardHeader><CardTitle>{t('updates.title')}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm leading-7">
      {status.data?.currentVersion && <p>{t('updates.current', { version: status.data.currentVersion })}</p>}
      <p className="max-w-2xl text-muted-foreground">{t('settingsNav.updateUnavailable')}</p>
    </CardContent>
  </Card>;
  const { currentVersion, available, phase, error } = status.data;
  const busy = start.isPending || phase === 'backingUp' || phase === 'updating' || !!requestedVersion;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('updates.title')}</CardTitle>
        <CardDescription>{t('updates.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{t('updates.current', { version: currentVersion })}</p>
        {available ? <p>{t('updates.available', { version: available.version })}</p>
          : <p className="text-muted-foreground">{error && phase === 'idle'
            ? t('updates.checkFailed') : t('updates.upToDate')}</p>}
        {busy && <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> {t('updates.working')}
        </p>}
        {(phase === 'failed' || timedOut) && <p role="alert" className="text-destructive">
          {t('updates.failed')}
        </p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!available || busy} onClick={() => start.mutate()}>
            <RotateCw className="size-4" /> {t('updates.updateNow')}
          </Button>
          {error && phase === 'idle' && <Button variant="outline" onClick={() => void status.refetch()}>
            {t('updates.checkAgain')}
          </Button>}
          {available && <a className="text-primary underline" href={available.releaseUrl}
            target="_blank" rel="noopener noreferrer">{t('updates.releaseNotes')}</a>}
        </div>
      </CardContent>
    </Card>
  );
}
