/**
 * ModelConnectionsPanel.tsx — 模型连接分区：管理多模型 API 连接的增删改查与连通性测试。
 *
 * 职责边界：
 *  - 仅维护"模型连接"实体（名称 / baseUrl / 快慢模型 / apiKey）：新建、编辑、删除、探测可用性。
 *  - 连接如何被各智能体消费不在本组件职责内（见服务端 model-connections 模块）。
 * 上下游：
 *  - 上游（路由入口/谁引用）：SettingsPage 的 models 分区（settings-navigation.test.cjs 以
 *    props.active 控制其他分区激活时本弹层强制关闭）。
 *  - 下游（调用哪些 hooks/api/组件）：useQuery/useMutation/useQueryClient；@/api/model-connections
 *    的五个请求函数；AgentBuilder/errorMessage；Card/Dialog/AlertDialog/Button/Input/Label。
 * 关键约定：
 *  - 连接上限 8 个：达到后"新增"按钮禁用。
 *  - apiKey 安全约定：编辑已有连接时草稿中的 apiKey 置空，服务端不回传明文（仅 maskedApiKey）；
 *    提交时留空即沿用旧 key（hasApiKey 控制必填与 placeholder 提示）。
 *  - 探测结果按连接 id 累积存放在 results，不随弹层开关清空。
 *  - active=false（其他设置分区激活）时弹层被强制关闭，但草稿/编辑对象等状态全部保留。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Pencil, Plus, Trash2, Unplug } from 'lucide-react';
import type { ModelConnection, SaveModelConnection } from '@shared/model-connections.interface';
import {
  createModelConnection,
  fetchModelConnections,
  removeModelConnection,
  testModelConnection,
  updateModelConnection,
} from '@/api/model-connections';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

// 新建/编辑表单的空白草稿：关闭弹层或切换编辑对象时重置回该值
const EMPTY: SaveModelConnection = {
  name: '',
  baseUrl: '',
  fastModel: '',
  slowModel: '',
  apiKey: '',
};
// React Query 缓存键：列表查询与保存/删除成功后的失效目标共用
const QUERY_KEY = ['settings', 'model-connections'];

export default function ModelConnectionsPanel({ active = true }: { active?: boolean } = {}) {
  // —— 状态声明区 ——
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [editing, setEditing] = useState<ModelConnection | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SaveModelConnection>({ ...EMPTY });
  const [failure, setFailure] = useState('');
  const [deleting, setDeleting] = useState<ModelConnection | null>(null);
  // 探测结果按连接 id 累积：{ ok, message }，成败都写入
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  // —— 数据获取区 ——
  const list = useQuery({ queryKey: QUERY_KEY, queryFn: fetchModelConnections });
  // i18n 快捷键：所有文案都在 integrations.connections.* 命名空间下
  const key = (name: string) => t(`integrations.connections.${name}`);
  // 保存：editing 非空走更新，否则新建；成功关弹层、清草稿并失效列表缓存
  const save = useMutation({
    mutationFn: () =>
      editing ? updateModelConnection(editing.id, draft) : createModelConnection(draft),
    onSuccess: async () => {
      setOpen(false);
      setDraft({ ...EMPTY });
      await client.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: unknown) => setFailure(errorMessage(error, key('failed'))),
  });
  // 删除：成功后清 deleting（关确认弹层）并失效列表缓存
  const remove = useMutation({
    mutationFn: removeModelConnection,
    onSuccess: async () => {
      setDeleting(null);
      await client.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: unknown) => setFailure(errorMessage(error, key('failed'))),
  });
  // 连通性测试：按当前语言请求探测；成功与失败都写入 results[连接 id]（失败文案已脱敏）
  const probe = useMutation({
    mutationFn: (id: string) =>
      testModelConnection(id, i18n.language.startsWith('zh') ? 'zh-CN' : 'en'),
    onSuccess: (result, id) => setResults((current) => ({ ...current, [id]: result })),
    onError: (error: unknown, id: string) =>
      setResults((current) => ({
        ...current,
        [id]: { ok: false, message: errorMessage(error, key('failed')) },
      })),
  });

  // —— 事件处理区 ——
  // 打开新建/编辑弹层：编辑已有连接时 apiKey 置空（服务端不回传明文），失败提示清零
  const edit = (row: ModelConnection | null) => {
    setEditing(row);
    setDraft(
      row
        ? {
            name: row.name,
            baseUrl: row.baseUrl,
            fastModel: row.fastModel,
            slowModel: row.slowModel,
            apiKey: '',
          }
        : { ...EMPTY },
    );
    setFailure('');
    setOpen(true);
  };
  // 更新草稿单个字段（受控输入）
  const update = (field: keyof SaveModelConnection, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  // —— 渲染区 ——
  return (
    <Card id="model-connections" className="min-w-0 scroll-mt-6">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <CardTitle>{key('title')}</CardTitle>
          <CardDescription>{key('intro')}</CardDescription>
        </div>
        {/* 新增入口：连接数达到上限 8 个时禁用 */}
        <Button
          size="sm"
          variant="outline"
          onClick={() => edit(null)}
          disabled={(list.data?.length ?? 0) >= 8}
        >
          <Plus />
          {key('add')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 什么时候走到这里：列表首次加载中 */}
        {list.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            {key('loading')}
          </p>
        )}
        {/* 什么时候走到这里：列表加载失败——错误提示 + 重试按钮 */}
        {list.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            {key('failed')}
            <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
              {key('retry')}
            </Button>
          </div>
        )}
        {/* 什么时候走到这里：加载成功但一条连接都没有——空态说明 */}
        {list.isSuccess && list.data.length === 0 && (
          <p className="rounded-lg bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">
            {key('empty')}
          </p>
        )}
        {/* 连接卡片列表：双列网格 */}
        <div className="grid gap-3 lg:grid-cols-2">
          {list.data?.map((connection) => (
            <div key={connection.id} className="min-w-0 rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-2 font-semibold">
                    {/* 可用性图标：可用→绿色对勾，不可用→红色断开图标 */}
                    {connection.available ? (
                      <CheckCircle2 className="size-4 shrink-0 text-success" />
                    ) : (
                      <Unplug className="size-4 shrink-0 text-destructive" />
                    )}
                    <span className="min-w-0 [overflow-wrap:anywhere]">{connection.name}</span>
                  </p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {connection.baseUrl}
                  </p>
                </div>
                <div className="flex shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`${key('edit')} ${connection.name}`}
                    onClick={() => edit(connection)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`${key('remove')} ${connection.name}`}
                    onClick={() => {
                      setFailure('');
                      setDeleting(connection);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              {/* 快/慢模型明细 */}
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
                <dt className="text-muted-foreground">{key('fast')}</dt>
                <dd className="break-all">{connection.fastModel}</dd>
                <dt className="text-muted-foreground">{key('slow')}</dt>
                <dd className="break-all">{connection.slowModel}</dd>
              </dl>
              {/* 什么时候走到这里：服务端标记该连接的 apiKey 需要重新录入 */}
              {connection.needsReentry && (
                <p className="mt-2 text-xs text-destructive">{key('reentry')}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{connection.maskedApiKey}</span>
                {/* 测试按钮：探测进行中或连接不可用时禁用；转圈仅当前行探测时显示 */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={probe.isPending || !connection.available}
                  onClick={() => probe.mutate(connection.id)}
                >
                  {probe.isPending && probe.variables === connection.id && (
                    <Loader2 className="size-3 animate-spin" />
                  )}
                  {key('test')}
                </Button>
              </div>
              {/* 什么时候走到这里：该连接有探测结果——按成败着色展示 */}
              {results[connection.id] && (
                <p
                  role="status"
                  className={`mt-2 break-words text-xs leading-5 ${results[connection.id].ok ? 'text-success' : 'text-destructive'}`}
                >
                  {results[connection.id].message}
                </p>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{key('budget')}</p>
      </CardContent>
      {/* 新建/编辑弹层：active=false（其他分区激活）时强制关闭但状态保留；
          用户主动关闭（value=false）时才清空草稿 */}
      <Dialog
        open={active && open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setDraft({ ...EMPTY });
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? key('edit') : key('add')}</DialogTitle>
            <DialogDescription>{key('guide')}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setFailure('');
              save.mutate();
            }}
          >
            {/* 厂商预填按钮：写入官方 baseUrl 与默认模型；
                若当前草稿已是该厂商地址则保留已输入的 apiKey，否则清空 */}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    baseUrl: 'https://api.deepseek.com',
                    fastModel: 'deepseek-flash',
                    slowModel: 'deepseek-flash',
                    apiKey: current.baseUrl === 'https://api.deepseek.com' ? current.apiKey : '',
                  }))
                }
              >
                DeepSeek
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    baseUrl: 'https://api.openai.com/v1',
                    fastModel: '',
                    slowModel: '',
                    apiKey: current.baseUrl === 'https://api.openai.com/v1' ? current.apiKey : '',
                  }))
                }
              >
                OpenAI
              </Button>
            </div>
            {/* 五个字段依次渲染：apiKey 用密码框；编辑已有 key 的连接时非必填（placeholder
                提示留空即沿用）；长度上限 apiKey 4096 / name 60 / baseUrl 500 / 其余 120 */}
            {(['name', 'baseUrl', 'fastModel', 'slowModel', 'apiKey'] as const).map((field) => (
              <div key={field} className="space-y-2">
                <Label htmlFor={`connection-${field}`}>{key(field)}</Label>
                <Input
                  id={`connection-${field}`}
                  type={field === 'apiKey' ? 'password' : 'text'}
                  autoComplete="off"
                  required={field !== 'apiKey' || !editing?.hasApiKey}
                  value={draft[field] ?? ''}
                  maxLength={
                    field === 'apiKey'
                      ? 4096
                      : field === 'name'
                        ? 60
                        : field === 'baseUrl'
                          ? 500
                          : 120
                  }
                  placeholder={
                    field === 'apiKey' && editing?.hasApiKey ? key('keepKey') : undefined
                  }
                  onChange={(event) => update(field, event.target.value)}
                />
              </div>
            ))}
            {/* 什么时候走到这里：保存失败——弹层内展示脱敏错误信息 */}
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            )}
            <Button className="w-full" type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              {key('save')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      {/* 删除确认弹层：active=false 时强制关闭；确认按钮 preventDefault 阻止
          AlertDialog 的自动关闭行为，等删除请求成功后再由 onSuccess 清 deleting */}
      <AlertDialog
        open={active && Boolean(deleting)}
        onOpenChange={(value) => {
          if (!value) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{key('remove')}</AlertDialogTitle>
            <AlertDialogDescription>{key('removeHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          {/* 什么时候走到这里：删除请求失败——确认弹层内展示错误 */}
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{key('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (deleting) remove.mutate(deleting.id);
              }}
            >
              {remove.isPending && <Loader2 className="animate-spin" />}
              {key('remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
