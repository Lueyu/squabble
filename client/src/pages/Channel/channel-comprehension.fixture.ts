import type {ChannelBubble,ChannelProjection} from '@shared/channel.interface';

// Fictional fixed fixtures for contract rendering and moderated usability checks.
const at='2026-11-06T03:00:00Z';
function bubble(id:string,weight:'tap'|'nudge'|'poke',text:string):ChannelBubble{
 const base={id,ownerId:'fictional-owner',speaker:'xiaoqi' as const,episodeId:'episode-'+id,posture:'standalone' as const,
  anchors:{primary:{kind:'fact' as const,factId:'fact-'+id,factRevision:1},triggerEventId:'event-'+id},
  text,evidence:{id:'card-'+id,kind:'evidence' as const,summary:'A fictional checked source for this UI fixture.',sources:[{id:'source-'+id,kind:'filing' as const,title:'Fictional filing',uri:'/analysis/reports/fictional-report',publishedAt:at,observedAt:at,verification:'checked' as const}],asOf:at,gaps:[],supports:[{factId:'fact-'+id,scope:'The stated fictional fact only.'}]},
  templateId:'fixture-plain',templateRevision:1,semanticDeltaId:'delta-'+id,createdAt:at,deliveryCause:'monitor' as const};
 return {...base,stance:'plain_fact',weight,layer:weight==='tap'?2:weight==='poke'?4:3};
}
export function noStrategyFixture():ChannelProjection{
 return {runtime:{accountId:'fictional-paper',accountKind:'paper',revision:7,confirmedAt:at,monitoringStatus:'observing',monitoringReason:null,
  current:{strategyId:null,strategyRevision:null,rules:[],positions:[{symbol:'TEST',quantity:'10'}],cash:[{currency:'USD',amount:'500'}],valuationAsOf:at},
  proposals:[{id:'fictional-draft',revision:1,status:'proposed',before:'No active strategy',after:'A draft is not execution authority',reasonCardId:'draft-card'}],executions:[]},
  vibe:'deskmate',pinned:null,pendingCount:0,episodes:[],visibleTaps:[],progress:{runningCount:0,gapCount:0},report:null,deferredQuestions:[],sourcesAvailable:true};
}
export function worstLegalFixture():ChannelProjection{
 const view=noStrategyFixture();
 view.runtime.current.strategyId='S7';view.runtime.current.strategyRevision=7;view.runtime.monitoringStatus='running';
 view.runtime.current.rules=[{id:'rule7',label:'Current protection line',status:'active',value:'271',effective:true,effectiveReason:null}];
 view.runtime.proposals=[{id:'P8',revision:8,status:'applying',before:'271',after:'274',reasonCardId:'P8-card'}];
 view.runtime.executions=[{id:'O7',symbol:'TEST',strategyId:'S7',strategyRevision:7,status:'partially_filled',requestedQuantity:'100',filledQuantity:'40',remainingQuantity:'60',updatedAt:at}];
 const pin=bubble('decision','poke','One source is still unavailable. Decide whether to keep this separate review pending.');
 pin.action=[{id:'review-gap',kind:'snooze_episode',label:'Keep pending',targetId:pin.episodeId,expectedRevision:1}];
 pin.evidence.gaps=['The primary source for one premise is not available.'];
 view.pinned=pin;view.pendingCount=3;
 view.report={id:'fictional-report',title:'Fictional daily report',createdAt:at,href:'/analysis/reports/fictional-report'};
 view.progress={runningCount:2,gapCount:1};
 view.episodes=['one','two','three'].map((id,index)=>{const item=bubble(id,'nudge',('A verified distinction remains visible without changing the current simulated rule.').slice(0,90));return {episode:{id:item.episodeId,revision:1,entityId:'TEST-'+index,phase:'alarm' as const,severity:'important' as const,lastEventSequence:1,consumedDeltaIds:[item.semanticDeltaId],hadBreach:false,executionIds:[],userDecisionIds:[]},bubbles:[item]};});
 view.visibleTaps=['tap-one','tap-two','tap-three'].map(id=>bubble(id,'tap','A checked process update; no trade direction.'));
 view.deferredQuestions=[{id:'question-later',ownerId:'fictional-owner',originatingRequestId:'scope-request',text:'Which reporting period is used in the original filing?',status:'pending',createdAt:at}];
 return view;
}
