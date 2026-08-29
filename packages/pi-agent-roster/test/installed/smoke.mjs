import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-agent-roster-smoke-"));
const packDir = join(root, "pack");
const cliDir = join(root, "cli");
const agentDir = join(root, "pi-home", "agent");
const workDir = join(root, "work");
const childWorkDir = join(root, "child-work");
const parentSessionDir = join(root, "parent-sessions");
const observerDir = join(root, "observer");
const observerLog = join(root, "observer.jsonl");
const npmArgs = ["--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"];
const children = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeAgent(directory, name, contents) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), contents);
}

async function runRpc(cli, args, id) {
  const child = spawn(cli, ["--mode", "rpc", "--no-session", ...args], {
    cwd: workDir,
    env: {
      ...process.env,
      OPENAI_API_KEY: "installed-smoke-not-a-real-key",
      PATH: `${join(cliDir, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_NO_UPDATE_CHECK: "1",
      ROSTER_OBSERVER_LOG: observerLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const messages = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {
      stderr += `\nNon-JSON stdout: ${line}`;
    }
  });
  const request = async (payload) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = messages.find(
        (message) => message.type === "response" && message.id === payload.id,
      );
      if (response) return response;
      if (child.exitCode !== null) throw new Error(`Pi exited with ${child.exitCode}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${payload.type}: ${stderr}`);
  };
  const commands = await request({ id, type: "get_commands" });
  return {
    child,
    commands,
    messages,
    stderr: () => stderr,
    request,
    async close() {
      if (child.exitCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
      children.delete(child);
    },
  };
}

try {
  for (const directory of [
    packDir,
    cliDir,
    agentDir,
    workDir,
    childWorkDir,
    parentSessionDir,
    observerDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  execFileSync("npm", ["run", "declarations"], { cwd: packageDir, stdio: "inherit" });
  const parsed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: packageDir,
      encoding: "utf8",
    }),
  );
  const candidates = Array.isArray(parsed) ? parsed : [parsed, ...Object.values(parsed)];
  const packed = candidates.find(
    (candidate) => candidate && typeof candidate.filename === "string",
  );
  if (!packed) throw new Error("npm pack output did not contain a filename");
  const tarball = join(packDir, packed.filename);

  writeFileSync(join(cliDir, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      ...npmArgs,
      tarball,
      "@earendil-works/pi-coding-agent@0.84.3",
      "@earendil-works/pi-ai@0.84.3",
      "@earendil-works/pi-tui@0.84.3",
      "typebox@1.3.7",
    ],
    { cwd: cliDir, stdio: "inherit" },
  );

  const installedPackage = join(cliDir, "node_modules", "pi-agent-roster");
  const installedManifest = JSON.parse(
    readFileSync(join(installedPackage, "package.json"), "utf8"),
  );
  assert(
    installedManifest.version === "0.0.0",
    `Unexpected packed version: ${installedManifest.version}`,
  );
  for (const peer of Object.keys(installedManifest.peerDependencies ?? {})) {
    const resolved = fileURLToPath(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", "console.log(import.meta.resolve(process.argv[1]))", peer],
        { cwd: join(installedPackage, "src"), encoding: "utf8" },
      ).trim(),
    );
    const expectedRoot = join(cliDir, "node_modules", ...peer.split("/")) + sep;
    assert(
      resolved.startsWith(expectedRoot),
      `Peer ${peer} resolved outside the isolated peer install: ${resolved}`,
    );
    assert(
      !existsSync(join(installedPackage, "node_modules", ...peer.split("/"))),
      `Peer ${peer} was nested inside the packed extension`,
    );
  }

  writeFileSync(
    join(observerDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module", pi: { extensions: ["./index.mjs"] } })}\n`,
  );
  writeFileSync(
    join(observerDir, "index.mjs"),
    `import { appendFileSync } from "node:fs";\n` +
      `const key = Symbol.for("pi-agent-roster:installed-observer");\n` +
      `const records = globalThis[key] ??= [];\n` +
      `const save = (entry) => { records.push(entry); if (process.env.ROSTER_OBSERVER_LOG) appendFileSync(process.env.ROSTER_OBSERVER_LOG, JSON.stringify(entry) + "\\n"); };\n` +
      `export default function (pi) {\n` +
      `  pi.on("session_start", (_event, ctx) => save({ type: "start", cwd: ctx.cwd, tools: pi.getActiveTools(), model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : null, prompt: ctx.getSystemPrompt() }));\n` +
      `  pi.on("before_agent_start", (event, ctx) => save({ type: "before", cwd: ctx.cwd, event: JSON.parse(JSON.stringify(event)) }));\n` +
      `  pi.on("session_shutdown", (_event, ctx) => save({ type: "shutdown", cwd: ctx.cwd }));\n` +
      `}\n`,
  );

  const globalAgents = join(agentDir, "agents");
  const projectAgents = join(workDir, ".pi", "agents");
  writeAgent(
    globalAgents,
    "actual-pi",
    `---\ndescription: Global definition that must be overridden\nmode: subagent\nmodel: roster-faux/roster-faux-model\ntools: read\n---\nGLOBAL_AGENT_PROMPT_must_not_win\n`,
  );
  writeAgent(
    globalAgents,
    "global-worker",
    `---\ndescription: Globally installed child\nmode: subagent\nmodel: roster-faux/roster-faux-model\ntools: read\n---\nGLOBAL_WORKER_PROMPT_0f81\n`,
  );
  writeAgent(
    globalAgents,
    "primary-only",
    `---\ndescription: Globally installed primary\nmode: primary\nmodel: openai/gpt-4.1-mini\ntools: read\n---\nPRIMARY_ONLY_PROMPT_f803\n`,
  );
  writeAgent(
    projectAgents,
    "actual-pi",
    `---\ndescription: Project override used by installed lifecycle runs\nmode: all\nmodel: roster-faux/roster-faux-model\ndefault_stack: fast\nstacks:\n  fast:\n    model: roster-faux/roster-faux-model\n    thinking: low\n  deep:\n    model: roster-faux/roster-faux-deep\n    thinking: high\ntools: read\n---\nPROJECT_AGENT_PROMPT_594a\n`,
  );
  writeAgent(
    projectAgents,
    "layered",
    `---\ndescription: Project CLI primary\nmode: all\ndefault_stack: quick\nstacks:\n  quick:\n    model: openai/gpt-4.1-mini\n    thinking: low\n  thorough:\n    model: openai/gpt-4.1\n    thinking: high\ntools: read\n---\nPROJECT_PRIMARY_PROMPT_31af\n`,
  );
  mkdirSync(join(workDir, ".pi"), { recursive: true });
  writeFileSync(
    join(workDir, ".pi", "agent-roster.json"),
    `${JSON.stringify({ maxConcurrent: 1, consumedSessionRetentionMinutes: 1, excludedExtensionPackages: [installedPackage] }, null, 2)}\n`,
  );
  writeFileSync(join(childWorkDir, "marker.txt"), "CHILD_WORKSPACE_f24a3d\n");
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ packages: [installedPackage, observerDir], defaultProjectTrust: "never" }, null, 2)}\n`,
  );

  const cli = join(cliDir, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const selectedCli = await runRpc(
    cli,
    ["--roster-name", "installed-smoke", "--agent", "layered", "--stack", "thorough"],
    "commands-selected",
  );
  assert(
    selectedCli.commands.success &&
      selectedCli.commands.data.commands.some((command) => command.name === "roster-status"),
    `roster-status was not registered: ${JSON.stringify(selectedCli.commands)}`,
  );
  const status = await selectedCli.request({
    id: "status",
    type: "prompt",
    message: "/roster-status",
  });
  assert(status.success, `roster-status failed: ${JSON.stringify(status)}`);
  const statusDeadline = Date.now() + 5_000;
  while (
    Date.now() < statusDeadline &&
    !selectedCli.messages.some((message) =>
      JSON.stringify(message).includes("Roster installed-smoke: roster_noop ready"),
    )
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert(
    selectedCli.messages.some((message) =>
      JSON.stringify(message).includes("Roster installed-smoke: roster_noop ready"),
    ),
    `Flag/tool status was not observed: ${JSON.stringify(selectedCli.messages)}\n${selectedCli.stderr()}`,
  );
  await selectedCli.close();

  const observerEntries = existsSync(observerLog)
    ? readFileSync(observerLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const cliStart = observerEntries.find((entry) => entry.type === "start" && entry.cwd === workDir);
  assert(
    cliStart?.model === "openai/gpt-4.1",
    `--agent/--stack did not select the requested model: ${JSON.stringify(cliStart)}`,
  );

  const invalidCli = await runRpc(cli, ["--agent", "global-worker"], "commands-invalid");
  const invalidDeadline = Date.now() + 5_000;
  while (
    Date.now() < invalidDeadline &&
    !invalidCli.messages.some((message) =>
      JSON.stringify(message).includes("not an enabled primary/all agent"),
    )
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert(
    invalidCli.messages.some((message) =>
      JSON.stringify(message).includes("not an enabled primary/all agent"),
    ),
    `--agent accepted a subagent-only profile: ${JSON.stringify(invalidCli.messages)}\n${invalidCli.stderr()}`,
  );
  await invalidCli.close();

  console.log("Packed Pi loaded layered agents and honored installed --agent/--stack selection.");

  const actualPiHarness = join(cliDir, "actual-pi.mjs");
  writeFileSync(
    actualPiHarness,
    readFileSync(join(packageDir, "test", "installed", "actual-pi.mjs"), "utf8"),
  );
  execFileSync(
    process.execPath,
    [actualPiHarness, agentDir, workDir, childWorkDir, parentSessionDir, installedPackage],
    {
      cwd: cliDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_NO_UPDATE_CHECK: "1" },
      stdio: "inherit",
    },
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(
    [...children].map((child) => (child.exitCode === null ? once(child, "close") : undefined)),
  );
  rmSync(root, { recursive: true, force: true });
}
