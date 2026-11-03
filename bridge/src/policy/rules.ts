/**
 * Allow/deny rule syntax (config.json → policy.deny / policy.allow):
 *
 *   page:<title>                exact page title (case-insensitive), the page and all its blocks
 *   namespace:<prefix>          page titles starting with <prefix>, e.g. "namespace:Work/"
 *   tag:<name>                  pages or blocks tagged <name>, plus everything under a tagged block
 *   journal:<from>..<to>        journal pages in a date range (YYYY-MM-DD; either side may be empty)
 *   property:<name>             blocks/pages (or their parents) that have the property
 *   property:<name>=<value>     ... with that value (case-insensitive)
 *
 * Deny always wins. An empty allow list means "everything not denied".
 */

export type Rule =
  | { kind: 'page'; title: string; source: string }
  | { kind: 'namespace'; prefix: string; source: string }
  | { kind: 'tag'; tag: string; source: string }
  | { kind: 'journal'; from: number | null; to: number | null; source: string }
  | { kind: 'property'; name: string; value: string | null; source: string };

export class RuleError extends Error {}

function journalDay(s: string, rule: string): number | null {
  if (s === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new RuleError(`"${rule}": dates must look like 2026-01-31`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new RuleError(`"${rule}": ${s} is not a real date`);
  }
  return y * 10000 + mo * 100 + d;
}

export function parseRule(source: string): Rule {
  const i = source.indexOf(':');
  if (i <= 0) throw new RuleError(`"${source}": expected <type>:<value>, e.g. "tag:private"`);
  const kind = source.slice(0, i).trim().toLowerCase();
  const value = source.slice(i + 1).trim();
  if (value === '') throw new RuleError(`"${source}": the value after ":" is empty`);
  switch (kind) {
    case 'page':
      return { kind: 'page', title: value.toLowerCase(), source };
    case 'namespace':
      return { kind: 'namespace', prefix: value.toLowerCase(), source };
    case 'tag':
      return { kind: 'tag', tag: value.replace(/^#/, '').toLowerCase(), source };
    case 'journal': {
      const parts = value.split('..');
      if (parts.length !== 2) throw new RuleError(`"${source}": expected journal:<from>..<to>`);
      const from = journalDay(parts[0]?.trim() ?? '', source);
      const to = journalDay(parts[1]?.trim() ?? '', source);
      if (from === null && to === null) throw new RuleError(`"${source}": give at least one date`);
      if (from !== null && to !== null && from > to) throw new RuleError(`"${source}": the range is backwards`);
      return { kind: 'journal', from, to, source };
    }
    case 'property': {
      const eq = value.indexOf('=');
      const name = (eq === -1 ? value : value.slice(0, eq)).trim().toLowerCase();
      const val = eq === -1 ? null : value.slice(eq + 1).trim().toLowerCase();
      if (name === '') throw new RuleError(`"${source}": property name is empty`);
      if (val === '') throw new RuleError(`"${source}": property value is empty (drop "=" to match any value)`);
      return { kind: 'property', name, value: val, source };
    }
    default:
      throw new RuleError(`"${source}": unknown rule type "${kind}" (use page, namespace, tag, journal or property)`);
  }
}

export function parseRules(sources: readonly string[]): Rule[] {
  return sources.map(parseRule);
}
