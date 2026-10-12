#!/usr/bin/env bun
/**
 * The second integration round — three defects from two parked cycles that
 * each ran ~4.5 h and ended with the work stranded on a detached worktree.
 *
 *  1. ROUTING. `routeStepOutcome` drained the cycle's `dispatch-slow` events
 *     onto the TAIL of the event log, and `nextStep()` routes on the tail. A
 *     post-lens-fix adversarial review that crossed the slow threshold had
 *     its `adversarial-approved` shadowed, fell through to the linear table
 *     (`adversarial → commit-pr`) and re-ran commit-pr instead of going to
 *     lens-review — which rebuilt the branch from base and pushed
 *     non-fast-forward. The same shadowing skipped a fix request and a cap.
 *  2. WORKTREE. The commit-pr fallback's integrate worktree could not be
 *     created whenever a workstream tree held commits: the same-issue sibling
 *     scan read the cycle's OWN `issue-<N>-<id>` tree as a foreign leftover
 *     ("refusing to force-remove … it holds unrecoverable work").
 *  3. HANDOFF TEXT. "branch pushed to origin: yes" beside "it is not yet
 *     pushed" — the snapshot bit means "origin has the branch".
 *
 * Offline: real git in temp dirs, no network, no model.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearSlowEventsForTesting, foldSlowEvents, slowRecorder } from "../src/slow-events.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery-caps.ts";
import {
  ensureIntegrateWorktree,
  integrateWorktreePath,
} from "../src/work-driver-integrate-worktree.ts";
import { routeStepOutcome } from "../src/work-driver-step-router.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import type { WorkEvent, WorkState, WorkStep } from "../src/workflow-state.ts";
import { fixture, git, realExec } from "./helpers-integrate-pin-realgit.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "pi-ens-second-round-"));
const ISSUE = 46;

/** One crossing recorded during `step`, as the slow watch would push it. */
function crossSlow(step: WorkStep) {
  slowRecorder(ISSUE, step)({
    step,
    role: "adversarial-developer",
    jobId: "slow-job",
    label: "adversarial-developer[round1-review]",
    elapsedMs: 1_200_000,
    turns: 16,
    tokens: 986_000,
    at: Date.now(),
  });
}

/** A cycle sitting at the end of `step`, having arrived from `from`, with `tail` appended. */
function stateAfter(step: WorkStep, from: WorkStep, ...tail: WorkEvent[]): WorkState {
  let st = initialState(ISSUE, 1000);
  st = {
    ...st,
    pipelineState: { ...st.pipelineState, currentStep: step, lastCompletedStep: from },
  };
  return appendEvent(st, { kind: "step-started", step, at: 2000 }, ...tail);
}

async function routed(step: WorkStep, state: WorkState): Promise<WorkState> {
  const repoRoot = path.join(root, `route-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repoRoot, { recursive: true });
  const ctx = { pi: {}, repoRoot, issue: ISSUE } as unknown as DriverContext;
  const out = await routeStepOutcome(ctx, state, step, { num: 5, total: 9 }, 1, Date.now());
  return out.state;
}

const stepOf = (s: WorkState) => {
  const d = nextStep(s);
  return d.kind === "step" ? d.step : d.kind;
};

// ---------------------------------------------------------------- 1. routing
{
  clearSlowEventsForTesting();
  const approved: WorkEvent = { kind: "adversarial-approved", at: 3000, jobId: "j", rounds: 1 };

  // The control: no crossing → the post-lens-fix approval goes to re-review.
  const quiet = await routed("adversarial", stateAfter("adversarial", "lens-fix", approved));
  assert(stepOf(quiet) === "lens-review", "control: approval after lens-fix → lens-review");

  // The incident: the review crossed the slow threshold during the step.
  crossSlow("adversarial");
  const slow = await routed("adversarial", stateAfter("adversarial", "lens-fix", approved));
  assert(
    slow.eventLog.filter((e) => e.kind === "dispatch-slow").length === 1,
    "the crossing still lands in the log exactly once",
  );
  assert(
    slow.eventLog[slow.eventLog.length - 1]?.kind === "adversarial-approved",
    "the step's verdict is still the TAIL after the slow drain",
  );
  assert(
    stepOf(slow) === "lens-review",
    `a slow review after lens-fix → lens-review, NOT a second commit-pr (got ${stepOf(slow)})`,
  );

  // The same shadowing skipped a fix request...
  crossSlow("adversarial");
  const fix = await routed(
    "adversarial",
    stateAfter("adversarial", "develop", {
      kind: "adversarial-fix-requested",
      at: 3000,
      workstreamId: "default",
      round: 1,
      findings: "f",
    } as WorkEvent),
  );
  assert(stepOf(fix) === "develop", `a slow review's fix request → develop (got ${stepOf(fix)})`);

  // ...and a cap: a rejection must reach handoff, not commit-pr.
  crossSlow("adversarial");
  const capped = await routed(
    "adversarial",
    stateAfter("adversarial", "develop", {
      kind: "cap-hit",
      at: 3000,
      cap: "adversarial-loop",
      reviewRound: 0,
      nextStep: "handoff",
    }),
  );
  assert(stepOf(capped) === "handoff", `a slow review's cap-hit → handoff (got ${stepOf(capped)})`);

  // No step-started to anchor on: the slow events still never become the tail.
  const slowEv = slow.eventLog.find((e) => e.kind === "dispatch-slow") as WorkEvent;
  const folded = foldSlowEvents([approved], [slowEv], "adversarial");
  assert(
    folded.length === 2 && folded[1]?.kind === "adversarial-approved",
    "foldSlowEvents without a step-started keeps the verdict last",
  );
  assert(foldSlowEvents([], [slowEv], "adversarial").length === 1, "…and an empty log just holds it");
}

// --------------------------------------------------------------- 2. worktree
{
  const { repo, baseSha } = await fixture(root, "own-tree");
  // The cycle's own workstream tree, with the developer's commit in it — the
  // work the fallback exists to consolidate.
  const wt = path.join(repo, ".worktrees", "issue-1-default");
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "feature.txt"), "feature\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "developer work"]);
  const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();

  const opts = { repoRoot: repo, issue: 1, branchName: "feature/issue-1-x", baseSha };
  let err = "";
  const created = await ensureIntegrateWorktree(realExec, { ...opts, cycleWorktrees: [wt] }).catch(
    (e: Error) => {
      err = e.message;
      return undefined;
    },
  );
  assert(
    created?.path === integrateWorktreePath(repo, 1),
    `the integrate worktree is created beside a committed in-cycle workstream tree (${err.slice(0, 120) || "ok"})`,
  );
  assert(
    (await git(wt, ["rev-parse", "HEAD"])).stdout.trim() === head,
    "the workstream tree and its commit are untouched",
  );

  // The guard is not waived: the same tree, NOT named as this cycle's, still refuses.
  await git(repo, ["worktree", "remove", "--force", integrateWorktreePath(repo, 1)]);
  const foreign = await ensureIntegrateWorktree(realExec, opts).then(
    () => "",
    (e: Error) => e.message,
  );
  assert(
    /refusing to force-remove/.test(foreign) && foreign.includes("issue-1-default"),
    "a same-issue tree with commits that is NOT in the cycle's set is still refused",
  );
}

// ----------------------------------------------------------- 3. handoff text
{
  const branch = "feature/issue-46-x";
  const parked = (branchPushed: boolean): WorkState => {
    let st = initialState(ISSUE, 1000);
    st = appendEvent(
      st,
      { kind: "handoff-consolidated", at: 2000, branchName: branch, workstreams: ["default"] },
      {
        kind: "cap-hit",
        at: 3000,
        cap: "integration-worktree-violation",
        reviewRound: 1,
        nextStep: "handoff",
      },
    );
    return {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        branchName: branch,
        handoffSnapshot: {
          modifiedFiles: [],
          unstagedCount: 0,
          stagedCount: 0,
          branchExists: true,
          branchPushed,
          headSha: "5c1c543",
          capturedAt: 3000,
          committedWork: [{ worktreeId: "default", path: "/w", headSha: "17b7f3ab", ahead: 3 }],
        },
      },
    };
  };
  const text = (s: WorkState) =>
    recoveryStepsForCap(s)
      .steps.flatMap((x) => [...(x.comment ?? []), ...x.lines])
      .join("\n");
  const onOrigin = text(parked(true));
  assert(
    !/not yet pushed/.test(onOrigin) && /EARLIER push/.test(onOrigin),
    "branch already on origin: the push step no longer says 'not yet pushed'",
  );
  assert(onOrigin.includes(`git push -u origin ${branch}`), "…and still gives the push command");
  assert(
    /not yet pushed/.test(text(parked(false))),
    "branch not on origin: the original 'not yet pushed' wording is kept",
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
