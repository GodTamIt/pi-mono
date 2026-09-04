/**
 * Session aggregation and usage attribution.
 *
 * The usage panel mirrors Claude Code's `/usage` view: it shows how spend and
 * tokens are distributed across models, skills, plugins, tools, and projects,
 * bucketed by time window (5h / 24h / 7d / 30d / all).
 *
 * Data source
 * -----------
 * Pi stores per-turn usage (tokens + cost) on every assistant message across
 * all session JSONL files under ~/.pi/agent/sessions/. We open each file once,
 * walk its entries in append order, and attribute each assistant turn to:
 *   - a model        (from message.model)
 *   - a project      (from the session header cwd)
 *   - skill(s)       (detected via parseSkillBlocks on the preceding user msg)
 *   - tools/plugins  (from the tool calls inside the assistant message)
 *
 * Important: skills, plugins, tools and models are *independent characteristics*
 * of usage, not a disjoint partition — a single turn can contribute to several
 * buckets at once (exactly like Claude Code's wording). Percentages therefore
 * do not sum to 100% across categories.
 */
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  parseSkillBlock,
  type SessionEntry,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import type { CachedSession, ScanCache } from "./cache.ts";
import { excludesFingerprint, pricesFingerprint } from "./cache.ts";
import type { ModelPrice } from "./config.ts";
import { sourceLabel } from "./format.ts";

/** A lookup of manual model prices ($/Mtok), keyed by model ID. */
export type PriceMap = Record<string, ModelPrice>;

/**
 * Resolve a manual price for a model: exact match first, then by base name
 * (after the last `/`) so an entry like `claude-opus-4.7` covers proxied
 * variants such as `kr/claude-opus-4.7` and `cx/claude-opus-4.7`.
 */
export function resolveModelPrice(
  model: string,
  prices: PriceMap | undefined,
): ModelPrice | undefined {
  if (!prices) return undefined;
  if (prices[model]) return prices[model];
  const slash = model.lastIndexOf("/");
  if (slash >= 0) {
    const base = model.slice(slash + 1);
    if (prices[base]) return prices[base];
  }
  return undefined;
}

/** Compute a USD cost from token usage and a manual price ($/Mtok). */
export function costFromPrice(usage: Usage, price: ModelPrice): number {
  return (
    (usage.input / 1e6) * (price.input ?? 0) +
    (usage.output / 1e6) * (price.output ?? 0) +
    (usage.cacheRead / 1e6) * (price.cacheRead ?? 0) +
    (usage.cacheWrite / 1e6) * (price.cacheWrite ?? 0)
  );
}

/** Time windows selectable in the panel. */
export type WindowKey = "5h" | "24h" | "7d" | "30d" | "all";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

export function windowMs(key: WindowKey): number {
  switch (key) {
    case "5h":
      return 5 * HOUR;
    case "24h":
      return DAY;
    case "7d":
      return 7 * DAY;
    case "30d":
      return MONTH;
    case "all":
      return Number.POSITIVE_INFINITY;
  }
}

export function windowLabel(key: WindowKey): string {
  switch (key) {
    case "5h":
      return "Last 5 hours";
    case "24h":
      return "Last 24 hours";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "all":
      return "All time";
  }
}

/** Built-in tool names — excluded from the Plugins breakdown but shown in Tools. */
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** Mutable usage totals for a bucket. */
export interface Bucket {
  cost: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  /** Reported reasoning tokens; a labelled subset of output, never additive. */
  reasoning: number;
  turns: number;
  /**
   * Estimated generation time (ms) summed across turns. Used to derive an
   * average output-tokens/second. It's an estimate: pi's Usage carries no
   * duration, so we approximate per-turn time from the gap between an
   * assistant turn and the preceding session entry (idle/tool gaps clamped).
   */
  genMs: number;
  /** Turns that contributed a usable genMs estimate (for tok/s averaging). */
  timedTurns: number;
}

function emptyBucket(): Bucket {
  return {
    cost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    turns: 0,
    genMs: 0,
    timedTurns: 0,
  };
}

function addBucket(b: Bucket, u: Usage, genMs = 0): void {
  b.cost += u.cost.total;
  b.costInput += u.cost.input ?? 0;
  b.costOutput += u.cost.output ?? 0;
  b.costCacheRead += u.cost.cacheRead ?? 0;
  b.costCacheWrite += u.cost.cacheWrite ?? 0;
  b.input += u.input;
  b.output += u.output;
  b.cacheRead += u.cacheRead;
  b.cacheWrite += u.cacheWrite;
  b.cacheWrite1h += u.cacheWrite1h ?? 0;
  b.reasoning += u.reasoning ?? 0;
  b.turns += 1;
  if (genMs > 0) {
    b.genMs += genMs;
    b.timedTurns += 1;
  }
}

/** Total tokens consumed by a bucket (input + output + cache reads/writes). */
export function bucketTokens(b: Bucket): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite;
}

/**
 * Average output-tokens/second for a bucket, estimated from `genMs`.
 * Returns 0 when no timed turns are available. Output tokens are used because
 * that's the generation throughput users mean by "tok/s".
 */
export function tokensPerSecond(b: Bucket): number {
  if (b.genMs <= 0 || b.output <= 0) return 0;
  return b.output / (b.genMs / 1000);
}

/** A single attributed assistant turn on the timeline. */
export interface TurnEntry {
  ts: number;
  model: string;
  provider: string;
  project: string;
  cost: number;
  usage: Usage;
  /** Primary skill (first in a multi-skill activation). */
  skill: string | null;
  /** All skills from multi-skill or single-skill activation. */
  skills: string[];
  /** Bundle names from multi-skill (@bundle) activation. */
  bundles: string[];
  tools: string[];
  /** Estimated generation time for this turn in ms (0 when not estimable). */
  genMs: number;
  sessionId: string;
  sessionPath: string;
  delegated: boolean;
  parentSessionId: string | null;
}

/**
 * Backfill fields missing on legacy cached turns (pre multi-skill cache entries).
 * Safe to call on every cache hit and before aggregating.
 */
export function normalizeTurnEntry(entry: TurnEntry): TurnEntry {
  const skills = Array.isArray(entry.skills) ? entry.skills : entry.skill ? [entry.skill] : [];
  const bundles = Array.isArray(entry.bundles) ? entry.bundles : [];
  const tools = Array.isArray(entry.tools) ? entry.tools : [];
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : "";
  const sessionPath = typeof entry.sessionPath === "string" ? entry.sessionPath : "";
  const delegated = entry.delegated === true;
  const parentSessionId = typeof entry.parentSessionId === "string" ? entry.parentSessionId : null;
  return { ...entry, skills, bundles, tools, sessionId, sessionPath, delegated, parentSessionId };
}

/** Skills attributed to a turn (multi-skill aware, legacy-safe). */
export function skillsForTurn(turn: TurnEntry): string[] {
  if (Array.isArray(turn.skills) && turn.skills.length > 0) return turn.skills;
  return turn.skill ? [turn.skill] : [];
}

/** Bundles attributed to a turn (multi-skill @bundle activation). */
export function bundlesForTurn(turn: TurnEntry): string[] {
  return Array.isArray(turn.bundles) ? turn.bundles : [];
}

/** Soft metadata for one authoritative delegated transcript. */
export interface ChildSessionSummary {
  id: string;
  path: string;
  parentSessionId: string | null;
  parentLabel: string;
  project: string;
  task: string;
  agentType: string;
  status: string;
  isBackground?: boolean;
  startedAt: number;
  endedAt: number;
  timingInferred: boolean;
  model?: string;
  stack?: string;
  thinking?: string;
  compactions: number;
}

/** Full raw report built once, then windowed on demand. */
export interface Report {
  computedAt: number;
  sessionCount: number;
  turnCount: number;
  entries: TurnEntry[];
  children: ChildSessionSummary[];
}

/** Runtime-derived maps for attributing tools/skills to plugin labels. */
export interface AttributionMaps {
  toolToPlugin: Map<string, string>;
  skillToPlugin: Map<string, string>;
}

/** Build tool->plugin and skill->plugin maps from the currently loaded resources. */
export function buildAttributionMaps(pi: ExtensionAPI): AttributionMaps {
  const toolToPlugin = new Map<string, string>();
  for (const tool of pi.getAllTools()) {
    if (BUILTIN_TOOLS.has(tool.name)) continue;
    toolToPlugin.set(tool.name, sourceLabel(tool.sourceInfo));
  }

  const skillToPlugin = new Map<string, string>();
  for (const cmd of pi.getCommands()) {
    if (cmd.source !== "skill") continue;
    // Skill command names look like "skill:<name>"; the skill name is what
    // appears in <skill name="..."> blocks stored in sessions.
    const skillName = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
    skillToPlugin.set(skillName, sourceLabel(cmd.sourceInfo));
  }

  return { toolToPlugin, skillToPlugin };
}

/** Extract bundle names from manually_attached_skills bundles="..." attribute. */
export function parseSkillBundles(text: string): string[] {
  const match = text.match(/<manually_attached_skills[^>]*\sbundles="([^"]+)"/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((b) => b.trim().replace(/^@/, ""))
    .filter((b) => b.length > 0);
}

/** Extract all skill names from user content (multi-skill aware). */
export function parseSkillBlocks(text: string): string[] {
  const names: string[] = [];
  const re = /<skill\s+name="([^"]+)"/g;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    names.push(match[1]);
  }
  if (names.length > 0) return [...new Set(names)];

  const single = parseSkillBlock(text);
  return single ? [single.name] : [];
}

function textOfUserContent(content: AssistantMessage["content"] | string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "type" in block && block.type === "text"
          ? (block as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

function shouldExclude(project: string, excludes: string[]): boolean {
  if (!excludes || excludes.length === 0) return false;
  const p = project.replace(/\\/g, "/").toLowerCase();
  return excludes.some((ex) => p.startsWith(ex.replace(/\\/g, "/").toLowerCase()));
}

/**
 * Scan every session file and build the timeline of attributed turns.
 *
 * `onProgress` receives (loaded, total) for UI feedback. Resolves even if some
 * files fail to parse — bad files are skipped with a console warning.
 *
 * When a `cache` is supplied, sessions whose file mtime + size are unchanged
 * (and whose cost was computed with the same price table) are reused without
 * re-reading/parsing the file — only new or modified sessions are parsed. The
 * cache object is updated in place; the caller persists it.
 */
export async function scanSessions(
  maxSessions: number,
  excludes: string[],
  onProgress?: (loaded: number, total: number) => void,
  prices?: PriceMap,
  cache?: ScanCache,
): Promise<Report> {
  const all = await SessionManager.listAll();
  // Classify roots vs parented top-level sessions with a bounded header read;
  // a full parse here would defeat the incremental cache on large histories.
  const roots: SessionInfo[] = [];
  const parented: ParentedSession[] = [];
  for (const session of all) {
    if (isChildConventionPath(session.path)) continue;
    try {
      const header = headerFor(session.path);
      if (header.parentSession)
        parented.push({ info: session, parentSession: header.parentSession });
      else roots.push(session);
    } catch {
      roots.push(session);
    }
  }
  const selected = stableSort(roots, (a, b) => b.modified.getTime() - a.modified.getTime()).slice(
    0,
    maxSessions,
  );
  const discovered = discoverSelectedSessions(selected, parented);
  const pricesKey = pricesFingerprint(prices);
  const excludesKey = excludesFingerprint(excludes);
  const prevSessions =
    cache && cache.pricesKey === pricesKey && cache.excludesKey === excludesKey
      ? cache.sessions
      : {};
  const nextSessions: ScanCache["sessions"] = {};
  const entries: TurnEntry[] = [];
  const rawChildren: ChildSessionSummary[] = [];
  const recordPool: SoftRecord[] = [];

  for (let i = 0; i < discovered.length; i++) {
    const session = discovered[i];
    onProgress?.(i + 1, discovered.length);
    try {
      const st = statSync(session.info.path);
      const cached = prevSessions[session.info.path];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        entries.push(...cached.entries.map(normalizeTurnEntry));
        if (cached.child) rawChildren.push(cached.child);
        recordPool.push(...(cached.records ?? []));
        nextSessions[session.info.path] = cached;
        continue;
      }
      const fresh: TurnEntry[] = [];
      const { child, records } = collectFromSession(
        session.info,
        session.info.cwd || session.project,
        excludes,
        fresh,
        prices,
        session.delegated,
        session.parentSessionId,
        session.parentLabel,
      );
      entries.push(...fresh);
      if (child) rawChildren.push(child);
      recordPool.push(...records);
      nextSessions[session.info.path] = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        entries: fresh,
        child,
        records,
      };
    } catch (err) {
      console.error(`[usage] Failed to read session ${session.info.path}: ${err}`);
    }
  }

  // Record enrichment runs after assembly from the pooled per-file metadata,
  // so a parent's metadata updates a child summary even when the child
  // transcript itself is an unchanged cache hit.
  const children = rawChildren.map((child) =>
    enrichChild(
      child,
      mergeRecords(
        recordPool.filter(
          (record) =>
            record.childSessionId === child.id || pathRefMatches(record.outputFile, child.path),
        ),
      ),
    ),
  );

  if (cache) {
    cache.version = 6;
    cache.pricesKey = pricesKey;
    cache.excludesKey = excludesKey;
    cache.sessions = nextSessions;
  }
  return {
    computedAt: Date.now(),
    sessionCount: discovered.length,
    turnCount: entries.length,
    entries,
    children: dedupeChildren(children),
  };
}

/** Loose `subagents:record` metadata payload (authored by delegation frameworks). */
export type SoftRecord = Record<string, unknown>;

/** A top-level session excluded from the roots because its header names a parent. */
export interface ParentedSession {
  info: SessionInfo;
  parentSession: string;
}

interface DiscoveredSession {
  info: SessionInfo;
  project: string;
  delegated: boolean;
  parentSessionId: string | null;
  parentLabel: string;
}

interface SessionHeader {
  id?: string;
  cwd?: string;
  parentSession?: string;
}

/** Cap on the prefix scanned for the session header (mirrors pi's own limit). */
const HEADER_SCAN_LIMIT = 1024 * 1024;
const HEADER_CHUNK_BYTES = 64 * 1024;

function parseSessionHeaderLine(line: string): SessionHeader | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "session") return null;
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
  };
}

/**
 * Read just the file's leading lines to find the session header. Roots are
 * classified before `maxSessions`, so parsing every full transcript here
 * would defeat the incremental cache on large histories.
 */
export function headerFor(path: string): SessionHeader {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(HEADER_CHUNK_BYTES);
    let scanned = 0;
    let pending = "";
    for (;;) {
      const bytes = readSync(fd, buffer, 0, HEADER_CHUNK_BYTES, scanned);
      if (bytes === 0) break;
      scanned += bytes;
      pending += buffer.toString("utf8", 0, bytes);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const header = parseSessionHeaderLine(line);
        if (header) return header;
      }
      if (scanned >= HEADER_SCAN_LIMIT) break;
    }
    return parseSessionHeaderLine(pending) ?? {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isChildConventionPath(path: string): boolean {
  const parts = normalize(path).split(sep);
  return parts.includes("tasks") || parts.includes("subagents");
}

export function discoverChildSessionFiles(rootFile: string): string[] {
  const out: string[] = [];
  const dir = dirname(rootFile);
  const stem = basename(rootFile, ".jsonl");
  const starts = [join(dir, stem), join(dir, "tasks"), join(dir, "subagents")];
  const walk = (current: string): void => {
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of names) {
      const path = join(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && item.name.endsWith(".jsonl")) out.push(path);
    }
  };
  for (const start of starts) walk(start);
  return out;
}

/** A selected root (or resolved direct child) whose convention dirs are walked. */
interface DiscoveryAnchor {
  entry: DiscoveredSession;
  /** The anchor's session id — the fallback parent for walked children. */
  id: string;
}

/** The selected root a parented session transitively resolves to. */
interface RootAnchor {
  info: SessionInfo;
  id: string;
  label: string;
}

function resolveDirectChild(
  start: ParentedSession,
  rootByKey: Map<string, RootAnchor>,
  candidateById: Map<string, ParentedSession>,
  candidateByPath: Map<string, ParentedSession>,
): RootAnchor | null {
  let current = start;
  const visited = new Set<string>();
  for (;;) {
    const ref = current.parentSession;
    const anchor = rootByKey.get(ref) ?? rootByKey.get(resolve(ref));
    if (anchor) return anchor;
    if (visited.has(ref)) return null;
    visited.add(ref);
    const next =
      candidateById.get(ref) ??
      candidateByPath.get(resolve(ref)) ??
      candidateByPath.get(resolve(dirname(current.info.path), ref));
    if (!next) return null;
    current = next;
  }
}

/**
 * Resolve the selected roots plus their delegated child transcripts into the
 * flat session list the scanner walks. `parented` carries top-level sessions
 * excluded from the roots because their header names a parent: those whose
 * parent chain (session id or path) resolves transitively to a selected root
 * are attached as direct delegated children. Exported as a narrow seam so
 * fixture tests can exercise discovery without touching real user sessions.
 */
export function discoverSelectedSessions(
  roots: SessionInfo[],
  parented: ParentedSession[] = [],
): DiscoveredSession[] {
  const seenPaths = new Set<string>();
  const seenChildIds = new Set<string>();
  const anchors: DiscoveryAnchor[] = [];
  const rootByKey = new Map<string, RootAnchor>();

  for (const root of roots) {
    let rootPath: string;
    try {
      rootPath = realpathSync(root.path);
    } catch {
      rootPath = resolve(root.path);
    }
    if (seenPaths.has(rootPath)) continue;
    seenPaths.add(rootPath);
    // An unreadable root still counts as a (childless, direct) session;
    // only its header metadata is lost.
    let rootHeader: SessionHeader = {};
    try {
      rootHeader = headerFor(root.path);
    } catch {
      // Metadata is optional; the transcript remains authoritative.
    }
    const rootId = rootHeader.id || root.id;
    seenChildIds.add(rootId);
    anchors.push({
      entry: {
        info: root,
        project: root.cwd || rootHeader.cwd || "",
        delegated: !!rootHeader.parentSession,
        parentSessionId: rootHeader.parentSession ?? null,
        parentLabel: root.name || root.firstMessage || rootId,
      },
      id: rootId,
    });
    const anchor: RootAnchor = {
      info: root,
      id: rootId,
      label: root.name || root.firstMessage || rootId,
    };
    rootByKey.set(rootId, anchor);
    rootByKey.set(resolve(root.path), anchor);
  }

  // Direct top-level children (stored beside their parent, so listAll sees
  // them) attach transitively to a selected root via their header chain.
  const candidateById = new Map<string, ParentedSession>();
  const candidateByPath = new Map<string, ParentedSession>();
  for (const candidate of parented) {
    candidateById.set(candidate.info.id, candidate);
    candidateByPath.set(resolve(candidate.info.path), candidate);
  }
  for (const candidate of parented) {
    const root = resolveDirectChild(candidate, rootByKey, candidateById, candidateByPath);
    if (!root) continue;
    let canonical: string;
    try {
      if (lstatSync(candidate.info.path).isSymbolicLink()) continue;
      canonical = realpathSync(candidate.info.path);
    } catch {
      continue;
    }
    if (seenPaths.has(canonical)) continue;
    let header: SessionHeader = {};
    try {
      header = headerFor(candidate.info.path);
    } catch {
      // Metadata is optional; the transcript remains authoritative.
    }
    const candidateId = header.id || candidate.info.id;
    if (seenChildIds.has(candidateId)) continue;
    seenPaths.add(canonical);
    seenChildIds.add(candidateId);
    anchors.push({
      entry: {
        info: { ...candidate.info, id: candidateId },
        project: candidate.info.cwd || header.cwd || "",
        delegated: true,
        parentSessionId: header.parentSession || candidate.parentSession,
        parentLabel: root.label,
      },
      id: candidateId,
    });
  }

  const result: DiscoveredSession[] = [];
  for (const anchor of anchors) {
    result.push(anchor.entry);
    const queue = discoverChildSessionFiles(anchor.entry.info.path);
    for (const path of queue) {
      let canonical: string;
      try {
        if (lstatSync(path).isSymbolicLink()) continue;
        canonical = realpathSync(path);
      } catch {
        continue;
      }
      if (seenPaths.has(canonical)) continue;
      let header: SessionHeader;
      try {
        header = headerFor(path);
      } catch {
        continue;
      }
      const id = header.id || canonical;
      if (seenChildIds.has(id)) continue;
      const rawParent = header.parentSession;
      seenPaths.add(canonical);
      seenChildIds.add(id);
      let st: import("node:fs").Stats;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const info: SessionInfo = {
        path,
        id,
        cwd: header.cwd || anchor.entry.info.cwd || "",
        created: new Date(st.birthtimeMs),
        modified: new Date(st.mtimeMs),
        messageCount: 0,
        firstMessage: "",
        allMessagesText: "",
      };
      result.push({
        info,
        project: info.cwd,
        delegated: true,
        parentSessionId: rawParent || anchor.id,
        parentLabel: anchor.entry.parentLabel,
      });
    }
  }
  const idByPath = new Map(result.map((session) => [resolve(session.info.path), session.info.id]));
  const labelById = new Map(
    result.map((session) => [
      session.info.id,
      session.info.name || session.info.firstMessage || session.info.id,
    ]),
  );
  for (const session of result) {
    const parent = session.parentSessionId;
    if (parent) {
      const directPath = resolve(parent);
      const relativePath = resolve(dirname(session.info.path), parent);
      const resolvedParent = idByPath.get(directPath) ?? idByPath.get(relativePath) ?? parent;
      session.parentSessionId = resolvedParent;
      session.parentLabel = labelById.get(resolvedParent) ?? session.parentLabel;
    }
  }
  return result;
}
function mergeRecords(records: SoftRecord[]): SoftRecord | undefined {
  if (records.length === 0) return undefined;
  const sorted = [...records].sort(
    (a, b) =>
      (numericTime(a.startedAt) || numericTime(a.completedAt)) -
      (numericTime(b.startedAt) || numericTime(b.completedAt)),
  );
  return Object.assign({}, ...sorted);
}

function pathRefMatches(value: unknown, path: string): boolean {
  return typeof value === "string" && resolve(value) === resolve(path);
}
function numericTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function dedupeChildren(children: ChildSessionSummary[]): ChildSessionSummary[] {
  const byIdentity = new Map<string, ChildSessionSummary>();
  for (const child of children) {
    const key = child.id || child.path;
    const previous = byIdentity.get(key);
    if (!previous || child.endedAt >= previous.endedAt) byIdentity.set(key, child);
  }
  return [...byIdentity.values()];
}

/**
 * Open one session file, attribute its assistant turns into `out`, and return
 * the transcript-derived child summary (if any) plus the file's optional
 * `subagents:record` metadata entries. Record *enrichment* happens later, in
 * scanSessions, so cached transcripts never need re-reading for metadata.
 */
function collectFromSession(
  info: SessionInfo,
  project: string,
  excludes: string[],
  out: TurnEntry[],
  prices: PriceMap | undefined,
  delegated: boolean,
  parentSessionId: string | null,
  parentLabel: string,
): { child?: ChildSessionSummary; records: SoftRecord[] } {
  if (shouldExclude(project, excludes)) return { records: [] };

  const sm = SessionManager.open(info.path);
  const sessionEntries: SessionEntry[] = sm.getEntries();
  const header = sm.getHeader();
  const sessionId = header?.id || info.id;
  const actualParent = parentSessionId ?? header?.parentSession;
  const isDelegated = delegated || !!actualParent || isChildConventionPath(info.path);

  let currentSkill: string | null = null;
  let currentSkills: string[] = [];
  let currentBundles: string[] = [];
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  let fallbackTask = "";
  let compactions = 0;
  const records: SoftRecord[] = [];
  // Timestamp (ms) of the previous session entry, used to estimate how long an
  // assistant turn took to generate (request-start ≈ previous entry time).
  let prevEntryTs = 0;

  // getEntries() returns append order, which is the natural conversation order
  // along the active path. Branch entries appear after their parents, which is
  // fine for attribution: each assistant entry is counted once.
  for (const entry of sessionEntries) {
    const anyTs = entryTimestamp(entry);
    if (anyTs > 0) {
      firstTs = Math.min(firstTs, anyTs);
      lastTs = Math.max(lastTs, anyTs);
    }
    if (entry.type !== "message") {
      if (entry.type === "compaction") compactions += 1;
      if (entry.type === "custom" && entry.customType === "subagents:record") {
        const data = entry.data;
        if (typeof data === "object" && data !== null) records.push(data as SoftRecord);
      }
      const ts = anyTs;
      if (ts > 0) prevEntryTs = ts;
      continue;
    }
    const message = entry.message;
    const entryTs = entryTimestamp(entry);

    if (message.role === "user") {
      const text = textOfUserContent(message.content).trimStart();
      if (!fallbackTask && text) fallbackTask = text.replace(/\s+/g, " ");
      currentSkills = parseSkillBlocks(text);
      currentSkill = currentSkills[0] ?? null;
      currentBundles = parseSkillBundles(text);
      if (entryTs > 0) prevEntryTs = entryTs;
      continue;
    }

    if (message.role !== "assistant") {
      if (entryTs > 0) prevEntryTs = entryTs;
      continue;
    }
    const usage = message.usage;
    if (!usage) {
      if (entryTs > 0) prevEntryTs = entryTs;
      continue;
    }

    const tools = message.content
      .filter((b): b is ToolCall => b.type === "toolCall")
      .map((b) => b.name);

    const ts = message.timestamp || entryTs;
    const genMs = estimateGenMs(prevEntryTs, ts);
    const model = message.model || message.provider || "unknown";

    // Fill in cost for token-priced models pi recorded as 0, using the user's
    // manual price table. The recorded cost always wins when present.
    let effUsage = usage;
    if ((usage.cost?.total ?? 0) <= 0 && prices) {
      const price = resolveModelPrice(model, prices);
      if (price) {
        const input = (usage.input / 1e6) * (price.input ?? 0);
        const output = (usage.output / 1e6) * (price.output ?? 0);
        const cacheRead = (usage.cacheRead / 1e6) * (price.cacheRead ?? 0);
        const cacheWrite = (usage.cacheWrite / 1e6) * (price.cacheWrite ?? 0);
        const total = input + output + cacheRead + cacheWrite;
        if (total > 0) {
          effUsage = {
            ...usage,
            cost: { input, output, cacheRead, cacheWrite, total },
          };
        }
      }
    }

    out.push({
      ts,
      model,
      provider: message.provider || "",
      project,
      cost: effUsage.cost.total,
      usage: effUsage,
      skill: currentSkill,
      skills: currentSkills,
      bundles: currentBundles,
      tools,
      genMs,
      sessionId,
      sessionPath: info.path,
      delegated: isDelegated,
      parentSessionId: actualParent ?? null,
    });
    if (ts > 0) prevEntryTs = ts;
  }
  if (!isDelegated) return { records };
  return {
    records,
    child: {
      id: sessionId,
      path: info.path,
      parentSessionId: actualParent ?? null,
      parentLabel,
      project,
      task: fallbackTask || "(untitled)",
      agentType: "(unclassified)",
      status: "unknown",
      isBackground: undefined,
      startedAt: Number.isFinite(firstTs) ? firstTs : info.created.getTime(),
      endedAt: lastTs || info.modified.getTime(),
      timingInferred: true,
      model: undefined,
      stack: undefined,
      thinking: undefined,
      compactions,
    },
  };
}

/**
 * Apply merged `subagents:record` metadata to a transcript-derived child
 * summary. Records live in parent transcripts, so this runs after assembly —
 * a parent metadata change then updates a cached child summary.
 */
function enrichChild(
  child: ChildSessionSummary,
  record: SoftRecord | undefined,
): ChildSessionSummary {
  if (!record) return child;
  const preciseStart = numericTime(record.startedAt);
  const preciseEnd = numericTime(record.completedAt);
  return {
    ...child,
    task: stringValue(record.task) || stringValue(record.description) || child.task,
    agentType:
      stringValue(record.type) ||
      stringValue(record.profile) ||
      stringValue(record.agent) ||
      child.agentType,
    status: stringValue(record.status) || child.status,
    isBackground:
      typeof record.isBackground === "boolean" ? record.isBackground : child.isBackground,
    startedAt: preciseStart || child.startedAt,
    endedAt: preciseEnd || child.endedAt,
    timingInferred: !(preciseStart > 0 && preciseEnd > 0),
    model: stringValue(record.model) ?? child.model,
    stack: stringValue(record.stack) ?? child.stack,
    thinking: stringValue(record.thinking) ?? child.thinking,
    compactions:
      typeof record.compactionCount === "number" ? record.compactionCount : child.compactions,
  };
}

/** Upper bound on a plausible generation gap; longer gaps are treated as idle. */
const MAX_GEN_MS = 10 * 60 * 1000;

/**
 * Estimate a turn's generation time from the gap to the previous entry.
 * Returns 0 when the gap is missing, non-positive, or implausibly large
 * (idle time, a long-running tool, or a branch jump) so it doesn't pollute the
 * tokens/second average.
 */
function estimateGenMs(prevTs: number, ts: number): number {
  if (prevTs <= 0 || ts <= 0) return 0;
  const gap = ts - prevTs;
  if (gap <= 0 || gap > MAX_GEN_MS) return 0;
  return gap;
}

/** Read an entry's timestamp as epoch ms, tolerating Date/string/number forms. */
function entryTimestamp(entry: SessionEntry): number {
  const raw = (entry as { timestamp?: unknown }).timestamp;
  if (typeof raw === "number") return raw;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** Per-plugin contribution detail for the Plugin usage section. */
export interface PluginContribution {
  bucket: Bucket;
  /** Skills of this plugin that were invoked (→ turn buckets). */
  skills: Map<string, Bucket>;
  /** Tools owned by this plugin that were called (→ turn buckets). */
  tools: Map<string, Bucket>;
}

/** A windowed view of the report ready for rendering. */
export interface WindowedReport {
  window: WindowKey;
  total: Bucket;
  fiveHour: Bucket;
  weekly: Bucket;
  byModel: Map<string, Bucket>;
  bySkill: Map<string, Bucket>;
  byBundle: Map<string, Bucket>;
  byPlugin: Map<string, Bucket>;
  /** Per-plugin detail: which skills/tools drove each plugin's usage. */
  pluginDetail: Map<string, PluginContribution>;
  /** Turns that used NO plugin tool/skill (builtin-only, no preceding skill). */
  byCore: Bucket;
  byTool: Map<string, Bucket>;
  byProject: Map<string, Bucket>;
  direct: Bucket;
  delegated: Bucket;
  children: ChildSessionSummary[];
  concurrency: ConcurrencyStats;
  turnCount: number;
  sessionCount: number;
  earliest: number;
  latest: number;
}

/** Filter the timeline to a window and roll up all breakdowns. */
export function windowize(report: Report, key: WindowKey, maps: AttributionMaps): WindowedReport {
  const now = Date.now();
  const horizon = windowMs(key);
  const cutoff = horizon === Number.POSITIVE_INFINITY ? -1 : now - horizon;

  const total = emptyBucket();
  const fiveHour = emptyBucket();
  const weekly = emptyBucket();
  const byModel = new Map<string, Bucket>();
  const bySkill = new Map<string, Bucket>();
  const byBundle = new Map<string, Bucket>();
  const byPlugin = new Map<string, Bucket>();
  const pluginDetail = new Map<string, PluginContribution>();
  const byCore = emptyBucket();
  const byTool = new Map<string, Bucket>();
  const byProject = new Map<string, Bucket>();
  const direct = emptyBucket();
  const delegated = emptyBucket();

  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  let turnCount = 0;

  for (const turn of report.entries) {
    earliest = Math.min(earliest, turn.ts);
    latest = Math.max(latest, turn.ts);

    // Always-on quota bars use fixed 5h and 7d horizons regardless of window.
    if (turn.ts >= now - 5 * HOUR) addBucket(fiveHour, turn.usage);
    if (turn.ts >= now - 7 * DAY) addBucket(weekly, turn.usage);

    if (cutoff !== -1 && turn.ts < cutoff) continue;
    turnCount += 1;

    addBucket(total, turn.usage, turn.genMs);
    addBucket(turn.delegated ? delegated : direct, turn.usage, turn.genMs);
    bump(byModel, turn.model, turn.usage, turn.genMs);

    // Skill attribution (independent characteristic) — all skills in multi-skill.
    const turnSkills = skillsForTurn(turn);
    for (const skillName of turnSkills) {
      bump(bySkill, skillName, turn.usage);
    }

    // Bundle attribution from @bundle activations.
    for (const bundleName of bundlesForTurn(turn)) {
      bump(byBundle, `@${bundleName}`, turn.usage);
    }

    // Plugin attribution: each turn counts ONCE per distinct plugin involved,
    // whether via a tool it owns or a skill it bundles (deduped, no double count).
    // We also record WHICH skills/tools contributed so the Plugin usage section
    // can show per-plugin detail.
    const turnPlugins = new Map<string, { skills: Set<string>; tools: Set<string> }>();
    const notePlugin = (plugin: string) => {
      let entry = turnPlugins.get(plugin);
      if (!entry) {
        entry = { skills: new Set(), tools: new Set() };
        turnPlugins.set(plugin, entry);
      }
      return entry;
    };
    const turnTools = Array.isArray(turn.tools) ? turn.tools : [];
    for (const toolName of turnTools) {
      bump(byTool, toolName, turn.usage);
      const owner = maps.toolToPlugin.get(toolName);
      if (owner) notePlugin(owner).tools.add(toolName);
    }
    for (const skillName of turnSkills) {
      const skillOwner = maps.skillToPlugin.get(skillName);
      if (skillOwner) notePlugin(skillOwner).skills.add(skillName);
    }
    if (turnPlugins.size === 0) {
      // No plugin tool or plugin skill involved → core pi usage.
      addBucket(byCore, turn.usage);
    } else {
      for (const [plugin, contrib] of turnPlugins) {
        bump(byPlugin, plugin, turn.usage);
        let detail = pluginDetail.get(plugin);
        if (!detail) {
          detail = {
            bucket: emptyBucket(),
            skills: new Map(),
            tools: new Map(),
          };
          pluginDetail.set(plugin, detail);
        }
        addBucket(detail.bucket, turn.usage);
        for (const s of contrib.skills) bump(detail.skills, s, turn.usage);
        for (const t of contrib.tools) bump(detail.tools, t, turn.usage);
      }
    }

    bump(byProject, turn.project || "(unknown)", turn.usage);
  }

  const children = (report.children ?? []).filter(
    (child) => cutoff === -1 || child.endedAt >= cutoff,
  );
  return {
    window: key,
    total,
    fiveHour,
    weekly,
    byModel,
    bySkill,
    byBundle,
    byPlugin,
    pluginDetail,
    byCore,
    byTool,
    byProject,
    direct,
    delegated,
    children,
    concurrency: computeConcurrency(children, cutoff === -1 ? undefined : cutoff, now),
    turnCount,
    sessionCount: report.sessionCount,
    earliest: Number.isFinite(earliest) ? earliest : now,
    latest,
  };
}

export interface ConcurrencyStats {
  childCount: number;
  parentCount: number;
  peak: number | null;
  unionMs: number | null;
  summedMs: number | null;
  parallelism: number | null;
  overlapSavedMs: number | null;
  inferred: boolean;
}

/** Compute overlap statistics for valid child intervals, optionally window-clamped. */
export function computeConcurrency(
  children: ChildSessionSummary[],
  windowStart?: number,
  windowEnd?: number,
): ConcurrencyStats {
  const intervals = children.flatMap((child) => {
    let start = child.startedAt;
    let end = child.endedAt;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) return [];
    if (windowStart != null) start = Math.max(start, windowStart);
    if (windowEnd != null) end = Math.min(end, windowEnd);
    return end > start ? [{ start, end, inferred: child.timingInferred }] : [];
  });
  const parents = new Set(children.map((c) => c.parentSessionId).filter(Boolean));
  if (intervals.length === 0) {
    return {
      childCount: children.length,
      parentCount: parents.size,
      peak: null,
      unionMs: null,
      summedMs: null,
      parallelism: null,
      overlapSavedMs: null,
      inferred: children.some((c) => c.timingInferred),
    };
  }
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let unionMs = 0;
  let unionStart = sorted[0].start;
  let unionEnd = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= unionEnd) unionEnd = Math.max(unionEnd, interval.end);
    else {
      unionMs += unionEnd - unionStart;
      unionStart = interval.start;
      unionEnd = interval.end;
    }
  }
  unionMs += unionEnd - unionStart;
  const summedMs = intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
  const events = intervals.flatMap((i) => [
    { ts: i.start, delta: 1 },
    { ts: i.end, delta: -1 },
  ]);
  events.sort((a, b) => a.ts - b.ts || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  return {
    childCount: children.length,
    parentCount: parents.size,
    peak,
    unionMs,
    summedMs,
    parallelism: unionMs > 0 ? summedMs / unionMs : null,
    overlapSavedMs: Math.max(0, summedMs - unionMs),
    inferred: intervals.some((i) => i.inferred),
  };
}

function bump(map: Map<string, Bucket>, key: string, usage: Usage, genMs = 0): void {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = emptyBucket();
    map.set(key, bucket);
  }
  addBucket(bucket, usage, genMs);
}

/** Map<K, V> sorted (desc) by a numeric extractor → array of [key, V]. */
export function ranked<V>(map: Map<string, V>, value: (v: V) => number): Array<[string, V]> {
  return [...map.entries()].sort((a, b) => value(b[1]) - value(a[1]));
}

function stableSort<T>(arr: T[], cmp: (a: T, b: T) => number): T[] {
  return arr
    .map((v, i) => [v, i] as const)
    .sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1])
    .map((p) => p[0]);
}

// ---------------------------------------------------------------------------
// Daily / Stats aggregation (Tokscale-style Daily Summary + Stats views).
//
// These are pure functions over the already-scanned `Report.entries` timeline,
// so they add new "views" without touching session scanning. They aggregate by
// LOCAL calendar day, which is what a human reading a daily summary expects.
// ---------------------------------------------------------------------------

/** A single calendar day's rolled-up usage. */
export interface DayStat {
  /** Local date key `YYYY-MM-DD`. */
  dateKey: string;
  /** Epoch ms at local midnight for that day (used for sorting/streaks). */
  ts: number;
  bucket: Bucket;
  /** Per-model usage that day (model → bucket); size = distinct models. */
  models: Map<string, Bucket>;
  /** First / last turn timestamp that day. */
  firstTs: number;
  lastTs: number;
  /**
   * Active working time that day in ms: the sum of gaps between consecutive
   * turns that are below the idle threshold. Long idle gaps (pi open but not
   * working) are excluded, so this reflects time pi was actually busy.
   */
  activeMs: number;
}

/** Gaps between turns longer than this count as idle (not active work). */
const ACTIVE_GAP_MS = 5 * 60 * 1000;

/** A day's active working time (idle excluded), in ms. */
export function dayUptimeMs(d: DayStat): number {
  return d.activeMs;
}

/**
 * The day's most-used model — ranked by tokens, not cost. Tokens are the
 * reliable "how much did I use this model" signal: many providers are
 * token-priced (cost 0), so ranking by cost would just surface whichever
 * model happened to run first that day.
 */
export function dayTopModel(d: DayStat): string | null {
  let best: string | null = null;
  let bestTok = -1;
  for (const [model, b] of d.models) {
    const tok = bucketTokens(b);
    if (tok > bestTok) {
      bestTok = tok;
      best = model;
    }
  }
  return best;
}

/** Local-midnight epoch ms for a timestamp. */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Stable per-local-day ordinal (round handles DST ±1h drift). */
function dayOrdinal(sodMs: number): number {
  return Math.round(sodMs / DAY);
}

/** `YYYY-MM-DD` for a local-midnight epoch ms. */
function localDateKey(sodMs: number): string {
  const d = new Date(sodMs);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Roll up the full timeline into per-day buckets, sorted ascending by date. */
export function dailyStats(report: Report): DayStat[] {
  const map = new Map<string, DayStat>();
  const tsByDay = new Map<string, number[]>();
  for (const turn of report.entries) {
    const sod = startOfLocalDay(turn.ts);
    const key = localDateKey(sod);
    let day = map.get(key);
    if (!day) {
      day = {
        dateKey: key,
        ts: sod,
        bucket: emptyBucket(),
        models: new Map(),
        firstTs: turn.ts,
        lastTs: turn.ts,
        activeMs: 0,
      };
      map.set(key, day);
    }
    addBucket(day.bucket, turn.usage, turn.genMs);
    let mb = day.models.get(turn.model);
    if (!mb) {
      mb = emptyBucket();
      day.models.set(turn.model, mb);
    }
    addBucket(mb, turn.usage, turn.genMs);
    if (turn.ts < day.firstTs) day.firstTs = turn.ts;
    if (turn.ts > day.lastTs) day.lastTs = turn.ts;
    let times = tsByDay.get(key);
    if (!times) {
      times = [];
      tsByDay.set(key, times);
    }
    times.push(turn.ts);
  }

  // Active working time per day: sum the gaps between consecutive turns that
  // are short enough to count as "still working" (idle gaps are dropped).
  for (const [key, times] of tsByDay) {
    times.sort((a, b) => a - b);
    let active = 0;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap > 0 && gap <= ACTIVE_GAP_MS) active += gap;
    }
    const day = map.get(key);
    if (day) day.activeMs = active;
  }

  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

/** Which metric drives the heatmap/stats intensity. */
export type Metric = "usd" | "tokens";

/** Pick the metric value out of a bucket. */
export function metricValue(b: Bucket, metric: Metric): number {
  return metric === "tokens" ? bucketTokens(b) : b.cost;
}

/** Choose the natural metric for a report: USD when there's real pricing. */
export function naturalMetric(days: DayStat[]): Metric {
  const totalCost = days.reduce((s, d) => s + d.bucket.cost, 0);
  return totalCost > 0 ? "usd" : "tokens";
}

/** One cell (one calendar day) in the contribution graph. */
export interface ContribCell {
  dateKey: string;
  ts: number;
  value: number;
  /** Intensity bucket 0..4 (0 = no activity). */
  level: number;
}

/** GitHub-style contribution graph: columns = weeks, 7 rows = Sun..Sat. */
export interface ContribGraph {
  /** weeks[col][row] — row 0 = Sunday. Empty cells (future/pre-range) are null. */
  weeks: Array<Array<ContribCell | null>>;
  maxValue: number;
  metric: Metric;
}

/**
 * Build a ~53-week contribution graph ending on the current week, aligned so
 * each column is a Sun..Sat week (mirrors GitHub / Tokscale's Stats view).
 */
export function contributionGraph(report: Report, weeks = 53, metric?: Metric): ContribGraph {
  const days = dailyStats(report);
  const m = metric ?? naturalMetric(days);
  const byKey = new Map(days.map((d) => [d.dateKey, d]));

  const now = new Date();
  const todaySod = startOfLocalDay(now.getTime());
  // Walk back to the Sunday that starts the earliest visible week.
  const todayDow = new Date(todaySod).getDay(); // 0 = Sun
  const startSod = todaySod - (todayDow + (weeks - 1) * 7) * DAY;

  let maxValue = 0;
  const cols: Array<Array<ContribCell | null>> = [];
  for (let w = 0; w < weeks; w++) {
    const col: Array<ContribCell | null> = [];
    for (let row = 0; row < 7; row++) {
      const sod = startSod + (w * 7 + row) * DAY;
      if (sod > todaySod) {
        col.push(null);
        continue;
      }
      const key = localDateKey(sod);
      const day = byKey.get(key);
      // Intensity tracks activity (tokens), not cost: token-priced days have
      // cost 0 but are still very much "active", so cost would wrongly leave
      // them blank.
      const value = day ? bucketTokens(day.bucket) : 0;
      maxValue = Math.max(maxValue, value);
      col.push({ dateKey: key, ts: sod, value, level: 0 });
    }
    cols.push(col);
  }

  // Assign intensity levels relative to the max (log-ish thresholds).
  for (const col of cols) {
    for (const cell of col) {
      if (!cell || cell.value <= 0 || maxValue <= 0) continue;
      const r = cell.value / maxValue;
      cell.level = r > 0.66 ? 4 : r > 0.33 ? 3 : r > 0.1 ? 2 : 1;
    }
  }

  return { weeks: cols, maxValue, metric: m };
}

/** Selectable time range for the Stats view summary. */
export type StatsRange = "all" | "30d" | "7d";

/** Epoch-ms lower bound for a stats range (-1 = all time). */
export function rangeSince(range: StatsRange): number {
  const now = Date.now();
  if (range === "7d") return now - 7 * DAY;
  if (range === "30d") return now - 30 * DAY;
  return -1;
}

/** Human label for a stats range. */
export function rangeLabel(range: StatsRange): string {
  switch (range) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "all":
      return "All time";
  }
}

/** Lifetime usage statistics for the Stats view. */
export interface UsageStats {
  totalCost: number;
  totalTokens: number;
  totalTurns: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  busiestDay: { dateKey: string; value: number } | null;
  firstDay: string | null;
  lastDay: string | null;
  avgPerActiveDay: number;
  /** Most-used model in range (by the active metric). */
  favoriteModel: string | null;
  /** Hour-of-day (0-23) with the most usage, or null when no activity. */
  peakHour: number | null;
  metric: Metric;
}

/**
 * Compute usage stats (totals, active days, streaks, busiest day, favorite
 * model, peak hour). `sinceMs` filters the timeline (-1 = all time).
 */
export function computeStats(report: Report, metric?: Metric, sinceMs = -1): UsageStats {
  const entries = sinceMs < 0 ? report.entries : report.entries.filter((e) => e.ts >= sinceMs);
  const scoped: Report = { ...report, entries };
  const days = dailyStats(scoped);
  const m = metric ?? naturalMetric(days);

  let totalCost = 0;
  let totalTokens = 0;
  let totalTurns = 0;
  let busiestDay: { dateKey: string; value: number } | null = null;
  for (const d of days) {
    totalCost += d.bucket.cost;
    totalTokens += bucketTokens(d.bucket);
    totalTurns += d.bucket.turns;
    const v = metricValue(d.bucket, m);
    if (!busiestDay || v > busiestDay.value) {
      busiestDay = { dateKey: d.dateKey, value: v };
    }
  }

  // Favorite model + peak hour from the scoped turn timeline.
  const byModel = new Map<string, number>();
  const byHour = new Array<number>(24).fill(0);
  for (const t of entries) {
    const tok = t.usage.input + t.usage.output + t.usage.cacheRead + t.usage.cacheWrite;
    const v = m === "tokens" ? tok : t.cost;
    byModel.set(t.model, (byModel.get(t.model) ?? 0) + v);
    const hour = new Date(t.ts).getHours();
    byHour[hour] += v;
  }
  let favoriteModel: string | null = null;
  let favVal = -1;
  for (const [model, v] of byModel) {
    if (v > favVal) {
      favVal = v;
      favoriteModel = model;
    }
  }
  let peakHour: number | null = null;
  let peakVal = -1;
  for (let h = 0; h < 24; h++) {
    if (byHour[h] > peakVal) {
      peakVal = byHour[h];
      peakHour = h;
    }
  }
  if (peakVal <= 0) peakHour = null;

  const ordinals = days.map((d) => dayOrdinal(d.ts));
  let longestStreak = 0;
  let run = 0;
  let prev: number | null = null;
  for (const o of ordinals) {
    run = prev !== null && o === prev + 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    prev = o;
  }

  let currentStreak = 0;
  if (ordinals.length > 0) {
    const todayOrd = dayOrdinal(startOfLocalDay(Date.now()));
    const last = ordinals[ordinals.length - 1];
    if (last === todayOrd || last === todayOrd - 1) {
      currentStreak = 1;
      for (let i = ordinals.length - 2; i >= 0; i--) {
        if (ordinals[i] === ordinals[i + 1] - 1) currentStreak += 1;
        else break;
      }
    }
  }

  const activeDays = days.length;
  const avgPerActiveDay =
    activeDays > 0 ? (m === "tokens" ? totalTokens : totalCost) / activeDays : 0;

  return {
    totalCost,
    totalTokens,
    totalTurns,
    activeDays,
    currentStreak,
    longestStreak,
    busiestDay,
    firstDay: days[0]?.dateKey ?? null,
    lastDay: days[days.length - 1]?.dateKey ?? null,
    avgPerActiveDay,
    favoriteModel,
    peakHour,
    metric: m,
  };
}

// ---------------------------------------------------------------------------
// Hourly / Agents / Wrapped AI aggregation
// ---------------------------------------------------------------------------

/** Usage rolled up by local hour-of-day (0–23), across all days. */
export interface HourStat {
  hour: number;
  bucket: Bucket;
  models: Map<string, Bucket>;
}

function topByTokens(models: Map<string, Bucket>): string | null {
  let best: string | null = null;
  let bestTok = -1;
  for (const [name, b] of models) {
    const tok = bucketTokens(b);
    if (tok > bestTok) {
      bestTok = tok;
      best = name;
    }
  }
  return best;
}

/** Aggregate the timeline by hour-of-day (local clock). Always returns 24 slots. */
export function hourlyStats(report: Report): HourStat[] {
  const slots: HourStat[] = [];
  for (let h = 0; h < 24; h++) {
    slots.push({ hour: h, bucket: emptyBucket(), models: new Map() });
  }
  for (const turn of report.entries) {
    const h = new Date(turn.ts).getHours();
    const slot = slots[h];
    addBucket(slot.bucket, turn.usage, turn.genMs);
    let mb = slot.models.get(turn.model);
    if (!mb) {
      mb = emptyBucket();
      slot.models.set(turn.model, mb);
    }
    addBucket(mb, turn.usage, turn.genMs);
  }
  return slots;
}

/** Top model for an hour slot (by tokens). */
export function hourTopModel(h: HourStat): string | null {
  return topByTokens(h.models);
}

/** Usage rolled up by provider (agent backend). */
export interface AgentStat {
  provider: string;
  bucket: Bucket;
  models: Map<string, Bucket>;
  projects: Set<string>;
  firstTs: number;
  lastTs: number;
}

/** Aggregate the timeline by provider, sorted by tokens descending. */
export function agentStats(report: Report): AgentStat[] {
  const map = new Map<string, AgentStat>();
  for (const turn of report.entries) {
    const key = turn.provider || "(unknown)";
    let agent = map.get(key);
    if (!agent) {
      agent = {
        provider: key,
        bucket: emptyBucket(),
        models: new Map(),
        projects: new Set(),
        firstTs: turn.ts,
        lastTs: turn.ts,
      };
      map.set(key, agent);
    }
    addBucket(agent.bucket, turn.usage, turn.genMs);
    let mb = agent.models.get(turn.model);
    if (!mb) {
      mb = emptyBucket();
      agent.models.set(turn.model, mb);
    }
    addBucket(mb, turn.usage, turn.genMs);
    if (turn.project) agent.projects.add(turn.project);
    if (turn.ts < agent.firstTs) agent.firstTs = turn.ts;
    if (turn.ts > agent.lastTs) agent.lastTs = turn.ts;
  }
  return stableSort([...map.values()], (a, b) => bucketTokens(b.bucket) - bucketTokens(a.bucket));
}

/** Top model for a provider (by tokens). */
export function agentTopModel(a: AgentStat): string | null {
  return topByTokens(a.models);
}

/** Calendar years present in the report (newest first). */
export function availableYears(report: Report): number[] {
  const years = new Set<number>();
  for (const e of report.entries) {
    years.add(new Date(e.ts).getFullYear());
  }
  return [...years].sort((a, b) => b - a);
}

/** Default Wrapped AI year: current year if active, else the year with most tokens. */
export function defaultWrappedYear(report: Report): number {
  const years = availableYears(report);
  if (years.length === 0) return new Date().getFullYear();
  const current = new Date().getFullYear();
  if (years.includes(current)) return current;
  let bestYear = years[0];
  let bestTok = -1;
  for (const y of years) {
    let tok = 0;
    for (const e of report.entries) {
      if (new Date(e.ts).getFullYear() !== y) continue;
      tok += e.usage.input + e.usage.output + e.usage.cacheRead + e.usage.cacheWrite;
    }
    if (tok > bestTok) {
      bestTok = tok;
      bestYear = y;
    }
  }
  return bestYear;
}

/** Compact year-in-review stats for the Wrapped AI view. */
export interface WrappedStats {
  year: number;
  totalCost: number;
  totalTokens: number;
  totalTurns: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  favoriteModel: string | null;
  favoriteProvider: string | null;
  topProject: string | null;
  busiestDay: { dateKey: string; value: number } | null;
  peakHour: number | null;
  avgPerActiveDay: number;
  modelCount: number;
  providerCount: number;
  projectCount: number;
  /** Token totals per calendar month (Jan..Dec) for the selected year. */
  monthlyTokens: number[];
  topModels: Array<{ name: string; tokens: number; pct: number }>;
  topProviders: Array<{ name: string; tokens: number; pct: number }>;
  metric: Metric;
}

/** Build Wrapped AI stats for a calendar year. Returns null when the year has no activity. */
export function wrappedStats(report: Report, year: number): WrappedStats | null {
  const entries = report.entries.filter((e) => new Date(e.ts).getFullYear() === year);
  if (entries.length === 0) return null;

  const scoped: Report = {
    ...report,
    entries,
    turnCount: entries.length,
  };
  const base = computeStats(scoped);
  const agents = agentStats(scoped);
  const favoriteProvider = agents[0]?.provider ?? null;

  const byProject = new Map<string, number>();
  const modelSet = new Set<string>();
  const providerSet = new Set<string>();
  const monthlyTokens = new Array<number>(12).fill(0);

  for (const t of entries) {
    modelSet.add(t.model);
    providerSet.add(t.provider || "(unknown)");
    const tok = t.usage.input + t.usage.output + t.usage.cacheRead + t.usage.cacheWrite;
    monthlyTokens[new Date(t.ts).getMonth()] += tok;
    if (t.project) {
      byProject.set(t.project, (byProject.get(t.project) ?? 0) + tok);
    }
  }

  let topProject: string | null = null;
  let topProjTok = -1;
  for (const [proj, tok] of byProject) {
    if (tok > topProjTok) {
      topProjTok = tok;
      topProject = proj;
    }
  }

  const byModel = new Map<string, number>();
  for (const t of entries) {
    const tok = t.usage.input + t.usage.output + t.usage.cacheRead + t.usage.cacheWrite;
    byModel.set(t.model, (byModel.get(t.model) ?? 0) + tok);
  }
  const topModels = ranked(byModel, (v) => v)
    .slice(0, 3)
    .map(([name, tokens]) => ({
      name,
      tokens,
      pct: base.totalTokens > 0 ? (tokens / base.totalTokens) * 100 : 0,
    }));

  const topProviders = agents.slice(0, 3).map((a) => {
    const tokens = bucketTokens(a.bucket);
    return {
      name: a.provider,
      tokens,
      pct: base.totalTokens > 0 ? (tokens / base.totalTokens) * 100 : 0,
    };
  });

  return {
    year,
    totalCost: base.totalCost,
    totalTokens: base.totalTokens,
    totalTurns: base.totalTurns,
    activeDays: base.activeDays,
    currentStreak: base.currentStreak,
    longestStreak: base.longestStreak,
    favoriteModel: base.favoriteModel,
    favoriteProvider,
    topProject,
    busiestDay: base.busiestDay,
    peakHour: base.peakHour,
    avgPerActiveDay: base.avgPerActiveDay,
    modelCount: modelSet.size,
    providerCount: providerSet.size,
    projectCount: byProject.size,
    monthlyTokens,
    topModels,
    topProviders,
    metric: base.metric,
  };
}
