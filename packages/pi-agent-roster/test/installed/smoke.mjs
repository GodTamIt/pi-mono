import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-agent-roster-smoke-"));
const packDir = join(root, "pack");
const cliDir = join(root, "cli");
const packageInstallDir = join(root, "pi-home", "npm", "roster");
const agentDir = join(root, "pi-home", "agent");
const workDir = join(root, "work");
const npmArgs = ["--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"];
let child;

try {
  for (const directory of [packDir, cliDir, packageInstallDir, agentDir, workDir]) {
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
  if (!packed) {
    throw new Error("npm pack output did not contain a filename");
  }
  const tarball = join(packDir, packed.filename);

  writeFileSync(join(cliDir, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync("npm", ["install", ...npmArgs, "@earendil-works/pi-coding-agent@0.84.3"], {
    cwd: cliDir,
    stdio: "inherit",
  });

  writeFileSync(join(packageInstallDir, "package.json"), '{"private":true,"type":"module"}\n');
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
    { cwd: packageInstallDir, stdio: "inherit" },
  );

  const installedPackage = join(packageInstallDir, "node_modules", "pi-agent-roster");
  const installedManifest = JSON.parse(
    readFileSync(join(installedPackage, "package.json"), "utf8"),
  );
  if (installedManifest.version !== "0.0.0") {
    throw new Error(`Unexpected packed version: ${installedManifest.version}`);
  }

  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ packages: [installedPackage], defaultProjectTrust: "never" }, null, 2)}\n`,
  );

  const cli = join(cliDir, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  child = spawn(cli, ["--mode", "rpc", "--no-session", "--roster-name", "installed-smoke"], {
    cwd: workDir,
    env: {
      ...process.env,
      PATH: `${join(cliDir, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_NO_UPDATE_CHECK: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const messages = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
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
      if (child.exitCode !== null) {
        throw new Error(`Pi exited with ${child.exitCode}: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${payload.type}: ${stderr}`);
  };

  const commands = await request({ id: "commands", type: "get_commands" });
  if (
    !commands.success ||
    !commands.data.commands.some((command) => command.name === "roster-status")
  ) {
    throw new Error(`roster-status was not registered: ${JSON.stringify(commands)}`);
  }

  const status = await request({ id: "status", type: "prompt", message: "/roster-status" });
  if (!status.success) {
    throw new Error(`roster-status failed: ${JSON.stringify(status)}`);
  }

  const deadline = Date.now() + 5_000;
  while (
    Date.now() < deadline &&
    !messages.some((message) =>
      JSON.stringify(message).includes("Roster installed-smoke: roster_noop ready"),
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (
    !messages.some((message) =>
      JSON.stringify(message).includes("Roster installed-smoke: roster_noop ready"),
    )
  ) {
    throw new Error(`Flag/tool status was not observed: ${JSON.stringify(messages)}\n${stderr}`);
  }

  console.log(
    "Pi 0.84.3 loaded the packed extension and registered its flag, command, and TypeBox tool.",
  );
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}
