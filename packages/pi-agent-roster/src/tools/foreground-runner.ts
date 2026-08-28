import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ChildRuntimeBaseline } from "../lifecycle/child-runtime-baseline.ts";
import type { AgentSpawnConfig } from "../lifecycle/subagent-manager.ts";
import type { ParentSessionInfo, Subagent } from "../types.ts";
import { type AgentDetails, describeActivity, formatMs } from "../ui/display.ts";
import { SPINNER } from "../ui/glyphs.ts";
import { buildDetails, formatLifetimeTokens, getStatusNote, textResult } from "./helpers.ts";
import type { ResolvedSpawnConfig } from "./spawn-config.ts";

/** Narrow manager interface for the foreground runner. */
export interface ForegroundManagerDeps {
  spawnAndWait(
    baseline: ChildRuntimeBaseline,
    type: string,
    task: string,
    opts: Omit<AgentSpawnConfig, "isBackground">,
  ): Promise<Subagent>;
}

/** All values the foreground runner needs beyond the resolved config. */
export interface ForegroundParams {
  config: ResolvedSpawnConfig;
  baseline: ChildRuntimeBaseline;
  parentSession: ParentSessionInfo;
}

/**
 * Run an agent synchronously in the foreground, streaming spinner updates.
 * Owns: spinner interval, streaming onUpdate callbacks, cleanup, and result formatting.
 */
export async function runForeground(
  manager: ForegroundManagerDeps,
  params: ForegroundParams,
  signal: AbortSignal | undefined,
  onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
) {
  const { identity, execution, presentation } = params.config;
  let spinnerFrame = 0;
  const startedAt = Date.now();

  let recordRef: Subagent | undefined;

  const streamUpdate = () => {
    const toolUses = recordRef?.toolUses ?? 0;
    const details: AgentDetails = {
      ...presentation.detailBase,
      toolUses,
      tokens: recordRef ? formatLifetimeTokens(recordRef) : "",
      // Read activity off the record; fall back to safe defaults before onSessionCreated fires
      turnCount: recordRef?.turnCount ?? 1,
      maxTurns: recordRef?.maxTurns ?? execution.effectiveMaxTurns,
      durationMs: Date.now() - startedAt,
      status: "running",
      activity: describeActivity(
        recordRef?.activeTools ?? new Map(),
        recordRef?.responseText ?? "",
      ),
      spinnerFrame: spinnerFrame % SPINNER.length,
    };
    onUpdate?.({
      content: [{ type: "text", text: `${toolUses} tool uses...` }],
      details,
    });
  };

  // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
  const spinnerInterval = setInterval(() => {
    spinnerFrame++;
    streamUpdate();
  }, 80);

  streamUpdate();

  let record: Subagent;
  try {
    record = await manager.spawnAndWait(params.baseline, identity.subagentType, execution.task, {
      description: execution.description,
      model: execution.model,
      maxTurns: execution.effectiveMaxTurns,
      graceTurns: execution.effectiveGraceTurns,
      thinkingLevel: execution.thinking,
      invocation: execution.agentInvocation,
      signal,
      parentSession: params.parentSession,
      observer: {
        onSessionCreated: (agent) => {
          recordRef = agent;
        },
      },
    });
  } catch (err) {
    clearInterval(spinnerInterval);
    return textResult(err instanceof Error ? err.message : String(err));
  }

  clearInterval(spinnerInterval);

  // Foreground-return delivery edge: the result is handed back in this tool
  // result, so the outcome is collected. Mark it consumed.
  record.markConsumed();

  const tokenText = formatLifetimeTokens(record);
  const details = buildDetails(presentation.detailBase, record, { tokens: tokenText });

  const fallbackNote = identity.fellBack
    ? `Note: Unknown agent type "${identity.rawType}" — using general-purpose.\n\n`
    : "";

  if (record.status === "error") {
    return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  return textResult(
    `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
      (record.result?.trim() ?? "No output."),
    details,
  );
}
