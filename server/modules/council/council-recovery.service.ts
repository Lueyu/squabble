import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isNull, and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilSessions } from '../../database/council.schema';
import { councilMemberAttempts, councilRecoveryRequests } from '../../database/simple-council.schema';
import type { ResearchRecoveryInput } from '../../../shared/research-execution.interface';

/** Persist the user's recovery intent once before any call is allowed. */
export class CouncilRecoveryService {
  constructor(private readonly db:PostgresJsDatabase){}
  async reserve(owner:string,sessionId:string,input:ResearchRecoveryInput){
    const inputHash=createHash('sha256').update(JSON.stringify({sessionId,...input})).digest('hex');
    return this.db.transaction(async tx=>{
      const [session]=await tx.select().from(councilSessions).where(and(isNull(councilSessions.deletedAt), eq(councilSessions.owner,owner),eq(councilSessions.id,sessionId))).for('update');
      if(!session)throw new NotFoundException('Research conversation not found');
      const [prior]=await tx.select().from(councilRecoveryRequests).where(and(eq(councilRecoveryRequests.owner,owner),eq(councilRecoveryRequests.requestKey,input.requestKey)));
      if(prior){if(prior.inputHash!==inputHash)throw new ConflictException('REQUEST_KEY_CONFLICT');return{created:false,session,attempt:null};}
      if(session.revision!==input.expectedRevision)throw new ConflictException('RESEARCH_REVISION_CHANGED');
      const member=session.profileSnapshot.council?.members.find(m=>m.id===input.memberId);
      if(!member)throw new BadRequestException('MEMBER_NOT_IN_CONVERSATION');
      const [attempt]=await tx.select().from(councilMemberAttempts).where(and(eq(councilMemberAttempts.owner,owner),eq(councilMemberAttempts.sessionId,sessionId),
        eq(councilMemberAttempts.cycleId,session.checkpoint!.cycleId),eq(councilMemberAttempts.memberId,input.memberId))).orderBy(desc(councilMemberAttempts.attempt)).limit(1);
      if(!attempt)throw new BadRequestException('LEGACY_TASK_DETAILS_UNAVAILABLE');
      if(input.action==='retry_member'&&(!['failed','cancelled','skipped'].includes(attempt.status)||attempt.failure?.recoveries.includes('check_existing')))throw new ConflictException('ORIGINAL_TASK_NOT_TERMINATED');
      if(input.action==='reparse_existing'&&(!attempt.rawText||attempt.resultAcceptance!=='rejected'||attempt.status!=='completed'))throw new ConflictException('NO_COMPLETED_RESULT_TO_REPARSE');
      await tx.insert(councilRecoveryRequests).values({owner,requestKey:input.requestKey,inputHash,sessionId,memberId:input.memberId,attemptId:attempt.id,action:input.action});
      return{created:true,session,attempt};
    });
  }
}
