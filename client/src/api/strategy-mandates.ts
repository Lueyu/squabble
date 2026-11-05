import http from './http';
import type { StrategyMandate, StrategyMandateInput, StrategyMandateWorkspace } from '@shared/strategy-mandate.interface';
const base = '/api/strategy-mandates';
export const fetchStrategyMandates = async (accountId: string) => (await http.get<StrategyMandateWorkspace>(base, { params: { accountId } })).data;
export const fetchStrategyMandate = async (id: string) => (await http.get<StrategyMandate>(base + '/' + encodeURIComponent(id))).data;
export const rebindStrategyProfile = async (id: string, expectedRevision: number, expectedProfileVersion: number) =>
  (await http.post<StrategyMandate>(base + '/' + encodeURIComponent(id) + '/rebind-profile', { expectedRevision, expectedProfileVersion })).data;
export const createStrategyMandate = async (config: StrategyMandateInput, parentId?: string) => (await http.post<StrategyMandate>(base, { config, parentId })).data;
export const updateStrategyMandate = async (id: string, config: StrategyMandateInput, expectedRevision: number) =>
  (await http.put<StrategyMandate>(base + '/' + encodeURIComponent(id), { config, expectedRevision })).data;
export const extractStrategyMandate = async (id: string, expectedRevision: number) =>
  (await http.post<StrategyMandate>(base + '/' + encodeURIComponent(id) + '/extract', { expectedRevision })).data;
export const publishStrategyMandate = async (id: string, expectedRevision: number, expectedPublishedId: string | null) =>
  (await http.post<StrategyMandate>(base + '/' + encodeURIComponent(id) + '/publish', { expectedRevision, expectedPublishedId, activateExecution: true })).data;
export const pauseStrategyMandate = async (id: string) => (await http.post<StrategyMandate>(base + '/' + encodeURIComponent(id) + '/pause')).data;
export const cancelStrategyExtraction = async (id: string, expectedRevision: number) =>
  (await http.post<StrategyMandate>(base + '/' + encodeURIComponent(id) + '/cancel-extraction', { expectedRevision })).data;
