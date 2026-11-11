import { ServiceUnavailableException } from '@nestjs/common';
import type { TeamCapabilities } from '../../../shared/team-workspace.interface';
function flag(value: string | undefined, name: string): boolean {
    if (value === undefined || value === '' || value === 'false')
        return false;
    if (value === 'true')
        return true;
    throw new Error(name + ' must be true or false');
}
export function teamCapabilities(): TeamCapabilities {
    return { workspaceEnabled: flag(process.env.TEAM_WORKSPACE_ENABLED, 'TEAM_WORKSPACE_ENABLED'),
        researchEnabled: flag(process.env.TEAM_RESEARCH_ENABLED, 'TEAM_RESEARCH_ENABLED') };
}
export function requireTeamFeature(research = false): void {
    const capabilities = teamCapabilities();
    if (!capabilities.workspaceEnabled || (research && !capabilities.researchEnabled))
        throw new ServiceUnavailableException({ code: 'TEAM_DEPENDENCY_UNAVAILABLE', message: 'Team workspace capability is disabled', retryable: false });
}
