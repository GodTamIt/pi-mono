import type { ChildRuntimeBaseline } from "../lifecycle/child-runtime-baseline.ts";
import type { AgentSpawnConfig } from "../lifecycle/subagent-manager.ts";
import type { ParentSessionInfo, Subagent } from "../types.ts";
import { buildDetails, textResult } from "./helpers.ts";
import type { ResolvedSpawnConfig } from "./spawn-config.ts";

/** Narrow manager interface for the background spawner. */
export interface BackgroundManagerDeps {
  spawn(baseline: ChildRuntimeBaseline, type: string, task: string, opts: AgentSpawnConfig): string;
  getRecord(id: string): Subagent | undefined;
}

/** All values the background spawner needs beyond the resolved config. */
export interface BackgroundParams {
  config: ResolvedSpawnConfig;
  baseline: ChildRuntimeBaseline;
  parentSession: ParentSessionInfo;
  settings: { readonly maxConcurrent: number };
}

/**
 * Spawn a background agent and return the tool result immediately.
 * Owns: launch message formatting.
 */
export function spawnBackground(manager: BackgroundManagerDeps, params: BackgroundParams) {
  const { identity, execution, presentation } = params.config;

  let id: string;
  try {
    id = manager.spawn(params.baseline, identity.subagentType, execution.task, {
      parentSession: params.parentSession,
      description: execution.description,
      model: execution.model,
      maxTurns: execution.effectiveMaxTurns,
      graceTurns: execution.effectiveGraceTurns,
      thinkingLevel: execution.thinking,
      isBackground: true,
      invocation: execution.agentInvocation,
    });
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err));
  }

  const record = manager.getRecord(id);

  const isQueued = record?.status === "queued";
  return textResult(
    `Agent ${isQueued ? "queued" : "started"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${identity.displayName}\n` +
      `Description: ${execution.description}\n` +
      `Stack: ${execution.stack}\n` +
      (execution.agentInvocation.modelName
        ? `Model: ${execution.agentInvocation.modelName}\n`
        : "") +
      (execution.thinking ? `Thinking: ${execution.thinking}\n` : "") +
      (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
      (isQueued ? `Position: queued (max ${params.settings.maxConcurrent} concurrent)\n` : "") +
      `\nYou will be notified when this agent completes.\n` +
      `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
      `Do not duplicate this agent's work.`,
    record
      ? buildDetails(presentation.detailBase, record, { agentId: id })
      : {
          ...presentation.detailBase,
          toolUses: 0,
          tokens: "",
          durationMs: 0,
          status: "running" as const,
          agentId: id,
        },
  );
}
