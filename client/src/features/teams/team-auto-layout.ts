import type { TeamLayout, TeamSemanticConfig } from '@shared/team-workspace.interface';

export const LAYOUT_METRICS = {
  cardWidth: 220,
  cardHeight: 154,
  departmentPadding: 24,
  departmentTitle: 48,
  nodeGap: 24,
  rootGap: 40,
  collapsedWidth: 280,
  collapsedHeight: 72,
  minEmptyWidth: 280,
  minEmptyHeight: 180,
  contentX: 24,
  contentY: 48 + 24,
} as const;

interface LayoutObject {
  id: string;
  department: boolean;
}

const metrics = LAYOUT_METRICS;
const cardSize = { width: metrics.cardWidth, height: metrics.cardHeight };

function reportingManagers(config: TeamSemanticConfig, parents: Map<string, string | null>) {
  const paths = new Map(config.roles.map(({ id }) => {
    const path = new Set<string>();
    let current: string | null = id;
    while (current && !path.has(current)) {
      path.add(current);
      current = parents.get(current) ?? null;
    }
    return [id, [...path].reverse()];
  }));
  const managers = new Map<string, Set<string>>();
  for (const relation of config.relations) {
    if (relation.kind !== 'reports_to') continue;
    const reportPath = paths.get(relation.fromRoleId);
    const managerPath = paths.get(relation.toRoleId);
    if (!reportPath || !managerPath) continue;
    // Compare the first two distinct siblings so departments move as intact blocks.
    const branch = reportPath.findIndex((id, index) => id !== managerPath[index]);
    const manager = managerPath[branch];
    if (branch < 0 || !manager) continue;
    const report = reportPath[branch];
    const list = managers.get(report) ?? new Set<string>();
    list.add(manager);
    managers.set(report, list);
  }
  return managers;
}

function reportingRanks(objects: LayoutObject[], managers: Map<string, Set<string>>) {
  const reachable = new Map<string, Set<string>>();
  for (const { id } of objects) {
    const seen = new Set([id]);
    const pending = [id];
    for (const current of pending) {
      for (const manager of managers.get(current) ?? []) {
        if (seen.has(manager)) continue;
        seen.add(manager);
        pending.push(manager);
      }
    }
    reachable.set(id, seen);
  }

  // Opposing cross-department reports can form a cycle even when the role graph
  // is acyclic. Give the whole group one rank and keep its external constraints.
  const groupOf = new Map(objects.map(({ id }) => {
    const group = objects.find(other => reachable.get(id)?.has(other.id) && reachable.get(other.id)?.has(id));
    return [id, group?.id ?? id];
  }));
  const groupManagers = new Map<string, Set<string>>();
  for (const [id, group] of groupOf) {
    const upstream = groupManagers.get(group) ?? new Set<string>();
    for (const manager of managers.get(id) ?? []) {
      const managerGroup = groupOf.get(manager);
      if (managerGroup && managerGroup !== group) upstream.add(managerGroup);
    }
    groupManagers.set(group, upstream);
  }

  const ranks = new Map<string, number>();
  function rank(group: string): number {
    const known = ranks.get(group);
    if (known !== undefined) return known;
    const value = Math.max(0, ...Array.from(groupManagers.get(group) ?? [], manager => rank(manager) + 1));
    ranks.set(group, value);
    return value;
  }
  return new Map(objects.map(({ id }) => [id, rank(groupOf.get(id) ?? id)]));
}

function arrange(config: TeamSemanticConfig, layout: TeamLayout, positions: TeamLayout['positions']): TeamLayout {
  const children = new Map<string | null, LayoutObject[]>();
  const parents = new Map<string, string | null>();
  function add(id: string, parent: string | null, department: boolean) {
    const siblings = children.get(parent) ?? [];
    siblings.push({ id, department });
    children.set(parent, siblings);
    parents.set(id, parent);
  }
  config.roles.forEach(role => add(role.id, role.departmentId, false));
  config.departments.forEach(department => add(department.id, department.parentDepartmentId, true));
  const managers = reportingManagers(config, parents);
  const lead = config.defaults.leadRoleId;

  function fill(parent: string | null) {
    const siblings = children.get(parent) ?? [];
    const ranks = reportingRanks(siblings, managers);
    const sizes = new Map(siblings.map((item) => {
      if (!item.department) return [item.id, cardSize];
      const content = fill(item.id);
      const stored = positions[item.id];
      return [item.id, {
        width: stored ? stored.width ?? 600 : Math.max(metrics.minEmptyWidth, content.right + metrics.departmentPadding),
        height: stored ? stored.height ?? 400 : Math.max(metrics.minEmptyHeight, content.bottom + metrics.departmentPadding),
      }];
    }));
    const rankOf = (id: string) => ranks.get(id) ?? 0;
    const rootLead = parent === null ? lead : null;
    const missing = siblings.filter(({ id }) => !positions[id]).sort((a, b) =>
      rankOf(a.id) - rankOf(b.id)
      || Number(a.department) - Number(b.department)
      || Number(b.id === lead) - Number(a.id === lead)
      || a.id.localeCompare(b.id));
    let right = 0;
    let bottom = 0;
    for (const { id } of siblings) {
      const stored = positions[id];
      if (!stored) continue;
      const size = sizes.get(id) ?? cardSize;
      right = Math.max(right, stored.x + size.width);
      bottom = Math.max(bottom, stored.y + size.height);
    }

    let y = Math.max(parent === null ? metrics.contentX : metrics.contentY, bottom + metrics.nodeGap);
    let x = metrics.contentX;
    let rowHeight = 0;
    let columns = 0;
    missing.forEach((item, index) => {
      const size = sizes.get(item.id) ?? cardSize;
      positions[item.id] = item.department ? { x, y, ...size } : { x, y };
      right = Math.max(right, x + size.width);
      bottom = Math.max(bottom, y + size.height);
      const next = missing[index + 1];
      columns++;
      rowHeight = Math.max(rowHeight, size.height);
      if (columns === 2 || !next || item.id === rootLead || item.department !== next.department || rankOf(item.id) !== rankOf(next.id)) {
        y += rowHeight + (item.id === rootLead ? metrics.rootGap : metrics.nodeGap);
        x = metrics.contentX;
        rowHeight = 0;
        columns = 0;
      } else {
        x += size.width + metrics.nodeGap;
      }
    });
    return { right, bottom };
  }

  fill(null);
  return { ...layout, positions };
}

/** Explicit auto layout replaces positions while preserving viewport and collapsed state. */
export function autoLayout(config: TeamSemanticConfig, layout: TeamLayout): TeamLayout {
  return arrange(config, layout, {});
}

/** Legacy fallback preserves stored positions and appends missing siblings below them. */
export function ensureVisiblePositions(config: TeamSemanticConfig, layout: TeamLayout): TeamLayout {
  return arrange(config, layout, { ...layout.positions });
}
