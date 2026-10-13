/**
 * lens-exec — the shared shell executor that honours the argv form.
 *
 * It began as the lens review's executor (lens-review-diff.ts and
 * lens-review.ts): both needed a `VerifyExecFn`-shaped executor for their
 * `git` reads, and keeping ONE exported instance (item 6b of the #973 review
 * fixes) means the two paths share the exact same argv contract instead of
 * each defining its own closure over `exec`.
 *
 * It is now also the production stand-in for `ctx.verifyExecFn` in the
 * driver modules that used a bare `promisify(exec)` for it. `VerifyExecFn`
 * declares `argv`, and `promisify(exec)` type-checks as one while silently
 * dropping it — an argv-form call then runs a bare `git`, which prints usage
 * and exits 1 (`Command failed: git`, empty stderr). The merged step's
 * checkout restore reached argv-form calls through such a default.
 * `test-exec-argv-contract.ts` fails if a shell-only executor is handed on
 * as a value again, and lists the few that still are with the reason.
 */

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VerifyExecFn } from "./work-driver-git.ts";

const execShell = promisify(exec);
const execFileP = promisify(execFile);

/** The ONE shell executor the lens review's git reads go through.
 * #1005 — argv form: when `opts.argv` is present, `cmd` is the executable
 * and `argv` its arguments, run via execFile (no shell re-parse). When
 * absent, the classic shell path runs. Either way it settles in
 * `promisify(exec)`'s shape, so a rejection carries `stdout` / `stderr`. */
export const execp: VerifyExecFn = (cmd, opts) => {
  const { argv, ...rest } = opts ?? {};
  if (argv) return execFileP(cmd, argv, { ...rest, encoding: "utf8" });
  return execShell(cmd, { ...rest, encoding: "utf8" });
};
