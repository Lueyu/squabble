import type { ResearchSource } from './research-tools.interface';

export type ResearchEventStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable';
/** Public activity only. Never include private reasoning blocks, raw inputs, stderr or credentials. */
export interface ResearchActivity {
  id: string; kind: 'task' | 'tool' | 'summary' | 'capability'; status: ResearchEventStatus;
  at: string; summary: string; toolName?: string; callId?: string; durationMs?: number;
  sources?: ResearchSource[];
}
export interface ResearchEvent extends ResearchActivity {
  attempt?: number; cycleId?: string;
  sequence: number; taskId: string; sessionId: string; revision: number;
  memberId: string; memberName: string; turn: number;
}
export interface ResearchEventPage { events: ResearchEvent[]; cursor: number; truncated: boolean }
