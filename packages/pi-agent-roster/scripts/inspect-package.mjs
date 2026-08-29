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
  "dist/layered-settings.d.ts",
  "dist/public.d.ts",
  "package.json",
  "src/index.ts",
  "src/public.ts",
  "src/service/service.ts",
];
for (const path of required) {
  if (!files.includes(path)) throw new Error(`Package is missing ${path}`);
}

const sourceFiles = new Set([
  "src/config/agent-types.ts",
  "src/config/custom-agents.ts",
  "src/config/invocation-config.ts",
  "src/config/tool-permissions.ts",
  "src/debug.ts",
  "src/handlers/index.ts",
  "src/handlers/interrupt.ts",
  "src/handlers/lifecycle.ts",
  "src/handlers/tool-start.ts",
  "src/index.ts",
  "src/layered-settings.ts",
  "src/lifecycle/child-lifecycle.ts",
  "src/lifecycle/child-runtime-baseline.ts",
  "src/lifecycle/child-shutdown.ts",
  "src/lifecycle/concurrency-limiter.ts",
  "src/lifecycle/create-subagent-session.ts",
  "src/lifecycle/run-listeners.ts",
  "src/lifecycle/subagent-manager.ts",
  "src/lifecycle/subagent-session.ts",
  "src/lifecycle/subagent-state.ts",
  "src/lifecycle/subagent.ts",
  "src/lifecycle/turn-limits.ts",
  "src/lifecycle/usage.ts",
  "src/lifecycle/workspace-bracket.ts",
  "src/lifecycle/workspace.ts",
  "src/observation/composite-subagent-observer.ts",
  "src/observation/notification.ts",
  "src/observation/record-observer.ts",
  "src/observation/renderer.ts",
  "src/observation/subagent-events-observer.ts",
  "src/primary/controller.ts",
  "src/public.ts",
  "src/runtime.ts",
  "src/service/service-adapter.ts",
  "src/service/service.ts",
  "src/session/content-items.ts",
  "src/session/context.ts",
  "src/session/conversation.ts",
  "src/session/env.ts",
  "src/session/model-resolver.ts",
  "src/session/package-exclusions.ts",
  "src/session/prompts.ts",
  "src/session/session-config.ts",
  "src/session/session-dir.ts",
  "src/settings.ts",
  "src/stacks/index.ts",
  "src/stacks/stack-resolver.ts",
  "src/tools/agent-tool.ts",
  "src/tools/background-spawner.ts",
  "src/tools/foreground-runner.ts",
  "src/tools/get-result-report.ts",
  "src/tools/get-result-tool.ts",
  "src/tools/helpers.ts",
  "src/tools/invocation-row.ts",
  "src/tools/result-renderer.ts",
  "src/tools/spawn-config.ts",
  "src/tools/steer-tool.ts",
  "src/types.ts",
  "src/ui/agent-widget.ts",
  "src/ui/display.ts",
  "src/ui/glyphs.ts",
  "src/ui/roster-picker.ts",
  "src/ui/session-navigation.ts",
  "src/ui/session-navigator.ts",
  "src/ui/subagents-settings.ts",
  "src/ui/transcript-content.ts",
  "src/ui/widget-renderer.ts",
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
const mediaFiles = new Set([
  "media/quick-start.cast",
  "media/quick-start.svg",
  "media/terminal-dark.svg",
  "media/terminal-light.svg",
  "media/terminal-narrow-dark.svg",
  "media/terminal-narrow-light.svg",
]);

function isAllowed(path) {
  return (
    topLevel.has(path) ||
    sourceFiles.has(path) ||
    declarationFiles.has(path) ||
    mediaFiles.has(path)
  );
}

const unexpected = files.filter((path) => !isAllowed(path));
if (unexpected.length > 0) {
  throw new Error(`Unexpected package contents:\n${unexpected.join("\n")}`);
}
if (files.some((path) => path.includes("node_modules/") || path.startsWith("node_modules/"))) {
  throw new Error("Package contains a nested node_modules runtime");
}
if (Array.isArray(manifest.bundled) && manifest.bundled.length > 0) {
  throw new Error(`Package unexpectedly bundles dependencies: ${manifest.bundled.join(", ")}`);
}

console.log(
  `${files.length} files inspected against the production/docs/media allowlist; no bundled runtime.`,
);
