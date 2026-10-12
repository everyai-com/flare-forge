#!/usr/bin/env node
// Publish the CLI (`flare-forge` on npm) from a packed tarball.
//
//   npm run publish:cli               # build, pack, verify, publish
//   npm run publish:cli -- --dry-run  # everything but the upload
//   npm run publish:cli -- --otp 123456
//
// Why a tarball: inside this monorepo npm resolves the package against
// the workspace root, so `npm publish --workspace apps/cli` (and even
// `npm publish` from apps/cli) strips both `bin` entries as "invalid"
// (npm 11.6, seen 2026-10-12): the published package would install with
// no `flare-forge` command. Publishing the packed .tgz keeps them. This
// script also refuses to publish if the packed manifest lost its bins.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".npm-pack");
const pass = process.argv.slice(2);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: opts.capture ? "pipe" : "inherit" });
  if (r.status !== 0) {
    if (opts.capture) process.stderr.write(r.stderr || "");
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
  }
  return r.stdout ?? "";
}

const pkg = JSON.parse(readFileSync(join(ROOT, "apps/cli/package.json"), "utf8"));
const tgz = join(OUT, `${pkg.name}-${pkg.version}.tgz`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
run("npm", ["run", "build:cli"]);
run("npm", ["pack", "--workspace", "apps/cli", "--pack-destination", OUT]);

const manifest = JSON.parse(run("tar", ["xzf", tgz, "-O", "package/package.json"], { capture: true }));
const files = run("tar", ["tzf", tgz], { capture: true }).split("\n");
const bins = Object.entries(manifest.bin ?? {});
const missing = bins.filter(([, target]) => !files.includes(`package/${String(target).replace(/^\.\//, "")}`));
if (bins.length < 2 || missing.length || !files.includes("package/dist/cli.mjs")) {
  throw new Error(`packed manifest is not publishable: bins ${JSON.stringify(manifest.bin)}, missing ${JSON.stringify(missing)}`);
}
console.log(`publish:cli: ${pkg.name}@${pkg.version}, bins ${bins.map(([k]) => k).join(", ")} -> ${bins[0][1]}`);
run("npm", ["publish", tgz, ...pass]);
