import type { TeamDisplay, TeamLayout, TeamSemanticConfig } from './team-workspace.interface';
import type { TeamTemplate, TeamTemplateStaffingSlot } from './team-templates';

export interface InstantiatedOrganization {
  config: TeamSemanticConfig;
  display: TeamDisplay;
  layout: TeamLayout;
  /** Present only when the source template carries staffing slots; roleIds are remapped to the instance. */
  staffing?: TeamTemplateStaffingSlot[];
}

interface InstantiateOptions {
  staffing?: readonly TeamTemplateStaffingSlot[];
  generate?: () => string;
}

function defaultGenerate(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  throw new Error('crypto.randomUUID is required to instantiate an organization');
}

/**
 * Copy an organization into a fresh instance in one pass: every template-local
 * UUID in config (departments, roles, relations, defaults, workBlueprint) and in
 * display/layout dictionaries is replaced with a generated id. workId and
 * dependencyWorkIds stay stable task keys inside the instance; no reference may
 * point back at the template, and no grant survives a copy.
 */
export function instantiateOrganization(config: TeamSemanticConfig, display: TeamDisplay, layout: TeamLayout, options: InstantiateOptions = {}): InstantiatedOrganization {
  const generate = options.generate ?? defaultGenerate;
  const ids = new Map([...config.departments, ...config.roles, ...config.relations].map(node => [node.id, generate()]));
  const remap = (id: string | null): string | null => (id ? (ids.get(id) ?? null) : null);
  function remapRecord<T>(record: Record<string, T>): Record<string, T> {
    const entries = Object.entries(record)
      .map(([key, value]) => [remap(key), value] as const)
      .filter((entry): entry is readonly [string, T] => entry[0] !== null);
    return Object.fromEntries(entries);
  }
  return {
    config: {
      ...config,
      departments: config.departments.map(department => ({ ...department, id: ids.get(department.id)!, parentDepartmentId: remap(department.parentDepartmentId) })),
      roles: config.roles.map(role => ({ ...role, id: ids.get(role.id)!, departmentId: remap(role.departmentId), sourceGrantIds: [] })),
      relations: config.relations.map(relation => ({ ...relation, id: ids.get(relation.id)!, fromRoleId: ids.get(relation.fromRoleId)!, toRoleId: ids.get(relation.toRoleId)! })),
      defaults: { ...config.defaults, leadRoleId: remap(config.defaults.leadRoleId) },
      workBlueprint: config.workBlueprint ? {
        schemaVersion: config.workBlueprint.schemaVersion,
        works: config.workBlueprint.works.map(work => ({ ...work, roleId: ids.get(work.roleId)!, reviewerRoleId: ids.get(work.reviewerRoleId)! })),
        summary: { ...config.workBlueprint.summary, reviewerRoleId: ids.get(config.workBlueprint.summary.reviewerRoleId)! },
      } : undefined,
    },
    display: { ...display, departmentLabels: remapRecord(display.departmentLabels), roleLabels: remapRecord(display.roleLabels) },
    layout: { ...layout, positions: remapRecord(layout.positions), collapsedDepartmentIds: layout.collapsedDepartmentIds.map(id => ids.get(id)!) },
    ...(options.staffing ? { staffing: options.staffing.map(slot => ({ ...slot, roleId: ids.get(slot.roleId)! })) } : {}),
  };
}

/** The single template entry point used by creation and by template application flows. */
export function instantiateTemplate(template: TeamTemplate, generate?: () => string): InstantiatedOrganization {
  return instantiateOrganization(template.config, template.display, template.layout, { staffing: template.staffing, generate });
}
