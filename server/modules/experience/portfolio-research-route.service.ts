import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LlmService } from '../multi-agent/llm.service';
import { SettingsService } from '../settings/settings.service';
import type { ModelRoute } from '../../../shared/model-route.interface';

@Injectable()
export class PortfolioResearchRouteService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db:PostgresJsDatabase,private readonly agents:LocalAgentsService,
    private readonly settings:SettingsService,private readonly llm:LlmService){}
  async resolve(owner:string):Promise<{route:ModelRoute;label:string;busy:boolean;fingerprint:unknown}|null>{
    const [prefs]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
    const allowed=(id:string)=>!prefs?.defaultMembers.length||prefs.defaultMembers.includes(id);
    const selected=await this.settings.getDefaultModelRoute(owner);
    const overrides={...prefs?.memberSettings};
    if(selected.mode==='local'&&selected.agentSettings&&!overrides[selected.agentId])overrides[selected.agentId]=selected.agentSettings;
    const items=await this.agents.readiness(owner,overrides).catch(()=>[]);
    const local=items.filter(i=>allowed(i.connectionId)&&i.connected&&i.route&&(i.executable||i.state==='busy'))
      .sort((a,b)=>Number(a.busy)-Number(b.busy))[0];
    if(local?.route)return {route:local.route,label:local.name,busy:local.busy,fingerprint:{route:local.route,model:local.effectiveModel}};
    if(allowed('default')&&selected.mode==='api'&&await this.llm.isConfigured(owner,undefined,selected)){
      const info=await this.llm.getExecutionInfo(owner,selected);
      return {route:selected,label:info?.modelSlow??'AI',busy:false,fingerprint:info};
    }
    return null;
  }
}
