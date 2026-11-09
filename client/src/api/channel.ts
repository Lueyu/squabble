import http from './http';
import type {ChannelAction,ChannelBubble,ChannelProjection,ChannelVibe,DeferredQuestion,SupplementRequest,ChannelQuestionInput} from '@shared/channel.interface';

export type ChannelView=ChannelProjection & {userMessages?:Array<{id:string;text:string;createdAt:string;requestId?:string}>;notifications?:Array<{id:string;bubbleId:string}>};
export interface ChannelLog {id:string;kind:string;summary:string;createdAt:string;status?:string;toolName?:string;durationMs?:number}
export interface ChannelQuestionResult {request:SupplementRequest;bubble?:ChannelBubble;deferredQuestions:DeferredQuestion[]}
export const fetchChannel=async(accountId?:string):Promise<ChannelView>=>(await http.get('/api/channel',{params:accountId?{accountId}:undefined})).data;
export const fetchChannelLogs=async():Promise<{items:ChannelLog[]}>=>(await http.get('/api/channel/logs')).data;
export const fetchChannelPending=async(accountId?:string):Promise<{items:ChannelBubble[]}>=>(await http.get('/api/channel/pending',{params:accountId?{accountId}:undefined})).data;
export const setChannelVibe=async(vibe:ChannelVibe)=>(await http.post('/api/channel/preferences',{vibe})).data;
export const postChannelQuestion=async(input:ChannelQuestionInput):Promise<ChannelQuestionResult>=>
  (await http.post('/api/channel/questions',input,{timeout:90_000})).data;
export const postChannelAction=async(input:{actionId:string;bubbleId:string;expectedRevision:number;requestKey:string}):Promise<{navigation?:string;questionId?:string}>=>
  (await http.post('/api/channel/actions',input)).data;
export function channelActionRequest(action:ChannelAction,bubbleId:string,requestKey:string){
 return {actionId:action.id,bubbleId,expectedRevision:action.expectedRevision,requestKey};
}
export const fetchChannelBubble=async(id:string):Promise<ChannelBubble>=>(await http.get('/api/channel/bubbles/'+encodeURIComponent(id))).data;
export const acknowledgeChannelNotifications=async(ids:string[])=>(await http.post('/api/channel/notifications/ack',{ids})).data;
export interface ChannelMemoryView {
 items:import('@shared/channel.interface').RelationshipMemoryEvent[];
 decisions:Array<{id:string;label:string;createdAt:string}>;
 reflections:import('@shared/channel.interface').DecisionReflection[];
}
export const fetchChannelMemory=async():Promise<ChannelMemoryView>=>(await http.get('/api/channel/memory')).data;
export const saveChannelPreference=async(input:{sourceMessageId:string;requestKey:string})=>(await http.post('/api/channel/memory',input)).data;
export const saveChannelReflection=async(input:{decisionId:string;kind:'reason_at_adoption'|'later_reflection';text:string;requestKey:string})=>(await http.post('/api/channel/reflections',input)).data;
