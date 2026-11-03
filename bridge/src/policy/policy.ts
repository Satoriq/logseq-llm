import type { Locality } from '../chats/store.ts';
import type { GNode } from '../graph/entity.ts';
import { isPage } from '../graph/entity.ts';
import type { Rule } from './rules.ts';

/**
 * Privacy filter. Decides, per node, who may see it:
 *   hidden → no model;  local → local models only;  cloud → any model.
 *
 * Order (most restrictive wins):
 *   1. can't tell which page it is on          → hidden (fail closed)
 *   2. matches a deny rule                     → hidden
 *   3. allow list non-empty and nothing matches → hidden
 *   4. marks on the node, any parent or the page:
 *        ai-access:: none        → hidden
 *        ai-access:: local-only  → local
 *        ai-access:: cloud-ok    → no change (never loosens 1-3 or other marks)
 *        ai-access:: <other>     → hidden (a typo must not leak)
 *        #private                → local
 */

export type Visibility = 'hidden' | 'local' | 'cloud';

export const PRIVATE_TAG = 'private';
export const ACCESS_PROPERTY = 'ai-access';

export type Subject = {
  node: GNode;
  /** Parents, nearest first, ending with the page. Empty when the node is itself a page. */
  chain: GNode[];
};

export type Verdict = { visibility: Visibility; reason: string };

const RANK: Record<Visibility, number> = { cloud: 0, local: 1, hidden: 2 };

export function stricter(a: Visibility, b: Visibility): Visibility {
  return RANK[a] >= RANK[b] ? a : b;
}

export function visibleTo(v: Visibility, locality: Locality): boolean {
  return locality === 'cloud' ? v === 'cloud' : v !== 'hidden';
}

export class Policy {
  readonly deny: readonly Rule[];
  readonly allow: readonly Rule[];

  constructor(opts: { deny: readonly Rule[]; allow: readonly Rule[] }) {
    this.deny = opts.deny;
    this.allow = opts.allow;
  }

  evaluate(s: Subject): Verdict {
    const all = [s.node, ...s.chain];
    const page = isPage(s.node) ? s.node : s.chain.at(-1);
    if (!page || !isPage(page)) return { visibility: 'hidden', reason: 'page unknown' };
    if (!isPage(s.node) && page.id !== s.node.pageId) return { visibility: 'hidden', reason: 'parent chain incomplete' };

    for (const r of this.deny) {
      if (matches(r, all, page)) return { visibility: 'hidden', reason: `deny ${r.source}` };
    }
    if (this.allow.length > 0 && !this.allow.some((r) => matches(r, all, page))) {
      return { visibility: 'hidden', reason: 'not in allow list' };
    }

    let v: Visibility = 'cloud';
    let reason = 'visible';
    for (const n of all) {
      for (const value of n.props.get(ACCESS_PROPERTY) ?? []) {
        const mark = value.trim().toLowerCase();
        const next: Visibility = mark === 'cloud-ok' ? 'cloud' : mark === 'local-only' ? 'local' : 'hidden';
        if (RANK[next] > RANK[v]) {
          v = next;
          reason = `${ACCESS_PROPERTY}:: ${value}`;
        }
      }
      if (n.tags.some((t) => t.title.toLowerCase() === PRIVATE_TAG) && RANK.local > RANK[v]) {
        v = 'local';
        reason = `#${PRIVATE_TAG}`;
      }
    }
    return { visibility: v, reason };
  }
}

function matches(r: Rule, all: readonly GNode[], page: GNode): boolean {
  const pageTitle = page.title.toLowerCase();
  switch (r.kind) {
    case 'page':
      return pageTitle === r.title || page.name === r.title;
    case 'namespace':
      return pageTitle.startsWith(r.prefix);
    case 'tag':
      return all.some((n) => n.tags.some((t) => t.title.toLowerCase() === r.tag));
    case 'journal': {
      const day = page.journalDay;
      if (day === null) return false;
      return (r.from === null || day >= r.from) && (r.to === null || day <= r.to);
    }
    case 'property':
      return all.some((n) => {
        const values = n.props.get(r.name);
        if (!values) return false;
        return r.value === null || values.some((v) => v.trim().toLowerCase() === r.value);
      });
  }
}
