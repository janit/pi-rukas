#!/usr/bin/env bun
/**
 * #1189 — `pi-rukas-headless` is on PATH in the image, as a link in
 * /usr/local/bin. The wrapper must follow that link back to the checkout: run
 * through an absolute and a relative symlink, a bad argument still reaches the
 * runner (exit 40, a bad-arguments JSON error), not a missing-module error.
 * The Dockerfile must create the link.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const repo = path.resolve(import.meta.dir, "..", "..");
const wrapper = path.join(repo, "bin", "pi-rukas-headless");
const dir = mkdtempSync(path.join(tmpdir(), "headless-link-"));
try {
  mkdirSync(path.join(dir, "abs"));
  mkdirSync(path.join(dir, "rel"));
  const abs = path.join(dir, "abs", "pi-rukas-headless");
  const rel = path.join(dir, "rel", "pi-rukas-headless");
  symlinkSync(wrapper, abs);
  symlinkSync("../abs/pi-rukas-headless", rel);
  for (const [label, bin] of [
    ["absolute", abs],
    ["relative", rel],
  ] as const) {
    const r = spawnSync(bin, ["work", "--bogus"], { encoding: "utf8", cwd: dir });
    assert(r.status === 40, `via the ${label} link: exit 40 (got ${r.status}; ${r.stderr.trim()})`);
    assert(/"code":"bad-arguments"/.test(r.stdout), `via the ${label} link: the runner answered`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const dockerfile = readFileSync(path.join(repo, ".devcontainer", "Dockerfile"), "utf8");
assert(
  /ln -s \$\{PI_ENSEMBLE_DIR\}\/bin\/pi-rukas-headless \/usr\/local\/bin\/pi-rukas-headless/.test(
    dockerfile,
  ),
  "the image links pi-rukas-headless into /usr/local/bin",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
