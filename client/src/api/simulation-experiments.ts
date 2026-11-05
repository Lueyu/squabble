import http from './http';
import type { CreateSimulationExperiment, SimulationExperiment, SimulationPreview, SimulationReview } from '@shared/simulation-experiment.interface';
import type { ResearchDocumentVersion } from '@shared/research-document.interface';

export const listSimulationExperiments = async (): Promise<SimulationExperiment[]> => (await http.get('/api/paper/experiments')).data;
export const previewSimulationExperiment = async (): Promise<SimulationPreview> => (await http.post('/api/paper/experiments/preview')).data;
export const createSimulationExperiment = async (request: CreateSimulationExperiment): Promise<SimulationExperiment> => (await http.post('/api/paper/experiments', request)).data;
export const selectSimulationExperiment = async (id: string): Promise<SimulationExperiment> => (await http.post(`/api/paper/experiments/${encodeURIComponent(id)}/select`)).data;
export const exchangeSimulationCash = async (id: string, request: { from: string; to: string; amount: number }): Promise<SimulationExperiment> =>
  (await http.post(`/api/paper/experiments/${encodeURIComponent(id)}/exchange`, request)).data;
export const reviewSimulationExperiment = async (id: string, from?: string, to?: string): Promise<SimulationReview> =>
  (await http.get(`/api/paper/experiments/${encodeURIComponent(id)}/review`, { params: { from, to } })).data;
export const archiveSimulationReview = async (id: string, from: string, to: string): Promise<ResearchDocumentVersion> =>
  (await http.post(`/api/paper/experiments/${encodeURIComponent(id)}/review/archive`, { from, to })).data;
