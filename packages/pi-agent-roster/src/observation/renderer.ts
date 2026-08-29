import { Text } from "@earendil-works/pi-tui";
import { isTerminalErrorStatus, type SubagentStatus } from "../lifecycle/subagent-state.ts";
import {
  buildInvocationMetadataParts,
  formatMs,
  formatTokens,
  formatTurns,
} from "../ui/display.ts";
import { GLYPHS } from "../ui/glyphs.ts";
import type { NotificationDetails } from "./notification.ts";

/** Narrow theme interface — only the methods the renderer actually calls. */
interface RendererTheme {
  fg(style: string, text: string): string;
  bold(text: string): string;
}

/** Narrow message interface — only the fields the renderer reads. */
interface RendererMessage {
  details?: NotificationDetails | undefined;
}

/** Narrow render options — only the fields the renderer reads. */
interface RenderOptions {
  expanded: boolean;
}

// ---- Pure helpers (exported for unit testing) ----

/** Resolved status→presentation product: icon glyph/style and status label. */
export interface StatusPresentation {
  iconGlyph: string;
  iconStyle: string;
  statusText: string;
}

/** Decide the icon and status label for a notification's status, once. */
export function resolveStatusPresentation(status: SubagentStatus): StatusPresentation {
  if (isTerminalErrorStatus(status))
    return { iconGlyph: GLYPHS.failure, iconStyle: "error", statusText: status };
  const statusText = status === "steered" ? "completed (steered)" : "completed";
  return { iconGlyph: GLYPHS.success, iconStyle: "success", statusText };
}

/** Fields `buildStatsParts` reads from a `NotificationDetails`. */
type StatsSource = Pick<
  NotificationDetails,
  "turnCount" | "maxTurns" | "toolUses" | "totalTokens" | "durationMs"
>;

/** Assemble the stats-line parts (turns, tool uses, tokens, duration), omitting zero fields. */
export function buildStatsParts(d: StatsSource): string[] {
  const parts: string[] = [];
  if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
  if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
  return parts;
}

function renderDetailLine(parts: readonly string[], theme: RendererTheme): string {
  const separator = ` ${theme.fg("dim", "·")} `;
  return `\n  ${parts.map((part) => theme.fg("dim", part)).join(separator)}`;
}

/** Content lines for the complete result when expanded, or a compact collapsed summary. */
export function buildPreviewLines(resultPreview: string, expanded: boolean): string[] {
  if (expanded) return resultPreview.split("\n");
  return [resultPreview.split("\n")[0]?.slice(0, 80) ?? ""];
}

/**
 * Create the notification renderer callback for `pi.registerMessageRenderer`.
 * Returns a factory so the renderer is independently testable without the Pi SDK.
 */
export function createNotificationRenderer() {
  return (
    message: RendererMessage,
    { expanded }: RenderOptions,
    theme: RendererTheme,
  ): Text | undefined => {
    const d = message.details;
    if (!d) return undefined;

    const { iconGlyph, iconStyle, statusText } = resolveStatusPresentation(d.status);

    // Collapsed view stays a compact summary; expanded view adds the audit details below.
    let line = `${theme.fg(iconStyle, iconGlyph)} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;
    line += ` ${theme.fg("dim", `ID: ${d.id}`)}`;

    if (expanded) {
      const invocationParts = buildInvocationMetadataParts(d);
      if (invocationParts.length) line += renderDetailLine(invocationParts, theme);

      const parts = buildStatsParts(d);
      if (parts.length) line += renderDetailLine(parts, theme);

      const previewLines = buildPreviewLines(d.resultPreview, true);
      for (const l of previewLines) line += "\n" + theme.fg("dim", `  ${l}`);

      // Output file link (if present)
      if (d.outputFile) line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
    }

    return new Text(line, 0, 0);
  };
}
