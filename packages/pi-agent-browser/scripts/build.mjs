#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the published Pi package loads.
 * Responsibilities: Remove stale dist output, run TypeScript emit through the local compiler, and fail with clear build output.
 * Scope: Maintainer/package build only; runtime behavior remains in extensions/agent-browser TypeScript sources.
 * Usage: `npm run build` before package verification, lifecycle validation, and npm pack/publish.
 * Invariants/Assumptions: `node_modules` is installed and provides `typescript`; deleting `dist/` is safe because it is generated output.
 */

import { execFile as execFileCallback } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const tscPath = require.resolve("typescript/bin/tsc");

async function main() {
  await rm(join(process.cwd(), "dist"), {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
  try {
    const { stderr, stdout } = await execFile(
      process.execPath,
      [tscPath, "-p", "tsconfig.build.json"],
      {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (error) {
    if (error?.stdout) process.stdout.write(error.stdout);
    if (error?.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
