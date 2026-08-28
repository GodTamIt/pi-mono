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
if (!manifest) {
  throw new Error("npm pack output did not contain a files array");
}
const files = manifest.files
  .map((file) => {
    if (!file || typeof file.path !== "string") {
      throw new Error("npm pack output contained a file without a path");
    }
    return file.path;
  })
  .sort();
const expected = [
  "CHANGELOG.md",
  "README.md",
  "dist/public.d.ts",
  "dist/public.d.ts.map",
  "package.json",
  "src/index.ts",
  "src/public.ts",
];

if (JSON.stringify(files) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected package contents:\n${files.join("\n")}`);
}

console.log(files.join("\n"));
