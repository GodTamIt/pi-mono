import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const cliVersion = process.env.PI_TPS_CLI_VERSION ?? "1.1.0";
const root = mkdtempSync(join(tmpdir(), "pi-tps-smoke-"));
const packDir = join(root, "pack");
const installDir = join(root, "install");
const homeDir = join(root, "home");
const agentDir = join(homeDir, ".pi", "agent");
const workDir = join(root, "work");
const env = {
  ...process.env,
  HOME: homeDir,
  USERPROFILE: homeDir,
  XDG_CONFIG_HOME: join(homeDir, ".config"),
  XDG_CACHE_HOME: join(homeDir, ".cache"),
  XDG_DATA_HOME: join(homeDir, ".local", "share"),
  XDG_STATE_HOME: join(homeDir, ".local", "state"),
  PI_CODING_AGENT_DIR: agentDir,
  PI_NO_UPDATE_CHECK: "1",
  PI_OFFLINE: "1",
  PATH: `${join(installDir, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
};
let child;
let closed;
let spawnError;
let stderr = "";
const messages = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const result = predicate();
    if (result) return result;
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Pi exited with ${child.exitCode} waiting for ${label}: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}: ${stderr}\n${JSON.stringify(messages)}`);
}

async function request(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  const response = await waitFor(
    () => messages.find((message) => message.type === "response" && message.id === payload.id),
    payload.type,
  );
  assert(response.success, `${payload.type} failed: ${JSON.stringify(response)}`);
  return response;
}

try {
  for (const directory of [packDir, installDir, agentDir, workDir]) {
    mkdirSync(directory, { recursive: true });
  }
  execFileSync("npm", ["run", "pack:inspect"], { cwd: packageDir, stdio: "inherit" });
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
  writeFileSync(join(installDir, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--prefer-online",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      join(packDir, packed.filename),
      `@earendil-works/pi-coding-agent@${cliVersion}`,
      `@earendil-works/pi-tui@${cliVersion}`,
    ],
    { cwd: installDir, stdio: "inherit", timeout: 180_000 },
  );
  const installed = join(installDir, "node_modules", "@ohgodtamit", "pi-tps");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const sourceManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  assert(
    manifest.name === sourceManifest.name && manifest.version === sourceManifest.version,
    `Unexpected packed package: ${manifest.name}@${manifest.version}`,
  );
  assert(
    manifest.exports?.["."]?.types === "./dist/pi-tps.d.ts" &&
      manifest.exports["."].import === "./extensions/pi-tps.ts",
    `Unexpected packed root export: ${JSON.stringify(manifest.exports?.["."])}`,
  );
  assert(
    JSON.stringify(manifest.pi?.extensions) === JSON.stringify(["./extensions/pi-tps.ts"]),
    `Unexpected packed extension entries: ${JSON.stringify(manifest.pi?.extensions)}`,
  );
  assert(existsSync(join(installed, "dist", "pi-tps.d.ts")), "Packed declarations missing");
  for (const peer of Object.keys(manifest.peerDependencies)) {
    const resolved = fileURLToPath(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", "console.log(import.meta.resolve(process.argv[1]))", peer],
        { cwd: join(installed, "extensions"), encoding: "utf8", env },
      ).trim(),
    );
    assert(
      resolved.startsWith(join(installDir, "node_modules", ...peer.split("/")) + sep),
      `${peer} resolved outside the isolated install`,
    );
    assert(
      !existsSync(join(installed, "node_modules", ...peer.split("/"))),
      `${peer} was nested in the extension`,
    );
  }
  // Import in a subprocess so even module-level config reads use the temporary home.
  const importHarness = join(installDir, "import.mjs");
  writeFileSync(
    importHarness,
    `import { createRequire } from "node:module";\n` +
      `const require = createRequire(import.meta.url);\n` +
      `const { createJiti } = require("jiti");\n` +
      `const loaded = await createJiti(import.meta.url).import("@ohgodtamit/pi-tps");\n` +
      `if (typeof loaded.default !== "function") throw new Error("Missing extension factory");\n`,
  );
  execFileSync(process.execPath, [importHarness], {
    cwd: installDir,
    env,
    stdio: "inherit",
    timeout: 20_000,
  });
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ packages: [installed], defaultProjectTrust: "never" })}\n`,
  );
  const cli = join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "pi.cmd" : "pi",
  );
  child = spawn(cli, ["--mode", "rpc", "--no-session", "--offline"], {
    cwd: workDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => {
      spawnError = error;
      resolve({ error });
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.setEncoding("utf8");
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      try {
        messages.push(JSON.parse(line));
      } catch {
        stderr += `\nNon-JSON stdout: ${line}`;
      }
      newline = pending.indexOf("\n");
    }
  });
  const commands = await request({ id: "commands", type: "get_commands" });
  assert(
    commands.data?.commands?.some(
      (command) => command.name === "pi-tps" && command.source === "extension",
    ),
    `Pi loader did not register /pi-tps: ${JSON.stringify(commands)}\n${stderr}`,
  );
  child.stdin.write(`${JSON.stringify({ id: "configure", type: "prompt", message: "/pi-tps" })}\n`);
  const select = await waitFor(
    () =>
      messages.find(
        (message) => message.type === "extension_ui_request" && message.method === "select",
      ),
    "TPS settings select",
  );
  const choice = select.options.find((option) => option.startsWith("Detailed traces count"));
  assert(choice, `Missing detailed traces setting: ${JSON.stringify(select)}`);
  child.stdin.write(
    `${JSON.stringify({ type: "extension_ui_response", id: select.id, value: choice })}\n`,
  );
  const input = await waitFor(
    () =>
      messages.find(
        (message) => message.type === "extension_ui_request" && message.method === "input",
      ),
    "TPS numeric input",
  );
  child.stdin.write(
    `${JSON.stringify({ type: "extension_ui_response", id: input.id, value: "7" })}\n`,
  );
  const configured = await waitFor(
    () => messages.find((message) => message.type === "response" && message.id === "configure"),
    "configuration response",
  );
  assert(configured.success, `Configuration failed: ${JSON.stringify(configured)}`);
  await waitFor(
    () =>
      messages.find(
        (message) => message.method === "notify" && message.message === "maxDetailed = 7",
      ),
    "configuration notification",
  );
  const configPath = join(agentDir, "pi-tps.json");
  await waitFor(() => {
    if (!existsSync(configPath)) return false;
    try {
      return JSON.parse(readFileSync(configPath, "utf8")).maxDetailed === 7;
    } catch {
      return false;
    }
  }, "persisted configuration");
  const state = await request({ id: "state", type: "get_state" });
  assert(!state.data.isStreaming, "Configuration unexpectedly started a model request");
  child.stdin.end();
  let shutdownTimer;
  const exit = await Promise.race([
    closed,
    new Promise((_, reject) => {
      shutdownTimer = setTimeout(
        () => reject(new Error(`Pi shutdown timed out: ${stderr}`)),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(shutdownTimer));
  assert(exit.code === 0 && !exit.signal, `Unclean Pi exit: ${JSON.stringify(exit)}\n${stderr}`);
  assert(!stderr.trim(), `Unexpected Pi diagnostics: ${stderr}`);
  assert(
    !messages.some(
      (message) => message.type === "extension_error" || message.notifyType === "error",
    ),
    `Extension errors: ${JSON.stringify(messages)}`,
  );
  console.log(
    `Packed pi-tps loads and configures via actual Pi ${cliVersion} RPC without credentials.`,
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
  rmSync(root, { recursive: true, force: true });
}
