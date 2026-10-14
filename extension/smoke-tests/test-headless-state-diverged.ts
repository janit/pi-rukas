#!/usr/bin/env bun
/**
 * #1189 — the headless runner takes its result from its own record of the
 * cycle (the last snapshot the driver persisted through the run's emit sink),
 * not from the state file, which sits in the tree the agents work in.
 *
 *   - an agent forges `merged` with a PR number into the state file while a
 *     dispatch is in flight → exit 30, `error.code: "state-diverged"`, and the
 *     result does not report the forged status or PR;
 *   - an agent deletes the state file → exit 30, state-diverged;
 *   - an agent forges a PR number but leaves `running`, and the driver misses
 *     its grace period → the runner's interrupt fallback does not adopt the
 *     forged file as the cycle's record: exit 30, state-diverged;
 *   - an untouched file → no error, the usual exit code (21 on SIGTERM).
 *
 * Offline: the real driver with a stubbed dispatch that never returns.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HeadlessRunResult, runHeadless } from "../src/headless/run.ts";
import { type WorkState, workStateFile } from "../src/workflow-state.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = () => void;
function fakeSignals() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(sig: string, fn: Handler) {
      if (!handlers.has(sig)) handlers.set(sig, new Set());
      handlers.get(sig)?.add(fn);
    },
    off(sig: string, fn: Handler) {
      handlers.get(sig)?.delete(fn);
    },
    fire(sig: string) {
      for (const fn of [...(handlers.get(sig) ?? [])]) fn();
    },
  };
}

const issueFetch = async () => ({ stdout: "title:\tmock\nstate:\tOPEN\n\nnon-empty mock body" });

/**
 * Run one issue whose first dispatch calls `tamper(file)` (standing in for an
 * agent in the same tree), then SIGTERMs the runner and hangs.
 */
async function runWithTamper(
  issue: number,
  tamper: (file: string) => void,
): Promise<HeadlessRunResult> {
  const repo = mkdtempSync(path.join(tmpdir(), "headless-diverged-"));
  try {
    const sig = fakeSignals();
    let fired = false;
    const dispatchFn = () => {
      if (!fired) {
        fired = true;
        tamper(workStateFile(repo, issue));
        sig.fire("SIGTERM");
      }
      return new Promise<never>(() => undefined);
    };
    return await runHeadless({
      repoRoot: repo,
      issues: [issue],
      restart: false,
      graceMs: 30,
      signalTarget: sig as unknown as NodeJS.Process,
      driverSeams: { dispatchFn, issueBodyFetcherFn: issueFetch },
      write: () => undefined,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 1. A forged `merged` with a PR number: exit 30, state-diverged.
{
  const result = await runWithTamper(51, (file) => {
    const s = JSON.parse(readFileSync(file, "utf8")) as WorkState;
    const forged: WorkState = {
      ...s,
      pipelineState: { ...s.pipelineState, status: "merged", prNumber: 999 },
      eventLog: [...s.eventLog, { kind: "merged", at: Date.now(), prNumber: 999 }],
    };
    writeFileSync(file, `${JSON.stringify(forged, null, 2)}\n`);
  });
  const r = result.results[0];
  assert(result.exitCode === 30, `a forged state file exits 30 (got ${result.exitCode})`);
  assert(result.error?.code === "state-diverged", "the run carries error.code state-diverged");
  assert(r?.error?.code === "state-diverged", "the issue result carries the error too");
  assert(r?.exitCode === 30, "the issue result carries exit 30");
  assert(r?.status !== "merged", `the forged status is not reported (got ${r?.status})`);
  assert(r?.prNumber === undefined, "the forged PR number is not reported");
}

// ── 2. A deleted state file: exit 30, state-diverged.
{
  const result = await runWithTamper(52, (file) => rmSync(file));
  assert(result.exitCode === 30, `a deleted state file exits 30 (got ${result.exitCode})`);
  assert(
    result.error?.code === "state-diverged" && /missing/.test(result.error.message),
    "a missing file is reported as state-diverged",
  );
}

// ── 3. A forged PR number on a still-running state: the fallback does not adopt it.
{
  const result = await runWithTamper(54, (file) => {
    const s = JSON.parse(readFileSync(file, "utf8")) as WorkState;
    const forged: WorkState = { ...s, pipelineState: { ...s.pipelineState, prNumber: 999 } };
    writeFileSync(file, `${JSON.stringify(forged, null, 2)}\n`);
  });
  assert(result.exitCode === 30, `a forged running state exits 30 (got ${result.exitCode})`);
  assert(result.error?.code === "state-diverged", "a forged running state is state-diverged");
  assert(result.results[0]?.prNumber === undefined, "the forged PR number is not reported");
}

// ── 4. An untouched file: no error, the interrupt's own exit code.
{
  const result = await runWithTamper(53, () => undefined);
  assert(result.exitCode === 21, `an untouched file keeps exit 21 (got ${result.exitCode})`);
  assert(result.error === undefined, "an untouched file carries no error");
  assert(result.results[0]?.status === "interrupted", "the run's record reads interrupted");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
