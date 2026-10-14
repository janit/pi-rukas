/**
 * adversarial-params — the parameter shape of `runAdversarialLoop`. Split from
 * adversarial.ts (500-line limit); the loop itself lives there.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FixFence } from "./adversarial-fix-guard.ts";
import type { SiblingScope } from "./adversarial-prompts.ts";
import type { OnSlowCallback } from "./slow-notice.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Whether the loop runs as one reviewer dispatch (#1114) and, if so, how its
 * verdict is judged (#1154). Discriminated: `reportVerdict` is REQUIRED whenever
 * `reportOnly` is true and must be absent otherwise, so no reportOnly caller
 * gets a verdict policy by omission.
 */
export type ReportPolicy =
  | {
      /**
       * #1114 — exactly ONE reviewer dispatch: no developer dispatch, no fix
       * round. The result carries the parsed verdict in `adversarialRounds` and
       * its findings in `text`; the driver routes from the round record. The
       * review-ledger entry is still written (#912) with `loopOutcome` set to
       * `approved` on a pass and `rejected` otherwise. An unparsed verdict is an
       * infrastructure outcome, never a verdict.
       */
      reportOnly: true;
      /**
       * #1154 — how the reportOnly verdict is judged. "terminal": the review is
       * the loop's only round, so it is judged by the terminal-round rule
       * (ISSUES_FOUND passes; only CRITICAL_ISSUES_FOUND or an unreadable reply
       * fails) — the tool path. "routed": judged as round N of 3, so ISSUES_FOUND
       * routes to a fix pass — the /work driver's per-round reviews. Set by the
       * adversarial_loop tool (terminal) and by the /work fan-out (routed);
       * required whenever reportOnly is true.
       */
      reportVerdict: "terminal" | "routed";
    }
  | { reportOnly?: false | undefined; reportVerdict?: undefined };

/** What `runAdversarialLoop` is called with. */
export type AdversarialLoopParams = {
  /** Optional when `base` + `head` are present (computed from the ref
   * range). When both `diff` and base/head are given, the string wins. */
  diff?: string;
  /** #1040 — git timeout for the comment-loss check (the driver passes verifyTimeoutMs()). */
  commentTimeoutMs?: number;
  /** #1040 — injected git seam for the comment-loss check (the driver passes its verify exec). */
  commentExecFn?: ExecFn;
  /** #859 — the base ref the tool computes the diff from (with head). */
  base?: string;
  /** #859 — the head ref the tool computes the diff from (with base). */
  head?: string;
  context: string;
  workCwd?: string;
  /** Recompute the diff before each review. Without it rounds 2+ see pre-fix material. */
  getDiff?: () => Promise<string>;
  /** What the fix pass before this review changed (fix-delta.ts); first round only. */
  fixDelta?: string;
  /** The issue this diff is meant to satisfy (#278). Optional: older state files have none. */
  issueBody?: string;
  /** The gate the driver already ran green on this tree; the reviewer is told not to re-run it. */
  gateCmd?: string;
  /** #799 — the slow-run recorder for this loop's inner children (each
   * threshold crossing of a review / fix round appends dispatch-slow), and
   * the parent pi for their slow-run watch (the PM notice half). */
  onSlow?: OnSlowCallback;
  pi?: ExtensionAPI;
  /** #1024 — headless only: each inner child leads its own process group. */
  processGroup?: boolean;
  /** #912 — caller-supplied branch for the review-ledger write (the driver
   * worktrees are detached, so `git rev-parse --abbrev-ref HEAD` cannot
   * recover it). When absent the writer recovers the branch from `HEAD`
   * and skips (traces) on a detached head. */
  branch?: string;
  /** #1114 — the round number a reportOnly review carries (prompt + record). Default 1. */
  reportRound?: number;
  /**
   * #1137 — the workstream scope the review is judged within. Present only
   * on the per-workstream driver path (N>1 fan-out); absent on N=1 and on
   * the `adversarial_loop` tool path, where the whole issue is the scope
   * and the prompt is byte-identical to the pre-#1137 one.
   */
  scope?: { own?: SiblingScope; siblings: readonly SiblingScope[] };
  /**
   * #1104 — the tool path's caller-repo fence. Set ONLY at the tool boundary
   * (`adversarial-tool.ts`) with the calling process's cwd; the /work driver
   * leaves it unset, because its caller is the integration checkout it
   * mutates itself. A fix round needs `workCwd` on every path.
   */
  fixFence?: FixFence;
} & ReportPolicy;
