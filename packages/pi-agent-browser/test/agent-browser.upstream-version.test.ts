import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  MINIMUM_AGENT_BROWSER_VERSION,
  TARGET_AGENT_BROWSER_VERSION,
  getAgentBrowserVersionValidationError,
  parseAgentBrowserVersionOutput,
} from "../extensions/agent-browser/lib/upstream-version.js";
import {
  createExtensionHarness,
  executeRegisteredTool,
  withPatchedEnv,
  writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("upstream version output accepts every well-formed version and rejects malformed output", () => {
  assert.equal(
    parseAgentBrowserVersionOutput(`agent-browser ${TARGET_AGENT_BROWSER_VERSION}\n`),
    TARGET_AGENT_BROWSER_VERSION,
  );
  for (const version of [
    MINIMUM_AGENT_BROWSER_VERSION,
    TARGET_AGENT_BROWSER_VERSION,
    "0.1.0",
    "1.0.0",
    "0.35.1-beta.1",
  ]) {
    assert.equal(getAgentBrowserVersionValidationError(`agent-browser ${version}\n`), undefined);
  }
  assert.match(getAgentBrowserVersionValidationError("v0.35.1\n") ?? "", /unrecognized value/);
});

test("browser-backed calls run despite upstream version drift", {
  concurrency: false,
}, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "piab-upstream-version-"));
  const logPath = join(tempDir, "invocations.log");
  try {
    await writeFakeAgentBrowserBinary(
      tempDir,
      `
if (__piabFakeArgs.includes("--version")) {
  process.stdout.write("agent-browser 0.33.20\\n");
  process.exit(0);
}
require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(__piabFakeArgs) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { url: "https://example.com" } }));
`,
    );
    await withPatchedEnv(
      {
        PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
        PI_AGENT_BROWSER_TEST_CUSTOM_VERSION: "1",
      },
      async () => {
        const harness = createExtensionHarness({ cwd: tempDir });
        const result = await executeRegisteredTool(harness.tool, harness.ctx, {
          args: ["open", "https://example.com"],
        });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.match(await readFile(logPath, "utf8"), /open/);
        assert.doesNotMatch(result.content[0]?.text ?? "", /unsupported|Install agent-browser/);

        const inspection = await executeRegisteredTool(harness.tool, harness.ctx, {
          args: ["--version"],
        });
        assert.equal(inspection.isError, false);
        assert.match(inspection.content[0]?.text ?? "", /0\.33\.20/);

        const doctor = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["doctor"] });
        assert.equal(doctor.isError, false, JSON.stringify(doctor));
        assert.match(await readFile(logPath, "utf8"), /doctor/);
      },
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
