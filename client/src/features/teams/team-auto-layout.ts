import type { TeamDepartment, TeamLayout, TeamRole, TeamSemanticConfig } from '@shared/team-workspace.interface';

/**
 * Deterministic organization layout for the team canvas.
 * Only the layout (positions / collapsed / viewport) may change here — never the
 * semantic config. Same input always produces the same output, so an "auto layout"
 * is one undo unit and never depends on mouse history.
 *
 * Geometry follows the acceptance spec (05 §4):
 * - readable role card envelope 220 x 154
 * - department padding 24, title area 48
 * - node gap 24, root gap 40
 * - collapsed departments retain their expanded geometry for safe reopening;
 *   only the canvas presentation shrinks their visible shell
 * - empty department at least 280 x 180
 * - department content starts at x = 24, y = 48 + 24
 * - root lead at (24, 24); remaining root roles below it, max 2 per row
 * - at most 2 objects per row; row height is the tallest object in the row
 */

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

interface Size { width: number; height: number }
interface Position { x: number; y: number; width?: number; height?: number }

const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);

function rolesIn(config: TeamSemanticConfig, departmentId: string | null): TeamRole[] {
  const roles = config.roles.filter(r => (r.departmentId ?? null) === departmentId).sort(byId);
  const lead = config.defaults.leadRoleId ? roles.find(r => r.id === config.defaults.leadRoleId) : undefined;
  return lead ? [lead, ...roles.filter(r => r !== lead)] : roles;
}

function departmentsIn(config: TeamSemanticConfig, departmentId: string | null): TeamDepartment[] {
  return config.departments.filter(d => (d.parentDepartmentId ?? null) === departmentId).sort(byId);
}

/** Content block size of a row of at most two objects of the given sizes. */
function rowBlock(sizes: Size[]): Size {
  const width = sizes.reduce((sum, s, i) => sum + s.width + (i > 0 ? LAYOUT_METRICS.nodeGap : 0), 0);
  const height = sizes.reduce((max, s) => Math.max(max, s.height), 0);
  return { width, height };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Bottom-up measurement of a department's shell, children included. */
function measureDepartment(config: TeamSemanticConfig, id: string, sizes: Map<string, Size>): Size {
  const roles = rolesIn(config, id).length;
  const children = departmentsIn(config, id).map(d => measureDepartment(config, d.id, sizes));
  const roleRows = chunks(Array.from({ length: roles }), 2);
  const roleBlock = roleRows.length
    ? { width: Math.max(...roleRows.map(row => rowBlock(row.map(() => ({ width: LAYOUT_METRICS.cardWidth, height: LAYOUT_METRICS.cardHeight }))).width)), height: roleRows.length * LAYOUT_METRICS.cardHeight + (roleRows.length - 1) * LAYOUT_METRICS.nodeGap }
    : { width: 0, height: 0 };
  const childRows = chunks(children, 2).map(row => rowBlock(row));
  const childrenBlock = childRows.length
    ? { width: Math.max(...childRows.map(r => r.width)), height: childRows.reduce((sum, r, i) => sum + r.height + (i > 0 ? LAYOUT_METRICS.nodeGap : 0), 0) }
    : { width: 0, height: 0 };
  const contentWidth = Math.max(roleBlock.width, childrenBlock.width);
  const contentHeight = roleBlock.height + (roleBlock.height && childrenBlock.height ? LAYOUT_METRICS.nodeGap : 0) + childrenBlock.height;
  const size = {
    width: Math.max(LAYOUT_METRICS.contentX + contentWidth + LAYOUT_METRICS.departmentPadding, LAYOUT_METRICS.minEmptyWidth),
    height: Math.max(LAYOUT_METRICS.contentY + contentHeight + LAYOUT_METRICS.departmentPadding, LAYOUT_METRICS.minEmptyHeight),
  };
  sizes.set(id, size);
  return size;
}

/** Top-down placement of a container's direct children. `origin` is the container's absolute top-left. */
function placeContainer(config: TeamSemanticConfig, containerId: string | null, originX: number, originY: number, sizes: Map<string, Size>, positions: Record<string, Position>): void {
  const roles = rolesIn(config, containerId);
  const children = departmentsIn(config, containerId);
  const isRoot = containerId === null;
  const contentX = LAYOUT_METRICS.contentX;
  const contentY = isRoot ? 24 : LAYOUT_METRICS.contentY;

  if (isRoot) {
    // Root lead on the first row; remaining root roles start one card height below with a root gap.
    if (roles.length) {
      const lead = roles[0];
      positions[lead.id] = { x: contentX, y: 24 };
      roles.slice(1).forEach((r, index) => {
        positions[r.id] = { x: contentX + (index % 2) * (LAYOUT_METRICS.cardWidth + LAYOUT_METRICS.nodeGap), y: 24 + LAYOUT_METRICS.cardHeight + LAYOUT_METRICS.rootGap + Math.floor(index / 2) * (LAYOUT_METRICS.cardHeight + LAYOUT_METRICS.nodeGap) };
      });
    }
  } else {
    // Stored coordinates are relative to the semantic parent, so a role inside a
    // department starts at (24, 72) of that department regardless of nesting.
    roles.forEach((r, index) => {
      positions[r.id] = { x: contentX + (index % 2) * (LAYOUT_METRICS.cardWidth + LAYOUT_METRICS.nodeGap), y: contentY + Math.floor(index / 2) * (LAYOUT_METRICS.cardHeight + LAYOUT_METRICS.nodeGap) };
    });
  }

  const rolesBottom = roles.length
    ? (isRoot
        ? Math.max(...roles.map(r => positions[r.id].y + LAYOUT_METRICS.cardHeight))
        : originY + contentY + Math.ceil(roles.length / 2) * LAYOUT_METRICS.cardHeight + (Math.ceil(roles.length / 2) - 1) * LAYOUT_METRICS.nodeGap)
    : (isRoot ? 24 : originY + contentY);

  if (children.length) {
    let rowY = isRoot ? rolesBottom + (roles.length ? LAYOUT_METRICS.rootGap : 0) : rolesBottom + (roles.length ? LAYOUT_METRICS.nodeGap : 0);
    let rowX = originX + contentX;
    let rowHeight = 0;
    children.forEach((d, index) => {
      const size = sizes.get(d.id) ?? { width: LAYOUT_METRICS.minEmptyWidth, height: LAYOUT_METRICS.minEmptyHeight };
      const absolute = { x: rowX, y: rowY };
      positions[d.id] = { x: absolute.x - originX, y: absolute.y - originY, width: size.width, height: size.height };
      placeContainer(config, d.id, absolute.x, absolute.y, sizes, positions);
      rowHeight = Math.max(rowHeight, size.height);
      if (index % 2 === 1 || index === children.length - 1) {
        rowY += rowHeight + LAYOUT_METRICS.nodeGap;
        rowHeight = 0;
      }
      rowX += size.width + LAYOUT_METRICS.nodeGap;
      if (index % 2 === 1) rowX = originX + contentX;
    });
  }
}

/**
 * Full deterministic re-layout: recomputes every department shell and every role
 * position from the semantic config. Existing custom positions are replaced (the
 * caller offers undo); collapsed departments and the viewport are preserved.
 */
export function autoLayout(config: TeamSemanticConfig, layout: TeamLayout): TeamLayout {
  const sizes = new Map<string, Size>();
  config.departments.forEach(d => measureDepartment(config, d.id, sizes));
  const positions: Record<string, Position> = {};
  placeContainer(config, null, 0, 0, sizes, positions);
  return { ...layout, positions };
}

/**
 * Read-only fallback for legacy teams that lack stored positions: keeps every
 * stored coordinate untouched and only appends deterministic grid positions for
 * the missing nodes after their container's existing bounding box. This never
 * writes to the server — the caller decides whether the result is saved.
 */
export function ensureVisiblePositions(config: TeamSemanticConfig, layout: TeamLayout): TeamLayout {
  const positions = { ...layout.positions };
  const sizes = new Map<string, Size>();
  config.departments.forEach(d => measureDepartment(config, d.id, sizes));

  const placeMissingIn = (containerId: string | null): void => {
    const roles = rolesIn(config, containerId);
    const children = departmentsIn(config, containerId);
    const missing = [...roles.filter(r => !positions[r.id]), ...children.filter(d => !positions[d.id])];
    if (!missing.length) return;
    const existing = [...roles.filter(r => positions[r.id]), ...children.filter(d => positions[d.id])];
    const bottom = existing.reduce((max, item) => {
      const p = positions[item.id];
      return Math.max(max, p.y + ('width' in item ? (p.height ?? LAYOUT_METRICS.cardHeight) : LAYOUT_METRICS.cardHeight));
    }, 0);
    const isRoot = containerId === null;
    const startY = existing.length ? bottom + LAYOUT_METRICS.nodeGap : (isRoot ? 24 : LAYOUT_METRICS.contentY);
    let x = LAYOUT_METRICS.contentX;
    let y = startY;
    let rowHeight = 0;
    missing.forEach((item, index) => {
      const size = 'width' in item ? (sizes.get(item.id) ?? { width: LAYOUT_METRICS.minEmptyWidth, height: LAYOUT_METRICS.minEmptyHeight }) : { width: LAYOUT_METRICS.cardWidth, height: LAYOUT_METRICS.cardHeight };
      positions[item.id] = 'width' in item ? { x, y, width: size.width, height: size.height } : { x, y };
      rowHeight = Math.max(rowHeight, size.height);
      if (index % 2 === 1 || index === missing.length - 1) { y += rowHeight + LAYOUT_METRICS.nodeGap; rowHeight = 0; }
      x += size.width + LAYOUT_METRICS.nodeGap;
      if (index % 2 === 1) x = LAYOUT_METRICS.contentX;
    });
  };

  placeMissingIn(null);
  const byDepth = (a: TeamDepartment, b: TeamDepartment): number => {
    const depth = (d: TeamDepartment): number => { let n = 0; let current: string | null = d.parentDepartmentId; const seen = new Set<string>(); while (current && !seen.has(current)) { seen.add(current); n++; current = config.departments.find(item => item.id === current)?.parentDepartmentId ?? null; } return n; };
    return depth(a) - depth(b) || a.id.localeCompare(b.id);
  };
  [...config.departments].sort(byDepth).forEach(d => placeMissingIn(d.id));
  return { ...layout, positions };
}
