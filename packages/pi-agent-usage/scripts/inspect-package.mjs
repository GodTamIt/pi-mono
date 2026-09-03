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
const sourceFiles = new Set([
  "src/aggregate.ts",
  "src/cache.ts",
  "src/config.ts",
  "src/format.ts",
  "src/freshness.ts",
  "src/index.ts",
  "src/mascot.ts",
  "src/prices.ts",
  "src/provider.ts",
  "src/view.ts",
  "src/zai.ts",
]);
const declarationFiles = new Set(
  [...sourceFiles].flatMap((path) => {
    const declaration = `dist/${path.slice(4, -3)}.d.ts`;
    return [declaration, `${declaration}.map`];
  }),
);
const topLevel = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
]);
const unexpected = files.filter(
  (path) => !topLevel.has(path) && !sourceFiles.has(path) && !declarationFiles.has(path),
);
if (unexpected.length > 0)
  throw new Error(`Unexpected package contents:\n${unexpected.join("\n")}`);
for (const path of [...topLevel, ...sourceFiles, ...declarationFiles]) {
  if (!files.includes(path)) throw new Error(`Package is missing ${path}`);
}
if (files.some((path) => path.includes("node_modules/"))) {
  throw new Error("Package contains a nested node_modules runtime");
}
if (Array.isArray(manifest.bundled) && manifest.bundled.length > 0) {
  throw new Error(`Package unexpectedly bundles dependencies: ${manifest.bundled.join(", ")}`);
}
console.log(`${files.length} files inspected against the package allowlist; no bundled runtime.`);
