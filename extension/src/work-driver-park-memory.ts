/**
 * work-driver-park-memory — an intent park that survives `--restart`.
 *
 * `/work N --restart` starts from `initialState`, so the state file — the
 * only place the intent verdict lived — is gone before explore runs. A
 * factory that passes `--restart` on every second cycle therefore re-ran the
 * whole resolution of an issue that had parked minutes earlier: measured on
 * janit/tehas#85 and #88, 705 s and 411 s (686k tokens) to reach the verdict
 * the previous cycle had already posted, followed by a second near-identical
 * "Cap hit" comment for a human to tell apart.
 *
 * `--restart` means "look again", and looking again is only worth a dispatch
 * when there is something new to see. The verdict is a function of two
 * inputs — the issue text and the code it was grounded against — so the
 * record carries a fingerprint of both. Same fingerprint: park again with the
 * recorded verdict, no explore dispatch, no second comment. Either input
 * changed (the human revised the issue, or the code moved): run fresh,
 * exactly as before.
 *
 * Deliberately narrow:
 *   - intent parks only. Every other cap is a retry that can end differently
 *     on identical inputs (a timeout, a review round, a red gate).
 *   - the record is written only once the park's comment is known to be
 *     posted, so "see the earlier comment" always has a comment to point at.
 *   - anything unreadable — no HEAD, a missing or malformed record — means
 *     no short-circuit. The fallback is the pre-existing behaviour.
 *
 * The record lives beside the other per-issue artifacts
 * (`.pi/work-state/<issue>/intent-park.txt`), which `--restart` never
 * touched. Deleting it is the override; no flag, no env knob.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { parseNormalisedSpecArtifact } from "./work-driver-intent-artifact.ts";
import { execp } from "./work-driver-verify.ts";
import { type WorkState, dispatchArtifactPath, writeDispatchArtifact } from "./workflow-state.ts";

/** What a prior cycle's intent park was judged against, and where it was reported. */
export interface ParkRecord {
  fingerprint: string;
  /** When the recorded park fired (ms epoch). */
  parkedAt: number;
  /** The handoff comment that reported it. */
  commentUrl: string;
  spec: NonNullable<WorkState["pipelineState"]["normalisedSpec"]>;
}

/** The record's path. Shared with the explain text and the tests. */
export function parkRecordPath(repoRoot: string, issue: number): string {
  return dispatchArtifactPath(repoRoot, issue, "intent-park");
}

/**
 * Fingerprint the two inputs an intent verdict depends on: the fetched issue
 * text (title + body) and the commit explore grounds it against. `undefined`
 * when HEAD cannot be read — half a fingerprint would call a moved codebase
 * "unchanged".
 */
export async function parkFingerprint(
  ctx: Pick<DriverContext, "repoRoot" | "verifyExecFn">,
  issueText: string,
): Promise<string | undefined> {
  try {
    const exec = ctx.verifyExecFn ?? execp;
    const { stdout } = await exec("git rev-parse HEAD", { cwd: ctx.repoRoot, timeout: 10_000 });
    const head = stdout.trim();
    if (!head) return undefined;
    return createHash("sha256").update(`${head}\n${issueText}`).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * The prior park for this issue, iff it was judged against `fingerprint`.
 * Never throws: a missing file is the normal case, and a malformed one is
 * treated as absent so the cycle resolves fresh.
 */
export async function readRepeatPark(
  repoRoot: string,
  issue: number,
  fingerprint: string,
): Promise<ParkRecord | undefined> {
  let raw: Partial<ParkRecord>;
  try {
    raw = JSON.parse(await fs.readFile(parkRecordPath(repoRoot, issue), "utf8"));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  if (raw.fingerprint !== fingerprint) return undefined;
  if (typeof raw.parkedAt !== "number" || typeof raw.commentUrl !== "string" || !raw.commentUrl) {
    return undefined;
  }
  // The spec goes back into pipelineState, so it gets the same element-level
  // validation as the spec artifact — and it must actually be a park.
  const spec = parseNormalisedSpecArtifact(JSON.stringify(raw.spec));
  if (spec?.verdict !== "park") return undefined;
  return { fingerprint, parkedAt: raw.parkedAt, commentUrl: raw.commentUrl, spec };
}

/**
 * Record this cycle's intent park once its comment is posted (called from
 * the handoff step). A no-op for every other cap, for a repeat park (the
 * original record keeps its time and its comment), and when there is no
 * fingerprint or no comment to point at. Best-effort.
 */
export async function recordPark(
  repoRoot: string,
  state: WorkState,
  commentUrl: string | undefined,
): Promise<void> {
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const spec = state.pipelineState.normalisedSpec;
  if (cap?.kind !== "cap-hit" || cap.cap !== "intent-park") return;
  if (!cap.fingerprint || cap.repeatOf || !commentUrl || !spec) return;
  const record: ParkRecord = { fingerprint: cap.fingerprint, parkedAt: cap.at, commentUrl, spec };
  try {
    await writeDispatchArtifact(
      repoRoot,
      state.issue,
      "intent-park",
      JSON.stringify(record, null, 2),
    );
  } catch (err) {
    trace(`work-driver: could not persist intent-park record: ${(err as Error).message}`);
  }
}

/** The earlier park this cycle's cap-hit repeats, if it is a repeat. */
export function repeatParkOf(state: WorkState): { at: number; commentUrl: string } | undefined {
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  return cap?.kind === "cap-hit" && cap.cap === "intent-park" ? cap.repeatOf : undefined;
}
