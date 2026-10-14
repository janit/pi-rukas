/**
 * lens-findings-dedupe — precedence-based dedup and ordering of the lens
 * findings. Split from lens-review-format.ts (500-line limit), which
 * re-exports it so existing importers keep working.
 */

import type { Severity } from "./lens-review-format.ts";
import type { Finding, FindingSource } from "./lens-review.ts";
import { CLAIM_SCAN, CLAIM_SCAN_PRECEDENCE, type RosterEntry } from "./lens-roster.ts";

/**
 * Deduplicate findings by (normalised path, line, lowercased title). When
 * duplicates exist across lenses, keep the one from the highest-priority lens
 * (roster precedence ascending: the lowest declared value wins). `lens`
 * takes the roster parsed from the skills dir; lenses the roster does not
 * know (e.g. stale findings from an older pass) fall back to 99.
 */
export function dedupeFindings(input: Finding[], lens: RosterEntry[]): Finding[] {
  const precedenceOf = new Map<FindingSource, number>();
  for (const l of lens) {
    if (l.precedence !== undefined) precedenceOf.set(l.name, l.precedence);
  }
  // CLAIM_SCAN outranks every lens on a collision. Its findings are lookups,
  // not judgments — if a lens and the scan land on the same line, the one that
  // can point at a grep result is the one worth keeping. NEGATIVE_INFINITY so
  // it outranks any declared value, whatever the skill authors renumber to.
  precedenceOf.set(CLAIM_SCAN, CLAIM_SCAN_PRECEDENCE);
  // `bestByKey` is bounded by the lens fan-in (≤6 children × finite findings
  // per pass) — at most a few hundred entries per invocation, and the whole
  // map goes out of scope when this function returns. No explicit cap needed.
  const bestByKey = new Map<string, Finding>();
  for (const f of input) {
    const key = `${f.path}::${f.line ?? 0}::${normaliseTitle(f.title)}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, f);
      continue;
    }
    const a = precedenceOf.get(existing.lens) ?? 99;
    const b = precedenceOf.get(f.lens) ?? 99;
    if (b < a) bestByKey.set(key, f);
  }
  return Array.from(bestByKey.values()).sort(sortFindings);
}

function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[.!?;,]+$/, "")
    .trim();
}

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function sortFindings(a: Finding, b: Finding): number {
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return (a.line ?? 0) - (b.line ?? 0);
}

export function bySeverityCounts(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}
