import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const sourceManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const expectedEntrypoint = "./dist/extensions/agent-browser/index.js";
const expectedPiMetadata = { extensions: [expectedEntrypoint] };
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
  const installed = join(installDir, "node_modules", ...sourceManifest.name.split("/"));
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (manifest.name !== sourceManifest.name) throw new Error(`Unexpected name ${manifest.name}`);
  if (manifest.version !== sourceManifest.version)
    throw new Error(`Unexpected version ${manifest.version}`);
  if (manifest.exports?.["."] !== expectedEntrypoint)
    throw new Error(`Unexpected root export ${JSON.stringify(manifest.exports?.["."])}`);
  if (JSON.stringify(manifest.pi) !== JSON.stringify(expectedPiMetadata))
    throw new Error(`Unexpected pi metadata ${JSON.stringify(manifest.pi)}`);
  for (const binName of Object.keys(sourceManifest.bin)) {
    const executable = join(
      installDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? `${binName}.cmd` : binName,
    );
    if (!existsSync(executable)) throw new Error(`${binName} bin was not installed`);
  }
  const importCheck = join(installDir, "import-package.mjs");
  writeFileSync(
    importCheck,
    `import extension from ${JSON.stringify(sourceManifest.name)};\n` +
      'if (typeof extension !== "function") throw new Error("Packed Pi extension did not load");\n',
  );
  execFileSync(process.execPath, [importCheck], { cwd: installDir, stdio: "inherit" });
  console.log("Packed pi-agent-browser root export and public bins load from an isolated install.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
