import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CashAccount,Currency } from '@shared/api.interface';
import { cashAccountsApi } from '@/api/cash-accounts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';

export default function CashBalanceDialog({open,onClose}:{open:boolean;onClose:()=>void}) {
  return open?<CashDialog onClose={onClose}/>:null;
}
function CashDialog({onClose}:{onClose:()=>void}) {
  const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh');
  const query=useQuery({queryKey:['cash-balances'],queryFn:cashAccountsApi.list,retry:false});
  return <Dialog open onOpenChange={v=>{if(!v)onClose();}}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
    <DialogHeader><DialogTitle>{zh?'核对账户现金':'Confirm account cash'}</DialogTitle><DialogDescription>{zh?'填写当前账户实际现金。这里只校准余额；买卖、入金和出金请记一笔交易。':'Enter your actual cash balances. This reconciles balances; record trades, deposits and withdrawals separately.'}</DialogDescription></DialogHeader>
    {query.data?<CashForm rows={query.data} onClose={onClose}/>:<p role={query.isError?'alert':'status'}>{query.isError?(zh?'现金暂时无法读取，请稍后重试。':'Cash is unavailable. Please retry later.'):(zh?'正在读取现金…':'Loading cash…')}</p>}
  </DialogContent></Dialog>;
}
function CashForm({rows,onClose}:{rows:CashAccount[];onClose:()=>void}) {
  const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh'),client=useQueryClient();
  const [baseline]=useState(rows);
  const [values,setValues]=useState<Record<string,string>>(()=>Object.fromEntries(baseline.map(r=>[r.currency,r.reconciliationStatus==='confirmed'?r.balance:''])));
  const [zero,setZero]=useState(false),[requestKey]=useState(()=>crypto.randomUUID());
  const changed=rows.length!==baseline.length||baseline.some(b=>rows.find(r=>r.currency===b.currency)?.updatedAt!==b.updatedAt);
  const valid=!changed&&baseline.length>0&&baseline.every(row=>{const v=values[row.currency]?.trim();return v?Number.isFinite(Number(v))&&Number(v)>=0:zero;});
  const save=useMutation({mutationFn:()=>cashAccountsApi.confirm({requestKey,balances:baseline.map(r=>({currency:r.currency as Currency,balance:Number(values[r.currency]||0),expectedUpdatedAt:r.updatedAt}))}),
    onSuccess:()=>{void client.invalidateQueries({queryKey:['today']});void client.invalidateQueries({queryKey:['cash-balances']});void client.invalidateQueries({queryKey:['ai-investment']});onClose();},retry:false});
  return <form className="space-y-4" onSubmit={e=>{e.preventDefault();if(valid&&!save.isPending)save.mutate();}}>
    <div className="grid gap-3 sm:grid-cols-3">{rows.map(row=><label key={row.currency} className="space-y-2 text-sm"><span className="font-medium">{row.currency}</span><Input aria-label={`${row.currency} ${zh?'现金余额':'cash balance'}`} type="number" min="0" step="any" placeholder={zh?'待确认':'Unconfirmed'} value={values[row.currency]??''} onChange={e=>setValues(v=>({...v,[row.currency]:e.target.value}))}/>{row.reconciliationStatus==='review'&&<span className="block text-xs text-amber-600">{zh?'历史记录有冲突，请填写实际余额。':'Conflicting records: enter the actual balance.'}</span>}</label>)}</div>
    <label className="flex items-start gap-2 text-sm leading-6"><input className="mt-1" type="checkbox" checked={zero} onChange={e=>setZero(e.target.checked)}/><span>{zh?'我确认未填写的币种现金为 0。':'I confirm any blank currency balance is zero.'}</span></label>
    {(save.isError||changed)&&<p role="alert" className="text-sm text-destructive">{zh?'余额可能已变化。请关闭后重新核对，重复提交不会重复入金。':'Balances may have changed. Close and review again; retry does not add a deposit.'}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>{zh?'取消':'Cancel'}</Button><Button disabled={!valid||save.isPending}>{save.isPending?(zh?'正在保存…':'Saving…'):(zh?'确认余额':'Confirm balances')}</Button></div>
  </form>;
}
