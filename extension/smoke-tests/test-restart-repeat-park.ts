#!/usr/bin/env bun
/**
 * `/work N --restart` must not re-resolve an issue that just parked at the
 * intent gate against the same issue text and the same commit.
 *
 * Measured (janit/tehas#85, #88, 12 Oct): the first cycle parked
 * `intent-park (contradicted-by-code)`; a second cycle 21-36 min later ran
 * with `--restart`, which starts from `initialState` — so nothing remembered
 * the park. Explore ran again from zero (705 s; 411 s and 686k tokens),
 * reached the same verdict, and posted a second near-identical "Cap hit"
 * comment on the issue.
 *
 * The canary is section 2: a restarted cycle with unchanged inputs dispatches
 * NOTHING — no explore, no ops handoff — and points at the earlier comment.
 * Sections 3+ pin the other direction, which matters as much: `--restart`
 * still means "look again" whenever there is something new to look at, and
 * every unreadable input degrades to a fresh resolution.
 *
 * Each "restart" below is what `runWorkDriverInner` does on `--restart`:
 * `initialState(issue)`, same repoRoot.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_INTENT = "1";
// No forge: the label leg is out of scope here, and the comment URL comes
// from the ops reply (first cycle) or the park record (repeat).
process.env.PI_ENSEMBLE_FORGE = "none";

const ISSUE = 85;
const URL = `https://github.com/o/r/issues/${ISSUE}#issuecomment-111`;
const PARK_REPLY = [
  "INTENT-VERDICT: park",
  "PARK-REASON: contradicted-by-code",
  "",
  "## Spec",
  "",
  "### Intent",
  "Reported: the retry budget is shared between infra and semantic failures.",
  "",
  "### Evidence",
  "- the counters are separate — src/step-router.ts:192 — contradicted",
  "",
  "## Rationale",
  "The issue describes behaviour that was already changed. It is stale.",
  "",
].join("\n");
const PROCEED_REPLY = [
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "Add the widget renderer.",
  "",
  "### Deliverables",
  "- D1: add the widget renderer [paths: src/widget.ts]",
  "",
  "### Acceptance criteria",
  "- the widget renders",
  "",
].join("\n");

function result(role: string, text: string): DispatchResult {
  return {
    role,
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
  } as DispatchResult;
}

interface World {
  dir: string;
  body: string;
  /** `undefined` → `git rev-parse HEAD` fails. */
  head: string | undefined;
  exploreReply: string;
  opsReply: string;
  explores: number;
  opsPosts: number;
}

function world(label: string): World {
  const dir = mkdtempSync(path.join(tmpdir(), `repeat-park-${label}-`));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return {
    dir,
    body: `title:\tmock #${ISSUE}\n\nthe retry budget is shared`,
    head: "a".repeat(40),
    exploreReply: PARK_REPLY,
    opsReply: `posted ${URL} and labelled`,
    explores: 0,
    opsPosts: 0,
  };
}

/** One whole cycle as far as a park takes it: explore, then handoff on a cap. */
async function cycle(w: World): Promise<WorkState> {
  const ctx: DriverContext = {
    pi: { sendUserMessage: () => undefined } as unknown as ExtensionAPI,
    repoRoot: w.dir,
    issue: ISSUE,
    issueBodyFetcherFn: async () => ({ stdout: w.body }),
    verifyExecFn: async (cmd) => {
      if (cmd === "git rev-parse HEAD") {
        if (w.head === undefined) throw new Error("fatal: not a git repository");
        return { stdout: `${w.head}\n` };
      }
      return { stdout: "" };
    },
    dispatchFn: async (_pi, spec) => {
      if (spec.role === "explore") {
        w.explores++;
        return result("explore", w.exploreReply);
      }
      w.opsPosts++;
      return result("ops", w.opsReply);
    },
  };
  // What `--restart` yields: a fresh state, the same repoRoot.
  let state = await runExplore(ctx, initialState(ISSUE, Date.now()), Date.now());
  if (state.eventLog.at(-1)?.kind === "cap-hit") {
    state = await runHandoff(ctx, state, Date.now());
  }
  return state;
}

const recordFile = (w: World) =>
  path.join(w.dir, ".pi", "work-state", String(ISSUE), "intent-park.txt");
const capOf = (s: WorkState) =>
  [...s.eventLog]
    .reverse()
    .find((e): e is Extract<typeof e, { kind: "cap-hit" }> => e.kind === "cap-hit");
const emittedOf = (s: WorkState) =>
  [...s.eventLog]
    .reverse()
    .find((e): e is Extract<typeof e, { kind: "handoff-emitted" }> => e.kind === "handoff-emitted");

/** A world whose first cycle has already parked and posted its comment. */
async function parkedWorld(label: string): Promise<World> {
  const w = world(label);
  await cycle(w);
  w.explores = 0;
  w.opsPosts = 0;
  return w;
}

// 1. The first cycle is untouched: it resolves, parks, and posts once.
{
  const w = world("first");
  try {
    const s = await cycle(w);
    assert(w.explores === 1, "first cycle: explore is dispatched");
    assert(w.opsPosts === 1, "first cycle: the park comment is posted");
    assert(capOf(s)?.cap === "intent-park", "first cycle: parks at the intent gate");
    assert(capOf(s)?.repeatOf === undefined, "first cycle: is not marked as a repeat");
    assert(emittedOf(s)?.commentUrl === URL, "first cycle: records the comment it posted");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 2. CANARY — restart, nothing changed: no explore, no second comment.
{
  const w = await parkedWorld("repeat");
  try {
    const s = await cycle(w);
    assert(w.explores === 0, "restart, unchanged issue + commit: explore is NOT re-dispatched");
    assert(w.opsPosts === 0, "restart, unchanged issue + commit: NO second park comment is posted");
    const cap = capOf(s);
    assert(
      cap?.cap === "intent-park" && cap.parkReason === "contradicted-by-code",
      "…it parks again on the recorded verdict and reason",
    );
    assert(cap?.repeatOf?.commentUrl === URL, "…the cap names the earlier park's comment");
    assert(
      emittedOf(s)?.commentUrl === URL,
      "…the handoff points at the earlier comment instead of a new one",
    );
    assert(s.pipelineState.status === "handoff", "…and the cycle still terminates as a handoff");
    const spec = s.pipelineState.normalisedSpec;
    assert(
      spec?.verdict === "park" && /already changed/.test(spec.rationale ?? ""),
      "…with the prior rationale restored for the renderers",
    );
    const why = explainCap("intent-park", s);
    assert(
      /Parked \d+ min ago/.test(why) && why.includes(URL),
      "the operator is told it parked N min ago, with the earlier comment's link",
    );
    assert(
      /did NOT re-resolve/.test(why) && why.includes(`.pi/work-state/${ISSUE}/intent-park.txt`),
      "…that nothing was re-resolved, and how to force a fresh resolution",
    );
    // A third cycle repeats the ORIGINAL park, not the repeat.
    const s3 = await cycle(w);
    assert(
      w.explores === 0 && w.opsPosts === 0 && capOf(s3)?.repeatOf?.at === cap?.repeatOf?.at,
      "a third unchanged cycle still points at the original park's time",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 3. The human revised the issue → `--restart` looks again, as before.
{
  const w = await parkedWorld("edited");
  try {
    w.body = `title:\tmock #${ISSUE}\n\nrevised: the budget is shared in the QUEUE path`;
    w.exploreReply = PROCEED_REPLY;
    const s = await cycle(w);
    assert(w.explores === 1, "edited issue: explore IS re-dispatched");
    assert(capOf(s) === undefined, "edited issue: the fresh verdict (proceed) is honoured");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 4. The code moved → a code-grounded verdict is stale; look again.
{
  const w = await parkedWorld("moved");
  try {
    w.head = "b".repeat(40);
    await cycle(w);
    assert(w.explores === 1, "new HEAD, same issue text: explore IS re-dispatched");
    assert(w.opsPosts === 1, "…and its (new) park is reported");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 5. Unreadable inputs never short-circuit.
{
  const w = await parkedWorld("nohead");
  try {
    w.head = undefined;
    await cycle(w);
    assert(w.explores === 1, "HEAD unreadable: resolves fresh rather than guessing 'unchanged'");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}
{
  const w = await parkedWorld("corrupt");
  try {
    writeFileSync(recordFile(w), '{"fingerprint": ', "utf8");
    await cycle(w);
    assert(w.explores === 1, "malformed park record: resolves fresh");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 6. The override is deleting the record — no flag, no env knob.
{
  const w = await parkedWorld("override");
  try {
    assert(existsSync(recordFile(w)), "a posted intent park leaves a record beside the artifacts");
    rmSync(recordFile(w));
    await cycle(w);
    assert(w.explores === 1, "record deleted: explore IS re-dispatched");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 7. No comment to point at → no record → the retry posts one.
{
  const w = world("unposted");
  try {
    w.opsReply = "I could not post the comment";
    await cycle(w);
    assert(!existsSync(recordFile(w)), "a park whose comment was not posted leaves no record");
    w.explores = 0;
    await cycle(w);
    assert(w.explores === 1, "…so the next cycle resolves fresh and gets to report it");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 8. Only intent parks are remembered.
{
  const w = world("proceed");
  try {
    w.exploreReply = PROCEED_REPLY;
    await cycle(w);
    assert(!existsSync(recordFile(w)), "a cycle that proceeds leaves no park record");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

process.exit(exit);
