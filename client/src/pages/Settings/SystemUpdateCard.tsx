/**
 * SystemUpdateCard.tsx — 系统更新分区卡：检查 Web 版更新、一键升级并跟踪升级状态机。
 *
 * 职责边界：
 *  - 仅负责"Web 更新"：查询当前/可用版本与阶段，发起升级，展示进行中/失败/完成；
 *    不涉及桌面端（companion/CLI）的更新。
 * 上下游：
 *  - 上游（路由入口/谁引用）：SettingsPage 的 system 分区。
 *  - 下游（调用哪些 hooks/api/组件）：useQuery/useMutation/useQueryClient；fetchWebUpdateStatus、
 *    startWebUpdate、WebUpdateStatus 类型；Card/Button；toast。
 * 关键约定：
 *  - 状态机 phase：backingUp → updating → idle/failed；发起升级后本地立即置 phase='updating'。
 *  - 轮询策略：仅在已请求升级（requestedVersion 非空）时每 3 秒轮询，平时不轮询。
 *  - 完成判定：currentVersion 追平 requestedVersion → toast 完成并清空目标版本；
 *    phase==='failed' → 清空目标版本；5 分钟仍未完成 → timedOut 显示失败文案（非确定性，仅提示）。
 *  - busy = 提交中 || backingUp || updating || 存在未完成的目标版本，期间"立即更新"禁用。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWebUpdateStatus, startWebUpdate, type WebUpdateStatus } from '@/api/system-update';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function SystemUpdateCard() {
  // —— 状态声明区 ——
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 本次升级的目标版本号：非空表示升级已发起且尚未确认完成
  const [requestedVersion, setRequestedVersion] = useState<string | null>(null);
  // 升级发起后 5 分钟仍未完成时置真，用于兜底失败提示
  const [timedOut, setTimedOut] = useState(false);

  // —— 数据获取区 ——
  // 更新状态查询：平时不轮询；发起升级后每 3 秒轮询以跟踪 phase 变化
  const status = useQuery({
    queryKey: ['system-update'],
    queryFn: fetchWebUpdateStatus,
    retry: false,
    refetchInterval: requestedVersion ? 3_000 : false,
  });
  // 发起升级：本地立即置 updating 提升响应感，真实进度靠轮询；成功 toast"已备份"
  const start = useMutation({
    mutationFn: startWebUpdate,
    onSuccess: () => {
      const version = status.data?.available?.version;
      setTimedOut(false);
      if (version) setRequestedVersion(version);
      queryClient.setQueryData<WebUpdateStatus>(['system-update'], (current) =>
        current ? { ...current, phase: 'updating' } : current,
      );
      toast.success(t('updates.backedUp'));
    },
    onError: () => toast.error(t('updates.startFailed')),
  });

  // —— 副作用区 ——
  // 什么时候走到这里：已发起升级——挂 5 分钟超时定时器，到期置 timedOut 兜底提示
  useEffect(() => {
    if (!requestedVersion) return;
    const timer = window.setTimeout(() => setTimedOut(true), 5 * 60_000);
    return () => window.clearTimeout(timer);
  }, [requestedVersion]);
  // 什么时候走到这里：当前版本追平目标版本——升级完成，toast 并清空目标版本
  useEffect(() => {
    if (requestedVersion && status.data?.currentVersion === requestedVersion) {
      toast.success(t('updates.complete'));
      setRequestedVersion(null);
      setTimedOut(false);
    }
  }, [requestedVersion, status.data?.currentVersion, t]);
  // 什么时候走到这里：服务端报告升级失败——清空目标版本（停止轮询）
  useEffect(() => {
    if (requestedVersion && status.data?.phase === 'failed') setRequestedVersion(null);
  }, [requestedVersion, status.data?.phase]);

  // —— 渲染区 ——
  // 四个互斥的早期返回分支，按状态优先级排列
  // 什么时候走到这里：状态首次加载中
  if (status.isPending)
    return (
      <Card>
        <CardContent className="flex items-center gap-2 pt-6" role="status">
          <LoaderCircle className="size-4 animate-spin" />
          {t('ui.settings.loading')}
        </CardContent>
      </Card>
    );
  // 什么时候走到这里：状态查询失败——错误提示 + 重试
  if (status.isError)
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <p role="alert" className="text-sm text-destructive">
            {t('settingsNav.updateLoadFailed')}
          </p>
          <Button variant="outline" size="sm" onClick={() => void status.refetch()}>
            {t('ui.settings.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  // 什么时候走到这里：服务端未启用 Web 更新（或非 Web 环境）——只显示当前版本与不可用说明
  if (!status.data?.enabled)
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('updates.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-7">
          {status.data?.currentVersion && (
            <p>{t('updates.current', { version: status.data.currentVersion })}</p>
          )}
          <p className="max-w-2xl text-muted-foreground">{t('settingsNav.updateUnavailable')}</p>
        </CardContent>
      </Card>
    );
  // —— 派生计算区 ——（主分支的数据与 busy 状态）
  const { currentVersion, available, phase, error } = status.data;
  const busy =
    start.isPending || phase === 'backingUp' || phase === 'updating' || !!requestedVersion;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('updates.title')}</CardTitle>
        <CardDescription>{t('updates.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* 当前版本 + 可用版本/已是最新（有错误且空闲时显示检查失败） */}
        <p>{t('updates.current', { version: currentVersion })}</p>
        {available ? (
          <p>{t('updates.available', { version: available.version })}</p>
        ) : (
          <p className="text-muted-foreground">
            {error && phase === 'idle' ? t('updates.checkFailed') : t('updates.upToDate')}
          </p>
        )}
        {/* 什么时候走到这里：升级进行中（备份/更新/已请求未完成）——转圈提示 */}
        {busy && (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> {t('updates.working')}
          </p>
        )}
        {/* 什么时候走到这里：升级失败（phase=failed 或 5 分钟超时兜底） */}
        {(phase === 'failed' || timedOut) && (
          <p role="alert" className="text-destructive">
            {t('updates.failed')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {/* 立即更新：无可用版本或升级进行中时禁用 */}
          <Button disabled={!available || busy} onClick={() => start.mutate()}>
            <RotateCw className="size-4" /> {t('updates.updateNow')}
          </Button>
          {/* 什么时候走到这里：版本检查失败且空闲——给"重新检查" */}
          {error && phase === 'idle' && (
            <Button variant="outline" onClick={() => void status.refetch()}>
              {t('updates.checkAgain')}
            </Button>
          )}
          {/* 什么时候走到这里：有可用版本——给发布说明外链 */}
          {available && (
            <a
              className="text-primary underline"
              href={available.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('updates.releaseNotes')}
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
