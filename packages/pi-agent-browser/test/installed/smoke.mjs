import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = new URL("../..", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "pi-agent-browser-smoke-"));
try {
  const packDir = join(root, "pack");
  const installDir = join(root, "install");
  mkdirSync(packDir);
  mkdirSync(installDir);
  execFileSync("npm", ["run", "build"], { cwd: packageDir, stdio: "inherit" });
  const packResult = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: packageDir,
      encoding: "utf8",
    }),
  );
  const packed = (
    Array.isArray(packResult) ? packResult : [packResult, ...Object.values(packResult)]
  ).find((item) => typeof item?.filename === "string");
  if (!packed) throw new Error("npm pack output did not contain a filename");
  writeFileSync(join(installDir, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      join(packDir, packed.filename),
      "@earendil-works/pi-coding-agent@0.84.3",
      "@earendil-works/pi-ai@0.84.3",
      "@earendil-works/pi-tui@0.84.3",
      "typebox@1.3.7",
    ],
    { cwd: installDir, stdio: "inherit" },
  );
  const installed = join(installDir, "node_modules", "@ohgodtamit", "pi-agent-browser");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (manifest.version !== "0.1.0") throw new Error(`Unexpected version ${manifest.version}`);
  if (
    !existsSync(
      join(
        installDir,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "pi-agent-browser-doctor.cmd" : "pi-agent-browser-doctor",
      ),
    )
  )
    throw new Error("Doctor bin was not installed");
  const extension = await import(
    pathToFileURL(join(installed, "dist", "extensions", "agent-browser", "index.js")).href
  );
  if (typeof extension.default !== "function") throw new Error("Packed Pi extension did not load");
  console.log("Packed pi-agent-browser extension and public bins load from an isolated install.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
