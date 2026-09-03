/**
 * Layered discovery and validation for Markdown agent definitions.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { debugLog } from "../debug.ts";
import type {
  AgentConfig,
  AgentDiagnostic,
  AgentMode,
  AgentStackProfile,
  ThinkingLevel,
  ToolPermissions,
} from "../types.ts";
import { sanitizeTerminalText } from "../ui/display.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MODES = new Set<AgentMode>(["primary", "subagent", "all"]);
const MODEL_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export interface CustomAgentDiscovery {
  agents: Map<string, AgentConfig>;
  diagnostics: AgentDiagnostic[];
}

interface DiagnosticUi {
  notify(message: string, level: "warning"): void;
}

/** Routes each discovery diagnostic through the current session UI at most once. */
export class CustomAgentDiagnosticReporter {
  private latest = new Map<string, AgentDiagnostic>();
  private reported = new Set<string>();
  private ui: DiagnosticUi | undefined;

  reportScan(diagnostics: readonly AgentDiagnostic[]): void {
    this.latest = new Map(diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]));
    this.flush();
  }

  beginSession(ui: DiagnosticUi, reportBuffered = true): void {
    this.ui = ui;
    this.reported.clear();
    if (!reportBuffered) this.latest.clear();
    this.flush();
  }

  endSession(): void {
    this.ui = undefined;
  }

  private flush(): void {
    if (!this.ui) return;
    for (const [key, diagnostic] of this.latest) {
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      this.ui.notify(
        sanitizeTerminalText(`[pi-agent-roster] ${diagnostic.path}: ${diagnostic.message}`),
        "warning",
      );
    }
  }
}

function diagnosticKey(diagnostic: AgentDiagnostic): string {
  return `${diagnostic.source}\0${diagnostic.path}\0${diagnostic.message}`;
}

/** Discover project definitions over global definitions without allowing one bad file to stop the scan. */
export function discoverCustomAgents(cwd: string): CustomAgentDiscovery {
  const diagnostics: AgentDiagnostic[] = [];
  const byId = new Map<string, AgentConfig>();
  loadFromDir(join(getAgentDir(), "agents"), byId, diagnostics, "global");
  loadFromDir(join(cwd, ".pi", "agents"), byId, diagnostics, "project");

  const known = new Set(byId.keys());
  for (const config of byId.values()) {
    for (const allowed of config.allowedAgents ?? []) {
      if (!known.has(normalizeAgentId(allowed))) {
        diagnostics.push({
          path: `${config.source ?? "global"}:${config.name}.md:allowed_agents`,
          message: `unknown agent ${JSON.stringify(allowed)}`,
          source: config.source === "project" ? "project" : "global",
        });
      }
    }
  }

  return { agents: byId, diagnostics };
}

/** Compatibility entrypoint. Diagnostics are emitted unless a callback consumes them. */
export function loadCustomAgents(
  cwd: string,
  onDiagnostic?: ((diagnostic: AgentDiagnostic) => void) | undefined,
): Map<string, AgentConfig> {
  const result = discoverCustomAgents(cwd);
  for (const diagnostic of result.diagnostics) {
    if (onDiagnostic) onDiagnostic(diagnostic);
    else console.warn(`[pi-agent-roster] ${diagnostic.path}: ${diagnostic.message}`);
  }
  return result.agents;
}

export function normalizeAgentId(name: string): string {
  return name.trim().toLocaleLowerCase("en-US");
}

function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  diagnostics: AgentDiagnostic[],
  source: "project" | "global",
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.toLocaleLowerCase("en-US").endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    debugLog("readdirSync agents dir", error);
    diagnostics.push({ path: dir, message: errorMessage(error), source });
    return;
  }

  for (const file of files) {
    const path = join(dir, file);
    const name = basename(file, file.slice(-3));
    const id = normalizeAgentId(name);
    if (!id) {
      diagnostics.push({ path, message: "filename must contain an agent name", source });
      continue;
    }

    const existing = agents.get(id);
    if (existing?.source === source) {
      agents.delete(id);
      diagnostics.push({
        path,
        message: `filename collides case-insensitively with ${JSON.stringify(existing.name)}`,
        source,
      });
      continue;
    }
    // A project definition owns the identity even when its contents are invalid.
    if (source === "project") agents.delete(id);

    try {
      const content = readFileSync(path, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      const config = parseAgent(path, name, id, frontmatter, body, source);
      agents.set(id, config);
    } catch (error) {
      debugLog("load agent file", error);
      diagnostics.push({ path, message: errorMessage(error), source });
    }
  }
}

function parseAgent(
  path: string,
  name: string,
  id: string,
  raw: unknown,
  body: string,
  source: "project" | "global",
): AgentConfig {
  if (!isRecord(raw)) throw new Error("frontmatter must be a mapping");
  const fm = raw;
  rejectUnsupported(path, fm, "inherit_context");
  rejectUnsupported(path, fm, "model_stacks");
  rejectUnsupported(path, fm, "tools");

  const mode = optionalString(fm.mode, `${path}:mode`) ?? "subagent";
  if (!MODES.has(mode as AgentMode)) {
    throw new Error(`${path}:mode must be primary, subagent, or all`);
  }
  const thinking = parseThinking(fm.thinking, `${path}:thinking`);
  const stacks = parseStacks(fm.stacks, path);
  const defaultStack = parseDefaultStack(fm.default_stack, stacks, path);

  return {
    id,
    name,
    displayName: optionalString(fm.display_name, `${path}:display_name`),
    description: optionalString(fm.description, `${path}:description`) ?? name,
    mode: mode as AgentMode,
    allowedAgents: parseList(fm.allowed_agents, `${path}:allowed_agents`, false),
    stacks,
    defaultStack,
    permission: parsePermission(fm.permission, `${path}:permission`),
    contextFiles: optionalBoolean(fm.context_files, `${path}:context_files`) ?? true,
    model: optionalString(fm.model, `${path}:model`),
    thinking,
    maxTurns: parseMaxTurns(fm.max_turns, `${path}:max_turns`),
    graceTurns: parseBoundedInt(fm.grace_turns, 0, 1_000, `${path}:grace_turns`),
    systemPrompt: body.trim(),
    promptMode: parsePromptMode(fm.prompt_mode, `${path}:prompt_mode`),
    runInBackground: optionalBoolean(fm.run_in_background, `${path}:run_in_background`),
    enabled: optionalBoolean(fm.enabled, `${path}:enabled`) ?? true,
    source,
  };
}

function parseStacks(value: unknown, path: string): ReadonlyMap<string, AgentStackProfile> {
  const result = new Map<string, AgentStackProfile>();
  if (value == null) return result;
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`${path}:stacks must be a mapping`);

  const normalized = new Set<string>();
  for (const [rawName, profileValue] of Object.entries(value)) {
    const name = rawName.trim();
    const id = normalizeAgentId(name);
    const profilePath = `${path}:stacks.${rawName}`;
    if (!name) throw new Error(`${profilePath} name must not be empty`);
    if (normalized.has(id))
      throw new Error(`${profilePath} collides case-insensitively with another stack`);
    normalized.add(id);
    if (!isRecord(profileValue) || Array.isArray(profileValue))
      throw new Error(`${profilePath} must be a mapping`);
    const unknown = Object.keys(profileValue).filter(
      (key) => key !== "model" && key !== "thinking",
    );
    if (unknown.length) throw new Error(`${profilePath}.${unknown[0]} is not supported`);
    const model = requiredString(profileValue.model, `${profilePath}.model`);
    if (!MODEL_PATTERN.test(model))
      throw new Error(`${profilePath}.model must use provider/model format`);
    const thinking = parseThinking(profileValue.thinking, `${profilePath}.thinking`);
    result.set(name, { model, ...(thinking ? { thinking } : {}) });
  }
  return result;
}

function parseDefaultStack(
  value: unknown,
  stacks: ReadonlyMap<string, AgentStackProfile>,
  path: string,
): string | undefined {
  const raw = optionalString(value, `${path}:default_stack`);
  if (raw == null) return undefined;
  const selected = raw.trim();
  if (!selected) throw new Error(`${path}:default_stack must be a non-empty stack name`);
  if (normalizeAgentId(selected) === "default") return "default";
  const canonical = findCaseInsensitive(stacks.keys(), selected);
  if (!canonical)
    throw new Error(`${path}:default_stack references unknown stack ${JSON.stringify(selected)}`);
  return canonical;
}

function parsePermission(value: unknown, path: string): ToolPermissions | undefined {
  if (value == null) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`${path} must be a flat mapping`);

  const result: Record<string, "allow" | "deny"> = {};
  for (const [name, action] of Object.entries(value)) {
    if (name !== "*" && (!name || name !== name.trim() || /[\\/*?[\]{}]/.test(name))) {
      throw new Error(`${path}.${name} must be an exact tool name or "*"`);
    }
    if (action !== "allow" && action !== "deny") {
      throw new Error(`${path}.${name} must be exactly "allow" or "deny"`);
    }
    result[name] = action;
  }
  return result;
}

function parseList(value: unknown, path: string, allowNone: boolean): string[] | undefined {
  if (value == null) return undefined;
  let values: unknown[];
  if (Array.isArray(value)) values = value;
  else if (typeof value === "string") values = value.split(",");
  else throw new Error(`${path} must be a string or sequence`);

  const items = values
    .map((item) => {
      if (typeof item !== "string") throw new Error(`${path} entries must be strings`);
      return item.trim();
    })
    .filter(Boolean);
  if (allowNone && items.length === 1 && items[0]?.toLocaleLowerCase("en-US") === "none") return [];
  if (!allowNone && items.some((item) => item.toLocaleLowerCase("en-US") === "none")) {
    throw new Error(`${path} does not support "none"`);
  }
  return items;
}

function parseThinking(value: unknown, path: string): ThinkingLevel | undefined {
  const thinking = optionalString(value, path);
  if (thinking == null) return undefined;
  if (!THINKING_LEVELS.has(thinking as ThinkingLevel)) {
    throw new Error(`${path} must be a supported thinking level`);
  }
  return thinking as ThinkingLevel;
}

function parseMaxTurns(value: unknown, path: string): number | undefined {
  if (value === 0) return undefined;
  return parseBoundedInt(value, 1, 10_000, path);
}

function parseBoundedInt(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function parsePromptMode(value: unknown, path: string): "replace" | "append" {
  if (value == null) return "append";
  if (value !== "replace" && value !== "append")
    throw new Error(`${path} must be replace or append`);
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  const result = optionalString(value, path)?.trim();
  if (!result) throw new Error(`${path} must be a non-empty string`);
  return result;
}

function rejectUnsupported(path: string, fm: Record<string, unknown>, field: string): void {
  if (Object.hasOwn(fm, field)) {
    throw new Error(`${path}:${field} is unsupported; remove it from the agent definition`);
  }
}

function findCaseInsensitive(values: Iterable<string>, wanted: string): string | undefined {
  const normalized = normalizeAgentId(wanted);
  return [...values].find((value) => normalizeAgentId(value) === normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
