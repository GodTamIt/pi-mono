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

const files = manifest.files
  .map((file) => {
    if (!file || typeof file.path !== "string") {
      throw new Error("npm pack output contained a file without a path");
    }
    return file.path;
  })
  .sort();

const required = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/public.d.ts",
  "dist/layered-settings.d.ts",
  "package.json",
  "src/index.ts",
  "src/public.ts",
  "src/service/service.ts",
];
for (const path of required) {
  if (!files.includes(path)) throw new Error(`Package is missing ${path}`);
}
const forbidden = files.filter(
  (path) =>
    path.startsWith("media/") ||
    path.includes("default-agents") ||
    path.includes("parent-snapshot"),
);
if (forbidden.length > 0) throw new Error(`Unexpected package contents:\n${forbidden.join("\n")}`);

console.log(
  `${files.length} files inspected; production sources and declarations present; no media or built-in agents.`,
);
