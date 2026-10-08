import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageDir,
  encoding: "utf8",
});
const parsed = JSON.parse(output);
const candidates = Array.isArray(parsed) ? parsed : [parsed, ...Object.values(parsed)];
const manifest = candidates.find((candidate) => candidate && Array.isArray(candidate.files));
if (!manifest) throw new Error("npm pack output did not contain a files array");

const files = manifest.files.map((file) => file.path).sort();
const allowed = new Set([
  "extensions/pi-tps.ts",
  "dist/pi-tps.d.ts",
  "dist/pi-tps.d.ts.map",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
]);
const unexpected = files.filter((path) => !allowed.has(path));
if (unexpected.length > 0)
  throw new Error(`Unexpected package contents:\n${unexpected.join("\n")}`);
for (const path of allowed) {
  if (!files.includes(path)) throw new Error(`Package is missing ${path}`);
}
if (files.some((path) => path.includes("node_modules/"))) {
  throw new Error("Package contains a nested node_modules runtime");
}
if (Array.isArray(manifest.bundled) && manifest.bundled.length > 0) {
  throw new Error(`Package unexpectedly bundles dependencies: ${manifest.bundled.join(", ")}`);
}
console.log(`${files.length} files inspected against the package allowlist; no bundled runtime.`);
