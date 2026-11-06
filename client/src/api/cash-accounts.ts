import http from './http';
import type { CashAccount,Currency } from '@shared/api.interface';
export const cashAccountsApi={
  list:async()=>(await http.get<{items:CashAccount[]}>('/api/cash')).data.items,
  confirm:async(input:{requestKey:string;balances:Array<{currency:Currency;balance:number;expectedUpdatedAt:string}>})=>
    (await http.post<{items:CashAccount[]}>('/api/cash/confirm',input)).data.items,
};
