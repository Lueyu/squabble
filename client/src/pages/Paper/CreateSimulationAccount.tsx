import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
import { validCashSeed } from '@/utils/ai-investment';
import { portfolioWorkspaceError } from '@/utils/portfolio-workspace';
import { simulationAccountPath } from '@/utils/portfolio-workspace';
import StartInvestmentCard from './StartInvestmentCard';

export default function CreateSimulationAccount({
  onClose,
}: {
  onClose: () => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState<'holdings' | 'cash'>('holdings');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'HKD' | 'CNY'>('USD');
  const [preview, setPreview] = useState<AiInvestmentPreview | null>(null);
  const createdAccountId = useRef<string | null>(null);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const createIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const prepare = useMutation({
    retry: false,
    mutationFn: async () => {
      const body =
        origin === 'cash'
          ? { origin, cash: { amount: Number(amount), currency } }
          : { origin };
      const result = await previewAiInvestment({
        ...body,
        requestKey: intent.current.keyFor(body),
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
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {zh ? '新建模拟账户' : 'New simulation account'}
          </DialogTitle>
          <DialogDescription>
            {zh
              ? '独立的资金、持仓和策略组合，从你确认的起点开始。'
              : 'Independent funds, holdings and strategies, starting from a reviewed seed.'}
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-2 text-sm">
          <span>{zh ? '账户名称' : 'Account name'}</span>
          <Input
            value={name}
            maxLength={80}
            disabled={create.isPending}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              zh ? '给这份投资想法起个名字' : 'Name this investment idea'
            }
          />
        </label>
        {!preview ? (
          <div className="space-y-5">
            <div
              className="flex flex-wrap gap-2"
              aria-label={zh ? '选择起点' : 'Choose starting point'}
            >
              <Button
                variant={origin === 'holdings' ? 'default' : 'outline'}
                aria-pressed={origin === 'holdings'}
                onClick={() => setOrigin('holdings')}
              >
                {zh ? '复制真实持仓' : 'Copy real holdings'}
              </Button>
              <Button
                variant={origin === 'cash' ? 'default' : 'outline'}
                aria-pressed={origin === 'cash'}
                onClick={() => setOrigin('cash')}
              >
                {zh ? '使用模拟现金' : 'Start with virtual cash'}
              </Button>
            </div>
            {origin === 'cash' && (
              <div className="grid grid-cols-[1fr_110px] gap-3">
                <label className="space-y-2 text-sm">
                  <span>{zh ? '模拟现金' : 'Virtual cash'}</span>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </label>
                <label className="space-y-2 text-sm">
                  <span>{zh ? '币种' : 'Currency'}</span>
                  <Select
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
            <p className="text-sm leading-6 text-muted-foreground">
              {zh
                ? '先预览并核对现金与持仓。创建后可编辑策略组合，真实交易不会自动同步。'
                : 'Preview and check cash and holdings first. Configure strategies after creation; later real trades do not sync.'}
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
                  (origin === 'cash' && !validCashSeed(amount, currency))
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
          <StartInvestmentCard
            key={preview.id}
            preview={preview}
            onCancel={() => setPreview(null)}
            onRefresh={() => {
              setPreview(null);
              prepare.mutate();
            }}
            onCreate={async (request) => {
              if (!name.trim())
                throw Error(zh ? '请填写账户名称。' : 'Enter an account name.');
              const { requestKey: _seedRequestKey, ...seed } = request;
              const payload = { ...seed, name: name.trim() };
              const result = await create.mutateAsync({
                ...payload,
                requestKey: createIntent.current.keyFor(payload),
              });
              createIntent.current.complete();
              createdAccountId.current = result.accountId;
            }}
            onStarted={() => {
              onClose();
              // Close the old setup URL before navigating to the acknowledged account.
              if (createdAccountId.current)
                navigate(simulationAccountPath(createdAccountId.current));
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
