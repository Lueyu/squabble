import http from './http';
import type {
  StrategyInterviewView,
  StrategyInterviewPreview,
  CreateStrategyInterviewInput,
  AnswerStrategyInterviewInput,
  AcceptStrategyInterviewInput,
  PreviewStrategyInterviewInput,
} from '@shared/strategy-interview.interface';
const base = '/api/strategy-interviews';
function path(id: string) {
  if (!id.trim()) throw new Error('A strategy interview identity is required.');
  return base + '/' + encodeURIComponent(id);
}
export const strategyInterviewKeys = {
  list: (accountId?: string) =>
    ['strategy-interviews', accountId ?? 'all'] as const,
  item: (id: string) => ['strategy-interview', id] as const,
};
export const strategyInterviewsApi = {
  review: async (id: string) =>
    (await http.get<StrategyInterviewPreview>(path(id) + '/review')).data,
  list: async (accountId?: string) =>
    (await http.get<StrategyInterviewView[]>(base, { params: { accountId } }))
      .data,
  get: async (id: string) =>
    (await http.get<StrategyInterviewView>(path(id))).data,
  create: async (input: CreateStrategyInterviewInput) =>
    (await http.post<StrategyInterviewView>(base, input)).data,
  answer: async (id: string, input: AnswerStrategyInterviewInput) =>
    (await http.post<StrategyInterviewView>(path(id) + '/messages', input))
      .data,
  accept: async (id: string, input: AcceptStrategyInterviewInput) =>
    (await http.post<StrategyInterviewView>(path(id) + '/accept', input)).data,
  preview: async (id: string, input: PreviewStrategyInterviewInput) =>
    (await http.post<StrategyInterviewPreview>(path(id) + '/preview', input))
      .data,
};
