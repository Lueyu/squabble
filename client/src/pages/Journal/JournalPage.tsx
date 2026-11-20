/**
 * JournalPage.tsx — 路由 /journal：按日的交易复盘手记页。
 *
 * 职责边界：
 *  - 页面编排：日期导航条（DateNavigator）、净值曲线图（JournalChart）、
 *    五个可编辑分区（市场小结 / 组合小结 / 操作 / 计划 / 教训，JournalSectionCard）、
 *    右侧历史日期侧边栏（有日志或有快照的最近 30 天，点击即跳转）；
 *  - 持有页面状态：当前选中日期、快照列表、日志列表、编辑态草稿与加载 / 保存标记；
 *  - 保存走 POST /api/portfolio/journal，编辑值全部上送（含空串，用于清空旧内容）。
 * 上下游：
 *  - 上游：路由表挂载在 /journal；
 *  - 下游：./DateNavigator、./JournalChart、./JournalSectionCard（含 sections 清单）、
 *    @/api 的 fetchJournal / fetchSnapshots / logger、@/api/http（保存请求）、sonner 的 toast。
 * 关键约定：
 *  - 日期统一用 `YYYY-MM-DD` 字符串比较（safeDateStr 归一化），避免 Date 对象 / 时区差异；
 *  - 编辑态下所有日期切换入口（前后翻日、选择器、历史侧栏）都被拦截（if (editing) return）；
 *  - 快照接口取近 30 天；首屏用最新一条快照的日期作为当前日期（仅首次加载时设置）。
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

/** 把 Date 格式化为 `YYYY-MM-DD` 字符串，用于日期输入与 API 参数。 */
function formatDateInput(d: Date): string {
  // 年、月、日分别取出，月 / 日补零到两位。
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 把日期值归一化为 `YYYY-MM-DD` 字符串；解析失败返回 ''（用于比较时的脏数据兜底）。 */
function safeDateStr(value: string | null | undefined): string {
  const d = toDate(value);
  return d ? formatDateInput(d) : '';
}

/**
 * 交易日志页组件。
 *
 * 状态持有：当前选中日期、快照序列（供图表与当日统计）、
 * 所选日期的日志条目、编辑态草稿、加载 / 保存标记。
 */
export default function JournalPage() {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  // 当前选中的日志日期（首屏为今天，快照加载成功后切到最新快照日）。
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date());
  // 近 30 天的账户快照（图表 + 当日统计条数据源）。
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  // 全量日志条目（历史侧栏 + 当前日期日志查找的数据源）。
  const [journalList, setJournalList] = useState<JournalEntry[]>([]);
  // 两个独立加载标记：快照 / 日志分别请求，互不阻塞。
  const [loadingSnap, setLoadingSnap] = useState(true);
  const [loadingJournal, setLoadingJournal] = useState(true);
  // 日志是否完成过一次加载（编辑按钮在加载完成前禁用）。
  const [journalLoaded, setJournalLoaded] = useState(false);
  // 编辑态开关与五个分区的草稿值（key = JournalEntry 字段名）。
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  // 保存中标记。
  const [saving, setSaving] = useState(false);

  // ---- 派生计算区 ----
  // 当前日期的 YYYY-MM-DD 字符串（比较与提交共用）。
  const dateStr = formatDateInput(currentDate);
  // 当前日期对应的日志条目；没有则 null。
  const journal = journalList.find((entry) => safeDateStr(entry.journalDate) === dateStr) ?? null;

  // ---- 数据获取区 ----
  /** 拉取全量日志：历史侧栏需要"没有快照但有日志"的日期，所以必须全量拉。 */
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

  // 首屏加载近 30 天快照；mounted 标记防止卸载后 setState。
  // 请求成功且列表非空时，把当前日期切到最新一条快照的日期（仅此一次，之后由用户操作驱动）。
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
    return () => {
      mounted = false;
    };
  }, [t]);

  // 挂载后加载全量日志（loadJournal 是 useCallback，t 变化才重建）。
  useEffect(() => {
    loadJournal();
  }, [loadJournal]);

  // 所选日期对应的快照（DateNavigator 统计条的数据源）。
  const currentSnapshot = useMemo(() => {
    return snapshots.find((s) => safeDateStr(s.snapshotDate) === dateStr);
  }, [snapshots, dateStr]);

  // ---- 事件处理区 ----
  /** 前一天。编辑态下禁止切换。 */
  const handlePrevDay = () => {
    if (editing) return;
    const d = new Date(currentDate);
    d.setDate(d.getDate() - 1);
    setCurrentDate(d);
  };

  /** 后一天。编辑态下禁止切换。 */
  const handleNextDay = () => {
    if (editing) return;
    const d = new Date(currentDate);
    d.setDate(d.getDate() + 1);
    setCurrentDate(d);
  };

  /** 日期选择器直接指定日期。编辑态下禁止切换。 */
  const handleDateChange = (d: Date) => {
    if (editing) return;
    setCurrentDate(d);
  };

  /** 历史侧栏点击跳转。编辑态下禁止切换；非法日期字符串忽略。 */
  const handleSelectHistory = (date: string) => {
    if (editing) return;
    const d = toDate(date);
    if (d) setCurrentDate(d);
  };

  /** 进入编辑态：把当前日志的五个分区拷贝进草稿（无日志则全空串）。 */
  const startEdit = () => {
    // 数据未就绪时不允许进入编辑态（避免基于空数据误清内容）。
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

  /** 取消编辑：丢弃草稿并退出编辑态。 */
  const cancelEdit = () => {
    setEditing(false);
    setEditValues({});
  };

  /**
   * 保存：五个分区全部上送（包括空串——空串用于清空旧内容；
   * 省略字段才会被后端保留原值，所以这里不能用"省略"来表达清空）。
   * 成功后本地更新列表、退出编辑态，并刷新全量日志。
   */
  const saveJournal = async () => {
    setSaving(true);
    try {
      // 第一步：组装 payload（journalDate + 五个分区，编辑值缺省补空串）。
      const payload = {
        journalDate: dateStr,
        marketSummary: editValues.marketSummary ?? '',
        portfolioSummary: editValues.portfolioSummary ?? '',
        actions: editValues.actions ?? '',
        plan: editValues.plan ?? '',
        lessons: editValues.lessons ?? '',
      };
      // 第二步：POST 保存，返回保存后的完整 JournalEntry。
      const response = await http({
        url: '/api/portfolio/journal',
        method: 'POST',
        data: payload,
      });
      const saved = response.data as JournalEntry;
      // 第三步：本地同步——替换同日期旧条目、新条目置顶。
      setJournalList((entries) => [
        saved,
        ...entries.filter((entry) => entry.journalDate !== saved.journalDate),
      ]);
      setEditing(false);
      toast.success(t('journal.saved'));
      // 第四步：后台再拉一次全量，保证历史侧栏与服务端一致。
      loadJournal();
    } catch (error) {
      logger.error('保存日志失败', error);
      toast.error(t('journal.editFailed'));
    } finally {
      setSaving(false);
    }
  };

  // 历史侧栏数据：日志日期 ∪ 快照日期，去重、过滤非法值、按日期降序、截取前 30 条。
  const historyDates = useMemo(() => {
    const dates = new Set<string>();
    journalList.forEach((j) => dates.add(j.journalDate));
    snapshots.forEach((s) => s.snapshotDate && dates.add(s.snapshotDate));
    return Array.from(dates)
      .filter((d) => toDate(d))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
      .slice(0, 30);
  }, [journalList, snapshots]);

  // ---- 渲染区 ----
  return (
    <div className="space-y-6">
      {/* 页头：标题 + 副标题 + 编辑 / 保存按钮组。 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-foreground">
            {t('journal.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('ui.journal.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* 非编辑态：单个"编辑手记"按钮（数据未就绪时禁用）。
              编辑态：换成"取消 + 保存"按钮对。 */}
          {!editing ? (
            <Button
              onClick={startEdit}
              disabled={!journalLoaded || loadingJournal || loadingSnap}
              size="sm"
              className="gap-1.5"
            >
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

      {/* 日期导航条 + 净值曲线图。 */}
      <DateNavigator
        currentDate={currentDate}
        snapshot={currentSnapshot}
        loading={loadingSnap}
        onPrev={handlePrevDay}
        onNext={handleNextDay}
        onDateChange={handleDateChange}
      />

      <JournalChart snapshots={snapshots} loading={loadingSnap} />

      {/* 主体两栏：左 = 五个分区卡片，右 = 历史日期侧栏。 */}
      <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
        <div>
          <h2 className="mb-3 font-serif text-xl font-semibold">{t('ui.journal.dailySummary')}</h2>
          {/* 日志加载中：5 张骨架卡占位；就绪后按 sections 渲染分区卡片。 */}
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
                  onEditChange={(val) => setEditValues((prev) => ({ ...prev, [s.key]: val }))}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-3 font-serif text-xl font-semibold">{t('ui.journal.history')}</h2>
          <Card>
            <CardContent className="p-2">
              {/* 历史侧栏：无记录显示占位；有记录渲染可点击日期列表（当前日期高亮）。 */}
              {historyDates.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {t('ui.journal.noHistory')}
                </div>
              ) : (
                <div className="max-h-[500px] space-y-0.5 overflow-y-auto">
                  {historyDates.map((date) => {
                    const isActive = safeDateStr(date) === dateStr;
                    return (
                      <button
                        key={date}
                        onClick={() => handleSelectHistory(date)}
                        className={cn(
                          'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                          isActive
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'hover:bg-muted text-foreground/80 hover:text-foreground',
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
