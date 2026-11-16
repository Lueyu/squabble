/**
 * Template instantiation lives in the shared package so the server create path
 * and the client preview/apply path execute the exact same UUID remapping.
 * This module is the client entry point used by the unified creation flows.
 */
import { instantiateTemplate } from '@shared/team-template-instantiation';
import type { TeamTemplate } from '@shared/team-templates';
import type { TeamEditorState } from './team-graph';
export { instantiateOrganization, instantiateTemplate } from '@shared/team-template-instantiation';
export type { InstantiatedOrganization } from '@shared/team-template-instantiation';

/**
 * Apply a template to the current draft organization: the whole config, role
 * labels and layout positions are replaced with a freshly instantiated copy
 * (new UUIDs, stable work ids), while the draft identity (name/avatar) and any
 * other display fields are preserved. Pure: returns a new state, never mutates.
 */
export function draftWithTemplate(state: TeamEditorState, template: TeamTemplate, generate?: () => string): TeamEditorState {
  const instantiated = instantiateTemplate(template, generate);
  return {
    ...state,
    config: instantiated.config,
    display: { ...state.display, departmentLabels: instantiated.display.departmentLabels, roleLabels: instantiated.display.roleLabels },
    layout: instantiated.layout,
  };
}
