import http from './http';
import type { ExperiencePreferences, TodayView, CurrentResearchView } from '@shared/simple-experience.interface';

export const fetchExperiencePreferences = async (): Promise<ExperiencePreferences> =>
  (await http.get('/api/experience/preferences')).data;
export const saveExperiencePreferences = async (input: { defaultMembers?: string[]; timezone?: string; requestKey: string }): Promise<ExperiencePreferences> =>
  (await http.post('/api/experience/preferences', input)).data;
export const fetchToday = async (): Promise<TodayView> => (await http.get('/api/today')).data;
export const fetchCurrentResearch = async (topicKey: string, date?: string): Promise<CurrentResearchView> =>
  (await http.get('/api/research/current', { params: { topicKey, date } })).data;
export const refreshCurrentResearch = async (input: { topicKey: string; date?: string; requestKey: string; trigger?: 'first_open' }): Promise<CurrentResearchView> =>
  (await http.post('/api/research/current/refresh', input)).data;
