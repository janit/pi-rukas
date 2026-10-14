#!/usr/bin/env bun
/**
 * #1137 — the plumb question a no-change adversarial fix pass carries to the
 * handoff: the single reader both park branches use, routing a question to a
 * handoff that names it, and ignoring a report from an earlier pass. Split from
 * test-work-driver-adversarial-fix-pass.ts (500-line limit).
 */

import { rmSync } from "node:fs";
import type { DispatchResult } from "../src/types.ts";
import {
  pendingFixes,
  plumbQuestion,
  runAdversarialFixPass,
} from "../src/work-driver-adversarial-fix.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { repoWithFile, twoWorkstreamState } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

// H2 — #1137: plumbQuestion is the single reader both no-change park branches
// use: the untrusted-text prefix, code fences stripped, capped at 300 chars
// with an ellipsis; null when no report carries the marker.
{
  const fenced = [
    {
      body: "[ensemble:plumb]\ncategory: scope-ambiguity\n```diff\nold\nnew\n```\nquestion: does docs own b.txt?",
    },
  ];
  const q = plumbQuestion(fenced);
  assert(
    q?.startsWith("developer question (untrusted text): ") && !q.includes("```"),
    `H2: the plumb body is prefixed, and code fences are stripped (got: ${q})`,
  );
  const long = [{ body: `[ensemble:plumb]\n${"x".repeat(400)}` }];
  const ql = plumbQuestion(long) ?? "";
  const bodyAfterPrefix = ql.slice("developer question (untrusted text): ".length);
  assert(
    ql.endsWith("…") && bodyAfterPrefix.length === 300,
    `H2: a long plumb body is capped at 300 chars with an ellipsis (body len ${bodyAfterPrefix.length})`,
  );
  assert(
    plumbQuestion([{ body: "an ordinary note with no marker" }]) === null,
    "H2: a report without the plumb marker returns null",
  );
}

// J — #1137: a no-change fix pass whose developer replied with a plumb
// question (scope-ambiguity) routes to a handoff that NAMES the question, not
// the generic "byte-identical — nothing was fixed". The cap is still
// verify-failed:develop (so nextStep routes to handoff) but the evidence
// carries the plumb question so the operator answers it.
{
  const dir = repoWithFile("fix-plumb");
  try {
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) =>
        ({
          role: spec.role,
          ok: true,
          exitCode: 0,
          // The developer returns a plumb report (scope-ambiguity) and changes nothing.
          text: "[ensemble:plumb]\ncategory: scope-ambiguity\nquestion: does this workstream own b.txt or a.txt?",
          toolUses: [],
          ms: 1,
        }) as DispatchResult,
    };
    // No prior plumb report: the fix developer's reply is the only source.
    const st = twoWorkstreamState(dir);
    const pending = pendingFixes(st.eventLog);
    const out = await runAdversarialFixPass(ctx, st, pending, Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "verify-failed:develop",
      `J: a plumb-with-no-change parks as verify-failed:develop (tail: ${tail?.kind})`,
    );
    // The evidence names the plumb question, not just "byte-identical".
    const evidence = tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "";
    assert(
      /answer the question/.test(evidence) &&
        evidence.includes("does this workstream own b.txt or a.txt?"),
      `J: the evidence names the developer's plumb question (got: ${evidence.slice(0, 160)})`,
    );
    // The handoff's plumb section also carries the reply.
    assert(
      (out.pipelineState.plumbReports ?? []).some((r) =>
        r.body.includes("does this workstream own b.txt or a.txt?"),
      ),
      "J: the developer's reply is recorded as a plumb report for the handoff",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// K — #1137 review: a plumb report from an EARLIER pass is not this pass's question.
{
  // No-change pass: the developer answers "done" and commits nothing, so the
  // stale report is the only plumb candidate a route could present.
  const dir = repoWithFile("fix-stale-plumb");
  try {
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) =>
        ({
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "done",
          toolUses: [],
          ms: 1,
        }) as DispatchResult,
    };
    const st = twoWorkstreamState(dir);
    const stale: WorkState = {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        plumbReports: [
          { step: "develop", role: "driver", body: "[ensemble:plumb] old question", at: 1 },
        ],
      },
    };
    const out = await runAdversarialFixPass(ctx, stale, pendingFixes(stale.eventLog), Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    const ev = tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "";
    assert(
      tail?.kind === "cap-hit" && !/answer the question/.test(ev),
      `K: a stale plumb report is not presented as this pass's question (tail: ${tail?.kind})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
