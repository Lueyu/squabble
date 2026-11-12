import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isAxiosError } from 'axios';
import type { AiInvestmentPreview } from '@shared/investment-policy.interface';
import { previewAiInvestment } from '@/api/ai-investment';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createRequestIntent } from '@/utils/simple-experience';
import { portfolioWorkspaceError } from '@/utils/portfolio-workspace';
import { simulationAccountPath } from '@/utils/portfolio-workspace';
import StartInvestmentCard from './StartInvestmentCard';
import type { CreatePortfolioAccountRequest, PortfolioCompanionId } from '@shared/portfolio-workspace.interface';
import CompanionPicker from '@/features/companions/CompanionPicker';
import CompanionIdentity from '@/features/companions/CompanionIdentity';
import CustomSeedFields from '@/features/companions/CustomSeedFields';
import { accountSeedInput, type AccountSeedOrigin, type SeedCurrency, type SeedPositionInput } from '@/features/companions/account-starting-points';

export default function CreateSimulationAccount({
  onClose,
  initialCompanionId = 'value',
  initialOrigin = 'cash',
}: {
  onClose: () => void;
  initialCompanionId?: PortfolioCompanionId;
  initialOrigin?: AccountSeedOrigin;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState<AccountSeedOrigin>(initialOrigin);
  const [companionId, setCompanionId] = useState<PortfolioCompanionId>(initialCompanionId);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'HKD' | 'CNY'>('USD');
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [positions, setPositions] = useState<SeedPositionInput[]>([{ id: 'first', ticker: '', shares: '', cost: '' }]);
  const [cash, setCash] = useState<Partial<Record<SeedCurrency, string>>>({});
  const accounts = useQuery({ queryKey: portfolioWorkspaceKeys.accounts, queryFn: portfolioWorkspaceApi.accounts, enabled: origin === 'account' });
  const seedInput = accountSeedInput({ origin, amount, currency, sourceAccountId, positions, cash });
  const [preview, setPreview] = useState<AiInvestmentPreview | null>(null);
  const createdAccountId = useRef<string | null>(null);
  const pendingCreation = useRef<CreatePortfolioAccountRequest | null>(null);
  const [creationUnconfirmed, setCreationUnconfirmed] = useState(false);
  const [companionIncomplete, setCompanionIncomplete] = useState(false);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const createIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const companionIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const prepare = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!seedInput) throw new Error(zh ? '请补全有效的账户起点。' : 'Complete a valid starting point.');
      const result = await previewAiInvestment({
        ...seedInput,
        requestKey: intent.current.keyFor(seedInput),
      });
      intent.current.complete();
      return result;
    },
    onSuccess: setPreview,
  });
  const create = useMutation({
    mutationFn: portfolioWorkspaceApi.create,
    retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: portfolioWorkspaceKeys.accounts,
      });
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending && !prepare.isPending) onClose();
      }}
    >
      <DialogContent className="companion-create-dialog max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {zh ? '新建模拟账户' : 'Create a simulation account'}
          </DialogTitle>
          <DialogDescription>
            {zh
              ? '独立的资金、持仓和策略组合，从你确认的起点开始。'
              : 'Independent funds, holdings and strategies, starting from a reviewed seed.'}
          </DialogDescription>
        </DialogHeader>
        <ol className="companion-steps" aria-label={zh ? '创建步骤' : 'Creation steps'}>
          <li aria-current={!preview ? 'step' : undefined}>1 · {zh ? '账户风格与起点' : 'Account style & seed'}</li>
          <li aria-current={preview ? 'step' : undefined}>2 · {zh ? '核对并创建' : 'Review & create'}</li>
        </ol>
        <label className="space-y-2 text-sm">
          <span>{zh ? '账户名称' : 'Account name'}</span>
          <Input
            value={name}
            maxLength={80}
            disabled={create.isPending || creationUnconfirmed || !!createdAccountId.current}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              zh ? '给这份投资想法起个名字' : 'Name this investment idea'
            }
          />
        </label>
        {!preview ? (
          <div className="space-y-5">
            <CompanionPicker value={companionId} onChange={setCompanionId} zh={zh} disabled={prepare.isPending} />
            <p className="text-xs leading-6 text-muted-foreground">{zh ? '账户风格用于区分模拟实验。账户建立后，再把你的想法聊成可核对的策略。' : 'Account styles help distinguish your simulations. After creating the account, clarify your ideas into a reviewable strategy.'}</p>
            <div
              className="companion-seed-options"
              aria-label={zh ? '选择起点' : 'Choose starting point'}
            >
              {([
                ['holdings', zh ? '复制真实持仓' : 'Copy real holdings'],
                ['cash', zh ? '使用模拟现金' : 'Start with virtual cash'],
                ['account', zh ? '复制现有模拟仓' : 'Copy a simulation account'],
                ['custom', zh ? '自定义初始持仓' : 'Custom opening holdings'],
              ] as const).map(([value, label]) => <Button key={value}
                disabled={prepare.isPending} variant={origin === value ? 'default' : 'outline'}
                aria-pressed={origin === value} onClick={() => setOrigin(value)}>{label}</Button>)}
            </div>
            {origin === 'cash' && (
              <div className="grid grid-cols-[1fr_110px] gap-3">
                <label className="space-y-2 text-sm">
                  <span>{zh ? '模拟现金' : 'Virtual cash'}</span>
                  <Input
                    type="number"
                    disabled={prepare.isPending}
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </label>
                <label className="space-y-2 text-sm">
                  <span>{zh ? '币种' : 'Currency'}</span>
                  <Select
                    disabled={prepare.isPending}
                    value={currency}
                    onValueChange={(value) => {
                      if (value === 'USD' || value === 'HKD' || value === 'CNY')
                        setCurrency(value);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['USD', 'HKD', 'CNY'].map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </div>
            )}
            {origin === 'account' && <div className="space-y-3">
              <label className="block space-y-2 text-sm"><span>{zh ? '复制哪个模拟仓的当前持仓' : 'Source simulation account'}</span>
                <Select value={sourceAccountId} onValueChange={setSourceAccountId} disabled={prepare.isPending || accounts.isPending}>
                  <SelectTrigger><SelectValue placeholder={zh ? '选择你的模拟仓' : 'Choose your account'} /></SelectTrigger>
                  <SelectContent>{accounts.data?.map(account => <SelectItem key={account.id} value={account.id}>{account.name}{account.status === 'archived' ? zh ? ' · 已归档' : ' · Archived' : ''}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              {accounts.isPending && <p role="status" className="text-sm">{zh ? '正在读取账户…' : 'Loading accounts…'}</p>}
              {accounts.isError && <p role="alert" className="text-sm">{zh ? '账户暂未读取。' : 'Accounts could not be loaded.'} <Button variant="ghost" onClick={() => void accounts.refetch()}>{zh ? '重试' : 'Retry'}</Button></p>}
              {!accounts.isPending && !accounts.isError && accounts.data?.length === 0 && <p className="text-sm text-muted-foreground">{zh ? '还没有可复制的模拟仓，可选择现金或自定义持仓。' : 'No simulation accounts to copy yet. Choose cash or custom holdings.'}</p>}
              <p className="text-xs leading-6 text-muted-foreground">{zh ? '预览冻结所选账户的当前数量与现金总额。原仓之后的变化不会同步，策略、待执行订单与历史成交不会复制；新仓重新核对策略后再运行。' : 'Preview freezes the selected account’s current quantities and total cash. Later changes, strategies, pending orders and historical trades do not carry over. Review a strategy before running the new account.'}</p>
            </div>}
            {origin === 'custom' && <CustomSeedFields positions={positions} onPositions={setPositions} cash={cash} onCash={setCash} zh={zh} disabled={prepare.isPending} />}
            <p className="text-sm leading-6 text-muted-foreground">
              {zh
                ? '先预览并核对现金与持仓。以可用的当前行情和汇率建立起点，向前观察，不是历史回测。'
                : 'Preview and check cash and holdings first. Available current quotes and FX establish a starting point for forward observation, with no historical backtest.'}
            </p>
            {prepare.isError && (
              <p role="alert" className="text-sm text-destructive">
                {portfolioWorkspaceError(prepare.error, zh, {
                  zh: '预览暂未完成，请重试。',
                  en: 'Preview could not be prepared. Retry.',
                })}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                disabled={
                  !name.trim() ||
                  prepare.isPending ||
                  !seedInput
                }
                onClick={() => prepare.mutate()}
              >
                {prepare.isPending
                  ? zh
                    ? '正在读取起点…'
                    : 'Preparing seed…'
                  : zh
                    ? '预览账户起点'
                    : 'Preview starting point'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
          <CompanionIdentity id={companionId} zh={zh} />
          {creationUnconfirmed && <div role="alert" className="rounded-lg border p-4 text-sm leading-6">{zh ? '创建结果尚未收到确认。重试会核对同一个创建请求，起点和名称已锁定，不会另建一个账户。' : 'The creation response is unconfirmed. Retry checks the same request with its frozen name and starting point, without creating another account.'}</div>}
          {companionIncomplete && createdAccountId.current && <div role="alert" className="rounded-lg border p-4 text-sm leading-6">
            <p>{zh ? '模拟账户已经创建，账户风格尚未确认保存。重试只会继续保存风格，不会再建账户。' : 'The simulation account was created. Retry saves the account style without creating another account.'}</p>
            <Link className="text-primary underline" to={simulationAccountPath(createdAccountId.current)} onClick={onClose}>{zh ? '先查看已创建的账户' : 'View the created account'}</Link>
          </div>}
          <StartInvestmentCard
            key={preview.id}
            preview={preview}
            createdAccount={!!createdAccountId.current}
            receiptPending={creationUnconfirmed}
            onCancel={() => { if (createdAccountId.current || creationUnconfirmed) onClose(); else setPreview(null); }}
            onRefresh={createdAccountId.current || creationUnconfirmed ? undefined : () => {
              setPreview(null);
              prepare.mutate();
            }}
            onCreate={async (request) => {
              if (!name.trim())
                throw Error(zh ? '请填写账户名称。' : 'Enter an account name.');
              const { requestKey: _seedRequestKey, ...seed } = request;
              const payload = { ...seed, name: name.trim() };
              if (!createdAccountId.current) {
                pendingCreation.current ??= { ...payload, requestKey: createIntent.current.keyFor(payload) };
                try {
                  const result = await create.mutateAsync(pendingCreation.current);
                  createIntent.current.complete();
                  createdAccountId.current = result.accountId;
                  setCreationUnconfirmed(false);
                } catch (error) {
                  // Only an explicit rejection proves that no receipt was committed.
                  const status = isAxiosError(error) ? error.response?.status : undefined;
                  const uncertain = !status || status >= 500;
                  setCreationUnconfirmed(uncertain);
                  if (!uncertain) pendingCreation.current = null;
                  throw error;
                }
              }
              const companion = { companionId, expectedRevision: 0 };
              try {
                await portfolioWorkspaceApi.setCompanion(createdAccountId.current, {
                  ...companion, requestKey: companionIntent.current.keyFor(companion),
                });
                companionIntent.current.complete();
                await client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts });
              } catch (error) {
                setCompanionIncomplete(true);
                throw error;
              }
            }}
            onStarted={() => {
              onClose();
              // Close the old setup URL before navigating to the acknowledged account.
              if (createdAccountId.current)
                navigate(simulationAccountPath(createdAccountId.current), { replace: true });
            }}
          />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
