import http from './http';
import type { StrategyDraftInput, StrategySourceInput, StrategySourceAddition, UserInvestmentStrategy, UserInvestmentStrategyWorkspace, UserInvestmentStrategyPage, UserInvestmentStrategyRevisionPage } from '@shared/user-investment-strategy.interface';
export type { StrategySourceInput } from '@shared/user-investment-strategy.interface';
const base = '/api/investment-strategies';
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
export const investmentStrategiesApi = {
  workspace: async () => (await http.get<UserInvestmentStrategyWorkspace>(base)).data,
  history: async (cursor?: string) => (await http.get<UserInvestmentStrategyPage>(`${base}/history`, { params: { cursor } })).data,
  drafts: async (cursor?: string) => (await http.get<UserInvestmentStrategyPage>(`${base}/drafts`, { params: { cursor } })).data,
  get: async (id: string) => (await http.get<UserInvestmentStrategy>(path(id))).data,
  create: async (content: StrategyDraftInput, parentId?: string) => (await http.post<UserInvestmentStrategy>(base, { content, parentId })).data,
  update: async (id: string, expectedRevision: number, content: StrategyDraftInput) => (await http.patch<UserInvestmentStrategy>(path(id), { expectedRevision, content })).data,
  revisions: async (id: string, before?: number) => (await http.get<UserInvestmentStrategyRevisionPage>(`${path(id)}/revisions`, { params: { before } })).data,
  sourcePreview: async (draftId: string | undefined, source: StrategySourceInput) => (await http.post<StrategySourceAddition>(`${base}/source-preview`, { draftId, source })).data,
  importSource: async (source: StrategySourceInput) => (await http.post<UserInvestmentStrategy>(`${base}/import-source`, { source })).data,
  addSource: async (id: string, input: { expectedRevision: number; source: StrategySourceInput }) => (await http.post<UserInvestmentStrategy>(`${path(id)}/add-source`, input)).data,
  preview: async (id: string, expectedRevision: number) => (await http.post<UserInvestmentStrategy>(`${path(id)}/preview`, { expectedRevision })).data,
  prepare: async (id: string, expectedRevision: number, requestKey:string = crypto.randomUUID()) => (await http.post<UserInvestmentStrategy>(`${path(id)}/prepare`, { expectedRevision, requestKey },{timeout:600000})).data,
  apply:async(input:{strategyId:string;expectedRevision:number;previewHash:string;expectedCurrentId:string|null;requestKey:string})=>
    (await http.post('/api/ai-investment/apply-strategy',input)).data,
};
