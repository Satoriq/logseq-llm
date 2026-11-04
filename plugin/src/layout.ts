/**
 * The panel's tabs and splits, as plain data. A group is a row of tabs showing one of them; a
 * split shares its space between two children. No DOM here, so it's tested on its own.
 */

export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** One chat in one place. Its model is its own, so each tab can use a different one. */
export type Tab = { id: string; chatId: string | null; provider?: string; model?: string; effort?: string };
export type Group = { kind: 'group'; id: string; tabs: Tab[]; active: string };
/** `ratio` is the first child's share of the space. */
export type Split = { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode };
export type LayoutNode = Group | Split;

const HALF = 0.5;

/** Neither side can be dragged out of reach. */
export function clampRatio(r: number): number {
  return Math.min(0.85, Math.max(0.15, r));
}

export function newGroup(id: string, tab: Tab): Group {
  return { kind: 'group', id, tabs: [tab], active: tab.id };
}

export function groups(n: LayoutNode): Group[] {
  return n.kind === 'group' ? [n] : [...groups(n.a), ...groups(n.b)];
}

export function allTabs(n: LayoutNode): Tab[] {
  return groups(n).flatMap((g) => g.tabs);
}

export function groupOf(root: LayoutNode, tabId: string): Group | null {
  return groups(root).find((g) => g.tabs.some((t) => t.id === tabId)) ?? null;
}

/** Changes one group. Returning null removes it, and the other side of its split takes the space. */
function mapGroup(n: LayoutNode, id: string, fn: (g: Group) => LayoutNode | null): LayoutNode | null {
  if (n.kind === 'group') return n.id === id ? fn(n) : n;
  const a = mapGroup(n.a, id, fn);
  const b = mapGroup(n.b, id, fn);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

export function addTab(root: LayoutNode, groupId: string, tab: Tab): LayoutNode {
  return mapGroup(root, groupId, (g) => ({ ...g, tabs: [...g.tabs, tab], active: tab.id })) as LayoutNode;
}

export function activate(root: LayoutNode, tabId: string): LayoutNode {
  const g = groupOf(root, tabId);
  return g ? (mapGroup(root, g.id, (x) => ({ ...x, active: tabId })) as LayoutNode) : root;
}

/** Null when that was the last tab of all. */
export function closeTab(root: LayoutNode, tabId: string): LayoutNode | null {
  const g = groupOf(root, tabId);
  if (!g) return root;
  return mapGroup(root, g.id, (x) => {
    const at = x.tabs.findIndex((t) => t.id === tabId);
    const tabs = x.tabs.filter((t) => t.id !== tabId);
    const next = tabs[Math.min(at, tabs.length - 1)];
    if (!next) return null;
    return { ...x, tabs, active: x.active === tabId ? next.id : x.active };
  });
}

/** Sets a split's share. `path` walks down from the root: 'a' or 'b' at each split, '' for the root. */
export function setRatio(n: LayoutNode, path: string, ratio: number): LayoutNode {
  if (n.kind !== 'split') return n;
  if (path === '') return { ...n, ratio: clampRatio(ratio) };
  const rest = path.slice(1);
  return path[0] === 'a' ? { ...n, a: setRatio(n.a, rest, ratio) } : { ...n, b: setRatio(n.b, rest, ratio) };
}

/** Center joins the target's tabs, at `index` if given. An edge splits the target and takes that half. */
export function moveTab(root: LayoutNode, tabId: string, targetId: string, zone: Zone, newGroupId: string, index?: number): LayoutNode {
  const from = groupOf(root, tabId);
  const tab = from?.tabs.find((t) => t.id === tabId);
  const target = groups(root).find((g) => g.id === targetId);
  if (!from || !tab || !target) return root;

  if (zone === 'center') {
    const place = (g: Group): Group => {
      const tabs = g.tabs.filter((t) => t.id !== tabId);
      tabs.splice(Math.min(index ?? tabs.length, tabs.length), 0, tab);
      return { ...g, tabs, active: tabId };
    };
    return mapGroup(from.id === target.id ? root : (closeTab(root, tabId) as LayoutNode), target.id, place) as LayoutNode;
  }

  // A group's only tab has nothing to split away from.
  if (from.id === target.id && from.tabs.length === 1) return root;
  const fresh = newGroup(newGroupId, tab);
  const first = zone === 'left' || zone === 'top';
  return mapGroup(closeTab(root, tabId) as LayoutNode, target.id, (g) => ({
    kind: 'split',
    dir: zone === 'left' || zone === 'right' ? 'row' : 'col',
    ratio: HALF,
    a: first ? fresh : g,
    b: first ? g : fresh,
  })) as LayoutNode;
}

/** Which part of a group the pointer is over: the middle half joins it, the rest splits it. */
export function zoneAt(r: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const dx = (x - r.left) / r.width;
  const dy = (y - r.top) / r.height;
  const edges: [Zone, number][] = [['left', dx], ['right', 1 - dx], ['top', dy], ['bottom', 1 - dy]];
  const [zone, distance] = edges.reduce((best, e) => (e[1] < best[1] ? e : best));
  return distance < 0.25 ? zone : 'center';
}

function cleanTab(v: unknown, seen: Set<string>): Tab | null {
  const t = v as Partial<Tab> | null;
  if (typeof t?.id !== 'string' || seen.has(t.id)) return null;
  seen.add(t.id);
  const text = (x: unknown): x is string => typeof x === 'string' && x !== '';
  return {
    id: t.id,
    chatId: text(t.chatId) ? t.chatId : null,
    ...(text(t.provider) ? { provider: t.provider } : {}),
    ...(text(t.model) ? { model: t.model } : {}),
    ...(text(t.effort) ? { effort: t.effort } : {}),
  };
}

function cleanNode(v: unknown, seen: Set<string>): LayoutNode | null {
  const n = v as (Partial<Group> & Partial<Split>) | null;
  if (n?.kind === 'split') {
    if (n.dir !== 'row' && n.dir !== 'col') return null;
    const a = cleanNode(n.a, seen);
    const b = cleanNode(n.b, seen);
    const ratio = typeof n.ratio === 'number' && Number.isFinite(n.ratio) ? clampRatio(n.ratio) : HALF;
    return a && b ? { kind: 'split', dir: n.dir, ratio, a, b } : (a ?? b);
  }
  if (n?.kind !== 'group' || typeof n.id !== 'string' || !Array.isArray(n.tabs)) return null;
  const tabs = n.tabs.map((t) => cleanTab(t, seen)).filter((t): t is Tab => t !== null);
  const first = tabs[0];
  if (!first) return null;
  return { kind: 'group', id: n.id, tabs, active: tabs.some((t) => t.id === n.active) ? (n.active as string) : first.id };
}

/** What was saved, or null if it can't be used. Anything damaged is dropped rather than trusted. */
export function parseLayout(text: string): LayoutNode | null {
  try {
    return cleanNode(JSON.parse(text), new Set());
  } catch {
    return null;
  }
}
