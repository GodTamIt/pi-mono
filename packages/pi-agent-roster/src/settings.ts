// Persistence for pi-agent-roster operational settings.
// - Global:  ~/.pi/agent/agent-roster.json (agentDir injected at construction) — manual defaults, never written here
// - Project: <cwd>/.pi/agent-roster.json — written by /agents → Settings; overrides global on load

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type LayeredSettingsSource, loadLayeredSettings } from "./layered-settings.ts";
export interface SubagentsSettings {
  maxConcurrent?: number | undefined;
  /**
   * Omission means unlimited. Legacy settings may use 0, which is normalized
   * to omission in memory and on the next project-settings write.
   */
  defaultMaxTurns?: number | undefined;
  graceTurns?: number | undefined;
  /** Minutes a consumed agent's session is retained after its last relevance event. */
  consumedSessionRetentionMinutes?: number | undefined;
  /** Minutes an unconsumed agent's session is retained (safety cap). */
  unconsumedSessionRetentionMinutes?: number | undefined;
  /**
   * When false, a parent interrupt (ESC) leaves background and queued subagents
   * running. Foreground agents hold the parent's run signal directly, so they
   * abort on ESC either way.
   */
  abortAllOnInterrupt?: boolean | undefined;
  /**
   * Pi package sources whose extensions child sessions must not load, matched
   * against Pi's configured source string exactly (e.g. `npm:@scope/pkg`).
   * The package's skills, prompts, and themes stay available to children.
   */
  excludedExtensionPackages?: string[] | undefined;
}

/**
 * The persisted form of the in-memory settings values.
 * `saveSettings` rewrites the whole project file from this shape, so every key
 * that must survive a `/subagents:settings` edit has to appear here.
 */
export interface SettingsSnapshot {
  maxConcurrent: number;
  defaultMaxTurns?: number | undefined;
  graceTurns?: number | undefined;
  consumedSessionRetentionMinutes: number;
  unconsumedSessionRetentionMinutes: number;
  abortAllOnInterrupt: boolean;
  /**
   * Present only when non-empty, so files that never set it gain no noise.
   * It must round-trip: the key has no `/subagents:settings` affordance, so a
   * hand-edited value would otherwise be erased by any unrelated setting change.
   */
  excludedExtensionPackages?: string[] | undefined;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_CONSUMED_RETENTION_MINUTES = 10;
const DEFAULT_UNCONSUMED_RETENTION_MINUTES = 720;
const DEFAULT_ABORT_ALL_ON_INTERRUPT = true;

/**
 * Owns all three in-memory settings values and their load/save/persist cycle.
 * Replaces the scattered free-function + SettingsAppliers callback pattern.
 */
export class SettingsManager {
  private _defaultMaxTurns: number | undefined = undefined;
  private _graceTurns: number | undefined = undefined;
  private _maxConcurrent: number = DEFAULT_MAX_CONCURRENT;
  private _consumedSessionRetentionMinutes: number = DEFAULT_CONSUMED_RETENTION_MINUTES;
  private _unconsumedSessionRetentionMinutes: number = DEFAULT_UNCONSUMED_RETENTION_MINUTES;
  private _abortAllOnInterrupt: boolean = DEFAULT_ABORT_ALL_ON_INTERRUPT;
  private _excludedExtensionPackages: string[] = [];

  private readonly emit: SettingsEmit;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly onMaxConcurrentChanged: (() => void) | undefined;

  constructor(deps: {
    emit: SettingsEmit;
    cwd: string;
    agentDir: string;
    onMaxConcurrentChanged?: (() => void) | undefined;
  }) {
    this.emit = deps.emit;
    this.cwd = deps.cwd;
    this.agentDir = deps.agentDir;
    this.onMaxConcurrentChanged = deps.onMaxConcurrentChanged;
  }

  // ── defaultMaxTurns: 0 or undefined → unlimited (undefined); else max(1, n) ──

  get defaultMaxTurns(): number | undefined {
    return this._defaultMaxTurns;
  }

  set defaultMaxTurns(n: number | undefined) {
    if (n == null || n === 0) {
      this._defaultMaxTurns = undefined;
    } else {
      this._defaultMaxTurns = Math.max(1, n);
    }
  }

  // ── graceTurns: absent means unlimited; zero is a valid finite value ──

  get graceTurns(): number | undefined {
    return this._graceTurns;
  }

  set graceTurns(n: number | undefined) {
    this._graceTurns = n;
  }

  // ── maxConcurrent: minimum 1 ──

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  set maxConcurrent(n: number) {
    this._maxConcurrent = Math.max(1, n);
  }

  // ── retention windows: clamped to [1, RETENTION_MINUTES_CEILING] minutes ──

  get consumedSessionRetentionMinutes(): number {
    return this._consumedSessionRetentionMinutes;
  }

  set consumedSessionRetentionMinutes(n: number) {
    this._consumedSessionRetentionMinutes = clampRetentionMinutes(n);
  }

  get unconsumedSessionRetentionMinutes(): number {
    return this._unconsumedSessionRetentionMinutes;
  }

  set unconsumedSessionRetentionMinutes(n: number) {
    this._unconsumedSessionRetentionMinutes = clampRetentionMinutes(n);
  }

  // ── abortAllOnInterrupt: flipped via toggleAbortAllOnInterrupt(); no normalization ──

  get abortAllOnInterrupt(): boolean {
    return this._abortAllOnInterrupt;
  }

  // ── excludedExtensionPackages: hand-edited only; no /subagents:settings affordance ──

  get excludedExtensionPackages(): readonly string[] {
    return this._excludedExtensionPackages;
  }

  // ── Lifecycle methods ──

  /**
   * Load merged settings (global + project), apply to in-memory values,
   * and emit the `subagents:settings_loaded` lifecycle event.
   * Returns the raw loaded settings object.
   */
  load(): SubagentsSettings {
    const settings = loadSettings(this.agentDir, this.cwd);
    this._defaultMaxTurns = undefined;
    this._graceTurns = undefined;
    if (typeof settings.maxConcurrent === "number") this.maxConcurrent = settings.maxConcurrent;
    if (typeof settings.defaultMaxTurns === "number")
      this.defaultMaxTurns = settings.defaultMaxTurns;
    if (typeof settings.graceTurns === "number") this.graceTurns = settings.graceTurns;
    if (typeof settings.consumedSessionRetentionMinutes === "number")
      this.consumedSessionRetentionMinutes = settings.consumedSessionRetentionMinutes;
    if (typeof settings.unconsumedSessionRetentionMinutes === "number")
      this.unconsumedSessionRetentionMinutes = settings.unconsumedSessionRetentionMinutes;
    if (typeof settings.abortAllOnInterrupt === "boolean")
      this._abortAllOnInterrupt = settings.abortAllOnInterrupt;
    // Assigned unconditionally: removing the key from disk must clear the value.
    this._excludedExtensionPackages = [...(settings.excludedExtensionPackages ?? [])];
    this.emit("subagents:settings_loaded", { settings });
    return settings;
  }

  /** Snapshot current in-memory values for project-local persistence. */
  snapshot(): SettingsSnapshot {
    const snapshot: SettingsSnapshot = {
      maxConcurrent: this._maxConcurrent,
      consumedSessionRetentionMinutes: this._consumedSessionRetentionMinutes,
      unconsumedSessionRetentionMinutes: this._unconsumedSessionRetentionMinutes,
      abortAllOnInterrupt: this._abortAllOnInterrupt,
    };
    if (this._defaultMaxTurns !== undefined) snapshot.defaultMaxTurns = this._defaultMaxTurns;
    if (this._graceTurns !== undefined) snapshot.graceTurns = this._graceTurns;
    if (this._excludedExtensionPackages.length > 0) {
      snapshot.excludedExtensionPackages = [...this._excludedExtensionPackages];
    }
    return snapshot;
  }

  /**
   * Set maxConcurrent, notify interested parties, persist, and return the toast.
   * Owns the full consequence chain so callers just say what they want.
   */
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
    this.maxConcurrent = n; // setter normalizes: max(1, n)
    this.onMaxConcurrentChanged?.();
    return this.saveAndNotify(`Max concurrency set to ${this.maxConcurrent}`);
  }

  /** Set defaultMaxTurns, persist, and return the toast. */
  applyDefaultMaxTurns(n: number | undefined): { message: string; level: "info" | "warning" } {
    this.defaultMaxTurns = n;
    const label = this.defaultMaxTurns == null ? "unlimited" : String(this.defaultMaxTurns);
    return this.saveAndNotify(`Default max turns set to ${label}`);
  }

  /**
   * Set graceTurns, persist, and return the toast.
   */
  applyGraceTurns(n: number | undefined): { message: string; level: "info" | "warning" } {
    this.graceTurns = n;
    return this.saveAndNotify(`Grace turns set to ${this.graceTurns ?? "unlimited"}`);
  }

  /** Set the consumed-session retention window (minutes), persist, and return the toast. */
  applyConsumedSessionRetentionMinutes(n: number): { message: string; level: "info" | "warning" } {
    this.consumedSessionRetentionMinutes = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(
      `Consumed-session retention set to ${this.consumedSessionRetentionMinutes} min`,
    );
  }

  /** Set the unconsumed-session retention window (minutes), persist, and return the toast. */
  applyUnconsumedSessionRetentionMinutes(n: number): {
    message: string;
    level: "info" | "warning";
  } {
    this.unconsumedSessionRetentionMinutes = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(
      `Unconsumed-session retention set to ${this.unconsumedSessionRetentionMinutes} min`,
    );
  }

  /**
   * Flip whether a parent interrupt (ESC) aborts every subagent, persist, and
   * return the toast. The manager owns the negation so callers just say "flip it".
   */
  toggleAbortAllOnInterrupt(): { message: string; level: "info" | "warning" } {
    this._abortAllOnInterrupt = !this._abortAllOnInterrupt;
    return this.saveAndNotify(
      `Abort all subagents on ESC: ${this._abortAllOnInterrupt ? "on" : "off"}`,
    );
  }

  /**
   * Persist the current snapshot, emit `subagents:settings_changed`,
   * and return the toast the UI should display.
   */
  saveAndNotify(successMsg: string): { message: string; level: "info" | "warning" } {
    const snap = this.snapshot();
    const persisted = saveSettings(snap, this.cwd);
    this.emit("subagents:settings_changed", { settings: snap, persisted });
    return persistToastFor(successMsg, persisted);
  }
}

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
// Retention windows: 1 minute floor, two-week ceiling (60 * 24 * 14).
const RETENTION_MINUTES_CEILING = 20_160;

/** Clamp a retention window to [1, RETENTION_MINUTES_CEILING] minutes. */
function clampRetentionMinutes(n: number): number {
  return Math.min(RETENTION_MINUTES_CEILING, Math.max(1, n));
}

/** True when a value is an integer minute count within the accepted retention range. */
function isRetentionMinutes(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= RETENTION_MINUTES_CEILING;
}

function sanitize(raw: unknown, diagnose: (message: string) => void = () => {}): SubagentsSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    diagnose("expected a JSON object; fix or remove this file");
    return {};
  }
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  const known = new Set([
    "maxConcurrent",
    "defaultMaxTurns",
    "graceTurns",
    "consumedSessionRetentionMinutes",
    "unconsumedSessionRetentionMinutes",
    "abortAllOnInterrupt",
    "excludedExtensionPackages",
  ]);
  for (const key of Object.keys(r)) {
    if (!known.has(key)) {
      const action =
        key === "stacks" || key === "model_stacks"
          ? "define stacks in agent Markdown files instead"
          : "remove it from this settings file";
      diagnose(`unknown field ${key}; ${action}`);
    }
  }
  readInteger(r, out, "maxConcurrent", 1, MAX_CONCURRENT_CEILING, diagnose);
  readInteger(r, out, "defaultMaxTurns", 0, MAX_TURNS_CEILING, diagnose);
  readInteger(r, out, "graceTurns", 0, GRACE_TURNS_CEILING, diagnose);
  for (const key of [
    "consumedSessionRetentionMinutes",
    "unconsumedSessionRetentionMinutes",
  ] as const) {
    if (r[key] !== undefined) {
      if (isRetentionMinutes(r[key])) out[key] = r[key];
      else {
        diagnose(
          `${key} must be an integer from 1 through ${RETENTION_MINUTES_CEILING}; fix or remove this value`,
        );
      }
    }
  }
  if (r.abortAllOnInterrupt !== undefined) {
    if (typeof r.abortAllOnInterrupt === "boolean") out.abortAllOnInterrupt = r.abortAllOnInterrupt;
    else diagnose("abortAllOnInterrupt must be a boolean; fix or remove this value");
  }
  if (r.excludedExtensionPackages !== undefined) {
    if (Array.isArray(r.excludedExtensionPackages)) {
      const valid = r.excludedExtensionPackages
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => value.trim());
      if (valid.length !== r.excludedExtensionPackages.length) {
        diagnose(
          "excludedExtensionPackages must contain only non-empty strings; fix or remove invalid entries",
        );
      }
      out.excludedExtensionPackages = [...new Set(valid)];
    } else {
      diagnose(
        "excludedExtensionPackages must be an array of non-empty strings; fix or remove this value",
      );
    }
  }
  return out;
}

function readInteger<K extends "maxConcurrent" | "defaultMaxTurns" | "graceTurns">(
  raw: Record<string, unknown>,
  out: SubagentsSettings,
  key: K,
  minimum: number,
  maximum: number,
  diagnose: (message: string) => void,
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum) {
    out[key] = value as number;
  } else {
    diagnose(
      `${key} must be an integer from ${minimum} through ${maximum}; fix or remove this value`,
    );
  }
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "agent-roster.json");
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(agentDir: string, cwd: string): SubagentsSettings {
  return loadLayeredSettings({
    agentDir,
    cwd,
    filename: "agent-roster.json",
    sanitize,
    warnLabel: "pi-agent-roster",
  } satisfies LayeredSettingsSource<SubagentsSettings>);
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}
