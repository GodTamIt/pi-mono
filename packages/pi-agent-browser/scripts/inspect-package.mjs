import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const result = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageDir, encoding: "utf8" }),
);
const candidates = Array.isArray(result) ? result : [result, ...Object.values(result)];
const manifest = candidates.find((item) => Array.isArray(item?.files));
if (!manifest) throw new Error("npm pack output did not contain a files array");
const files = manifest.files.map((item) => item.path);
for (const required of [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "dist/extensions/agent-browser/index.js",
  "scripts/config.mjs",
  "scripts/doctor.mjs",
  "docs/COMMAND_REFERENCE.md",
  "docs/RELEASE.md",
  "docs/TOOL_CONTRACT.md",
])
  if (!files.includes(required)) throw new Error(`Package is missing ${required}`);
const forbidden = files.filter(
  (path) =>
    path.startsWith("test/") ||
    path.startsWith("extensions/") ||
    path.includes("node_modules") ||
    path.includes("platform-smoke") ||
    path.includes("crabbox"),
);
if (forbidden.length) throw new Error(`Unexpected package contents:\n${forbidden.join("\n")}`);
if (manifest.bundled?.length)
  throw new Error(`Unexpected bundled dependencies: ${manifest.bundled.join(", ")}`);
console.log(
  `${files.length} production/docs files inspected; no tests, sources, automation, or bundled dependencies.`,
);
