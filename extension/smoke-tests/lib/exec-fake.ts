/**
 * #69 — the executor a smoke test hands to driver code (`verifyExecFn`, the
 * `execFn` a driver helper takes) when the test wants REAL git.
 *
 * Since #34 every production executor honours the argv form —
 * `execFn("git", { cwd, argv: [...] })`. A test fake that runs `cmd` through
 * `sh -c` and ignores `argv` turns such a call into a bare `git`: usage on
 * stdout, exit 1. The driver then takes its failure path, and the test
 * passes while exercising something other than what it claims (#67 found
 * four). This is production's own executor (lens-exec.ts) re-exported, so
 * a test cannot drift from the contract it stands in for: argv form via
 * execFile, string form via the shell, rejections in `promisify(exec)`'s
 * shape (`stdout`, `stderr`, `code`).
 *
 * A fake that scripts some commands and forwards the rest should match on
 * `commandOf(cmd, opts)` (argv-shell.ts) and forward `opts` unchanged.
 * `test-exec-argv-contract.ts` fails if a test hands on a shell-only one.
 */

export { execp as realExec } from "../../src/lens-exec.ts";
