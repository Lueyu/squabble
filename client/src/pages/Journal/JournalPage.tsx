/**
 * @file pages/Journal/JournalPage.tsx
 * @description Route `/journal`: daily trading review journal.
 *
 * Shows a date navigator, an equity-curve chart from snapshots, and five
 * editable sections (market summary, portfolio summary, actions, plan,
 * lessons). A sidebar lists the most recent dates that have either a journal
 * entry or a snapshot, for quick navigation.
 */
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit3, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import http from '@/api/http';
import { fetchJournal, fetchSnapshots, logger } from '@/api';
import type { JournalEntry, Snapshot } from '@shared/api.interface';
import { formatDate, cn, toDate } from '@/utils/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DateNavigator } from './DateNavigator';
import { JournalChart } from './JournalChart';
import { sections, JournalSectionCard } from './JournalSectionCard';

/** Format a Date as a `YYYY-MM-DD` string for date inputs and API params. */
function formatDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Coerce a date value to a `YYYY-MM-DD` string, returning '' for invalid input. */
function safeDateStr(value: string | null | undefined): string {
  const d = toDate(value);
  return d ? formatDateInput(d) : '';
}

/**
 * Journal page component.
 *
 * State tracks the currently selected date, snapshots (for the chart and
 * current-day summary), the journal entry for that date, edit-mode form
 * values, and loading/saving flags.
 */
export default function JournalPage() {
  const { t } = useTranslation();
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date());
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [journalList, setJournalList] = useState<JournalEntry[]>([]);
  const [loadingSnap, setLoadingSnap] = useState(true);
  const [loadingJournal, setLoadingJournal] = useState(true);
  const [journalLoaded, setJournalLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const dateStr = formatDateInput(currentDate);
  const journal = journalList.find((entry) => safeDateStr(entry.journalDate) === dateStr) ?? null;

  /** Load all owned entries so history also includes dates without snapshots. */
  const loadJournal = useCallback(async () => {
    setLoadingJournal(true);
    try {
      const items: JournalEntry[] = await fetchJournal();
      setJournalList(items || []);
      setJournalLoaded(true);
    } catch (error) {
      logger.error('加载日志失败', error);
      toast.error(t('journal.loadFailed'));
    } finally {
      setLoadingJournal(false);
    }
  }, [t]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const data: Snapshot[] = await fetchSnapshots(30);
        if (mounted) {
          setSnapshots(data || []);
          if (data && data.length > 0) {
            const latest = toDate(data[0].snapshotDate);
            if (latest) {
              setCurrentDate(latest);
            }
          }
        }
      } catch (error) {
        logger.error('加载快照失败', error);
        toast.error(t('journal.loadNavFailed'));
      } finally {
        if (mounted) setLoadingSnap(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, [t]);

  useEffect(() => {
    loadJournal();
  }, [loadJournal]);

  /** Find the snapshot matching the currently selected date. */
  const currentSnapshot = useMemo(() => {
    return snapshots.find(
      (s) => safeDateStr(s.snapshotDate) === dateStr
    );
  }, [snapshots, dateStr]);

  /** Step the selected date back by one day. */
  const handlePrevDay = () => {
    if (editing) return;
    const d = new Date(currentDate);
    d.setDate(d.getDate() - 1);
    setCurrentDate(d);
  };

  /** Step the selected date forward by one day. */
  const handleNextDay = () => {
    if (editing) return;
    const d = new Date(currentDate);
    d.setDate(d.getDate() + 1);
    setCurrentDate(d);
  };

  /** Set the selected date directly from the date picker. */
  const handleDateChange = (d: Date) => {
    if (editing) return;
    setCurrentDate(d);
  };

  /** Navigate to a date chosen from the history sidebar. */
  const handleSelectHistory = (date: string) => {
    if (editing) return;
    const d = toDate(date);
    if (d) setCurrentDate(d);
  };

  /** Copy the current journal values into the edit form and enter edit mode. */
  const startEdit = () => {
    if (!journalLoaded || loadingJournal || loadingSnap) return;
    setEditValues({
      marketSummary: journal?.marketSummary || '',
      portfolioSummary: journal?.portfolioSummary || '',
      actions: journal?.actions || '',
      plan: journal?.plan || '',
      lessons: journal?.lessons || '',
    });
    setEditing(true);
  };

  /** Discard edits and exit edit mode. */
  const cancelEdit = () => {
    setEditing(false);
    setEditValues({});
  };

  /**
   * POST every edited section, including empty strings to clear old content.
   * Omitted fields are left unchanged by the backend. Refresh history on success.
   */
  const saveJournal = async () => {
    setSaving(true);
    try {
      const payload = {
        journalDate: dateStr,
        marketSummary: editValues.marketSummary ?? '',
        portfolioSummary: editValues.portfolioSummary ?? '',
        actions: editValues.actions ?? '',
        plan: editValues.plan ?? '',
        lessons: editValues.lessons ?? '',
      };
      const response = await http({
        url: '/api/portfolio/journal',
        method: 'POST',
        data: payload,
      });
      const saved = response.data as JournalEntry;
      setJournalList((entries) => [saved, ...entries.filter((entry) => entry.journalDate !== saved.journalDate)]);
      setEditing(false);
      toast.success(t('journal.saved'));
      loadJournal();
    } catch (error) {
      logger.error('保存日志失败', error);
      toast.error(t('journal.editFailed'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Build the history sidebar list: distinct dates that have either a journal
   * entry or a snapshot, sorted descending, capped at 30.
   */
  const historyDates = useMemo(() => {
    const dates = new Set<string>();
    journalList.forEach((j) => dates.add(j.journalDate));
    snapshots.forEach((s) => s.snapshotDate && dates.add(s.snapshotDate));
    return Array.from(dates)
      .filter((d) => toDate(d))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
      .slice(0, 30);
  }, [journalList, snapshots]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-foreground">
            {t('journal.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('ui.journal.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!editing ? (
            <Button onClick={startEdit} disabled={!journalLoaded || loadingJournal || loadingSnap} size="sm" className="gap-1.5">
              <Edit3 size={14} />
              {t('ui.journal.editJournal')}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={cancelEdit} className="gap-1.5">
                <X size={14} />
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={saveJournal} disabled={saving} className="gap-1.5">
                <Save size={14} />
                {saving ? t('common.saving') : t('common.save')}
              </Button>
            </>
          )}
        </div>
      </div>

      <DateNavigator
        currentDate={currentDate}
        snapshot={currentSnapshot}
        loading={loadingSnap}
        onPrev={handlePrevDay}
        onNext={handleNextDay}
        onDateChange={handleDateChange}
      />

      <JournalChart snapshots={snapshots} loading={loadingSnap} />

      <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
        <div>
          <h2 className="mb-3 font-serif text-xl font-semibold">{t('ui.journal.dailySummary')}</h2>
          {loadingJournal ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="mb-3 h-4 w-24" />
                    <Skeleton className="h-20 w-full" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {sections.map((s) => (
                <JournalSectionCard
                  key={s.key}
                  section={s}
                  content={journal?.[s.key]}
                  editing={editing}
                  editValue={editValues[s.key] || ''}
                  onEditChange={(val) =>
                    setEditValues((prev) => ({ ...prev, [s.key]: val }))
                  }
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-3 font-serif text-xl font-semibold">{t('ui.journal.history')}</h2>
          <Card>
            <CardContent className="p-2">
              {historyDates.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {t('ui.journal.noHistory')}
                </div>
              ) : (
                <div className="max-h-[500px] space-y-0.5 overflow-y-auto">
                  {historyDates.map((date) => {
                    const isActive =
                      safeDateStr(date) === dateStr;
                    return (
                      <button
                        key={date}
                        onClick={() => handleSelectHistory(date)}
                        className={cn(
                          'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                          isActive
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'hover:bg-muted text-foreground/80 hover:text-foreground'
                        )}
                      >
                        <div className="font-mono tabular-nums">{formatDate(date)}</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
