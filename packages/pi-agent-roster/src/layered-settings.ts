/**
 * Generic layered settings loader for `pi-agent-roster` extensions.
 *
 * Extensions that store configuration in JSON files under a global agent
 * directory and a per-project `.pi/` folder share the same three-step idiom:
 *
 *   1. Read the global file (`<agentDir>/<filename>`).
 *   2. Read the project file (`<cwd>/.pi/<filename>`).
 *   3. Merge them — project wins on conflicts — and return the result.
 *
 * Both layers are optional: a missing file is silent (`{}`), and a file that
 * cannot be parsed warns to stderr and is treated as absent so startup
 * proceeds normally.
 *
 * ## Usage
 *
 * ```typescript
 * import { loadLayeredSettings, type LayeredSettingsSource } from "pi-agent-roster/settings";
 *
 * interface MyConfig { enabled?: boolean; limit?: number }
 *
 * function sanitize(raw: unknown): Partial<MyConfig> {
 *   if (!raw || typeof raw !== "object") return {};
 *   const r = raw as Record<string, unknown>;
 *   const out: Partial<MyConfig> = {};
 *   if (typeof r.enabled === "boolean") out.enabled = r.enabled;
 *   if (typeof r.limit === "number") out.limit = r.limit;
 *   return out;
 * }
 *
 * const config = loadLayeredSettings<MyConfig>({
 *   agentDir,     // e.g. from the Pi runtime env — the agent home directory
 *   cwd,          // project root — project file is at <cwd>/.pi/<filename>
 *   filename: "my-extension.json",
 *   sanitize,
 *   warnLabel: "my-extension",
 * });
 * ```
 *
 * @public
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parameters for one layered settings load: describes where the files live,
 * how to validate their contents, and what label to use in warnings.
 *
 * @public
 */
export interface LayeredSettingsSource<T> {
  /** Directory holding the global settings file (typically the Pi agent dir). */
  agentDir: string;
  /** Project root; the project file lives at `<cwd>/.pi/<filename>`. */
  cwd: string;
  /** Base filename for both layers, e.g. `"agent-roster.json"`. */
  filename: string;
  /**
   * Validate parsed JSON into a partial settings object. Report unknown or
   * invalid fields through `diagnose`, then omit them. Never throw.
   */
  sanitize: (raw: unknown, diagnose?: (message: string) => void) => Partial<T>;
  /**
   * Short label used in the malformed-file warning prefix,
   * e.g. `"pi-agent-roster"` → `"[pi-agent-roster] Ignoring malformed settings at …"`.
   */
  warnLabel: string;
}

/**
 * Load merged layered settings: global provides defaults, project overrides.
 *
 * - A missing file is silent — returns `{}` for that layer.
 * - A file that exists but cannot be parsed warns to stderr and returns `{}` for
 *   that layer, so startup proceeds normally.
 * - Invalid fields warn individually; valid fields in the same file survive.
 * - The two layers are merged with a shallow spread; project keys win.
 *
 * Throws nothing. Diagnostics identify the file, problem, and corrective action.
 *
 * @public
 */
export function loadLayeredSettings<T>(source: LayeredSettingsSource<T>): Partial<T> {
  const { agentDir, cwd, filename, sanitize, warnLabel } = source;
  const global = readLayer(join(agentDir, filename), sanitize, warnLabel);
  const project = readLayer(join(cwd, ".pi", filename), sanitize, warnLabel);
  return { ...global, ...project };
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Read one settings file. Missing → `{}` (silent). Malformed → `{}` + warn.
 */
function readLayer<T>(
  path: string,
  sanitize: (raw: unknown, diagnose?: (message: string) => void) => Partial<T>,
  warnLabel: string,
): Partial<T> {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")), (message) =>
      console.warn(`[${warnLabel}] Invalid settings at ${path}: ${message}`),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[${warnLabel}] Could not parse settings at ${path}: ${reason}. Fix the JSON or remove the file; ignoring this layer.`,
    );
    return {};
  }
}
