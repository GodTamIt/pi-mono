import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-usage-smoke-"));
const packDir = join(root, "pack");
const installDir = join(root, "install");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  mkdirSync(packDir);
  mkdirSync(installDir);
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
      tarball,
      "@earendil-works/pi-coding-agent@0.84.3",
      "@earendil-works/pi-ai@0.84.3",
      "@earendil-works/pi-tui@0.84.3",
    ],
    { cwd: installDir, stdio: "inherit" },
  );
  const installed = join(installDir, "node_modules", "@ohgodtamit", "pi-usage");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert(manifest.version === "0.1.0", `Unexpected packed version: ${manifest.version}`);
  const require = createRequire(join(installDir, "package.json"));
  const { createJiti } = require("jiti");
  const loaded = await createJiti(import.meta.url).import(join(installed, "src", "index.ts"));
  assert(typeof loaded.default === "function", "Packed extension did not expose its entry point");
  for (const peer of Object.keys(manifest.peerDependencies)) {
    const resolved = fileURLToPath(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", "console.log(import.meta.resolve(process.argv[1]))", peer],
        { cwd: join(installed, "src"), encoding: "utf8" },
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
  console.log("Packed pi-usage imports with isolated peer dependencies.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
