import type {
  AgentToolResult,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentTypeRegistry } from "../config/agent-types.ts";
import type { ChildRuntimeBaseline } from "../lifecycle/child-runtime-baseline.ts";
import type { AgentSpawnConfig } from "../lifecycle/subagent-manager.ts";
import type { ParentSessionInfo, Subagent } from "../types.ts";
import { type AgentDetails, getDisplayName, type Theme } from "../ui/display.ts";
import { GLYPHS } from "../ui/glyphs.ts";
import { spawnBackground } from "./background-spawner.ts";
import { runForeground } from "./foreground-runner.ts";
import { buildAgentGuidelines, buildTypeListText, textResult } from "./helpers.ts";
import { renderAgentResult } from "./result-renderer.ts";
import { type ModelInfo, resolveResumeConfig, resolveSpawnConfig } from "./spawn-config.ts";

// ---- Deps interfaces ----

/** Narrow manager interface — only the methods the Agent tool calls. */
export interface AgentToolManager {
  spawn: (
    baseline: ChildRuntimeBaseline,
    type: string,
    task: string,
    opts: AgentSpawnConfig,
  ) => string;
  spawnAndWait: (
    baseline: ChildRuntimeBaseline,
    type: string,
    task: string,
    opts: Omit<AgentSpawnConfig, "isBackground">,
  ) => Promise<Subagent>;
  resume: (
    id: string,
    task: string,
    signal: AbortSignal,
    budgets?: { maxTurns?: number | undefined; graceTurns?: number | undefined },
  ) => Promise<Subagent | undefined>;
  getRecord: (id: string) => Subagent | undefined;
}

/** Narrow runtime interface — the Agent tool's slice of SubagentRuntime. */
export interface AgentToolRuntime {
  buildChildBaseline(): ChildRuntimeBaseline;
  getModelInfo(): ModelInfo;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

/** Narrow settings accessor — only the fields the Agent tool reads. */
export type AgentToolSettings = {
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number | undefined;
  readonly maxConcurrent: number;
};

// ---- Class ----

export class AgentTool {
  private readonly typeListText: string;
  private readonly availableTypesText: string;
  private readonly agentGuidelines: string[];

  constructor(
    private readonly manager: AgentToolManager,
    private readonly runtime: AgentToolRuntime,
    private readonly settings: AgentToolSettings,
    private readonly registry: AgentTypeRegistry,
    private readonly agentDir: string,
  ) {
    this.typeListText = buildTypeListText(registry, agentDir);
    this.availableTypesText = registry.getAvailableTypes().join(", ");
    this.agentGuidelines = buildAgentGuidelines(registry);
  }

  async execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
    _ctx: ExtensionContext,
  ) {
    // Reload custom agents so new .pi/agents/*.md files are picked up without restart
    this.registry.reload();

    // ---- Resume existing agent ----
    if (params.resume !== undefined) {
      const config = resolveResumeConfig(params);
      if ("error" in config) return textResult(config.error);
      const resumeId = typeof params.resume === "string" ? params.resume.trim() : "";
      if (!resumeId) return textResult("resume must be a non-empty string");
      if (
        params.stack !== undefined &&
        (typeof params.stack !== "string" || !params.stack.trim())
      ) {
        return textResult("stack must be a non-empty string");
      }
      if (params.stack !== undefined) {
        return textResult("stack selection is unavailable when resuming an existing child.");
      }
      const existing = this.manager.getRecord(resumeId);
      if (!existing) {
        return textResult(
          `Agent not found: "${resumeId}". Records are cleared at session start/switch, so it may be from a previous session.`,
        );
      }
      if (existing.isActive())
        return textResult(`Agent "${resumeId}" is still running and cannot be resumed.`);
      if (!existing.isSessionReady() && !existing.sessionReleased) {
        return textResult(`Agent "${resumeId}" has no child transcript to resume.`);
      }
      const record = await this.manager.resume(
        resumeId,
        config.task,
        signal ?? new AbortController().signal,
        {
          maxTurns: config.maxTurns,
          graceTurns: config.graceTurns,
        },
      );
      if (!record) {
        return textResult(`Failed to resume agent "${resumeId}".`);
      }
      // Resume-return delivery edge: the resumed outcome is returned directly.
      record.markConsumed();
      return textResult(record.result?.trim() ?? record.error?.trim() ?? "No output.");
    }

    // ---- Config resolution (pure) ----
    const config = resolveSpawnConfig(
      params,
      this.registry,
      this.runtime.getModelInfo(),
      this.settings,
    );
    if ("error" in config) return textResult(config.error);

    const baseline = this.runtime.buildChildBaseline();
    const { parentSessionFile, parentSessionId } = this.runtime.getSessionInfo();
    const parentSession: ParentSessionInfo = { parentSessionFile, parentSessionId, toolCallId };

    // ---- Background execution ----
    if (config.execution.runInBackground) {
      return spawnBackground(this.manager, {
        config,
        baseline,
        parentSession,
        settings: this.settings,
      });
    }

    // ---- Foreground execution — stream progress via onUpdate ----
    return runForeground(this.manager, { config, baseline, parentSession }, signal, onUpdate);
  }

  toToolDefinition() {
    const typeListText = this.typeListText;
    const availableTypesText = this.availableTypesText;
    const agentDir = this.agentDir;
    const registry = this.registry;

    const guidelines = [
      "- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.",
      ...this.agentGuidelines,
      "- The child sees none of the main conversation. Put every required fact, path, constraint, and expected output in task.",
      "- Subagent results are returned as text — summarize them for the user.",
      "- Use run_in_background for work you don't need immediately. You will be notified when it completes.",
      "- Resume requires a new self-contained task and uses only that child's own history.",
      "- Use steer_subagent to send mid-run messages to a running background agent.",
      '- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").',
      "- Use thinking to control extended thinking level.",
    ].join("\n");

    return defineTool({
      name: "subagent" as const,
      label: "Subagent",
      promptSnippet: "Launch a specialized agent for complex, multi-step tasks.",
      description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The subagent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
${guidelines}
`,
      parameters: Type.Object({
        task: Type.String({
          description:
            "Required self-contained task. The child sees none of the main conversation, so include every required fact, path, constraint, and expected output.",
          minLength: 1,
          pattern: "\\S",
        }),
        description: Type.Optional(
          Type.String({
            description: "Optional short description for the UI; defaults to the task.",
          }),
        ),
        subagent_type: Type.Optional(
          Type.String({
            description: `The type of specialized agent to use. Required for a new child. Available types: ${availableTypesText}. Custom agents from .pi/agents/<name>.md (project) or ${agentDir}/agents/<name>.md (global) are also available.`,
          }),
        ),
        model: Type.Optional(
          Type.String({
            description:
              'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
          }),
        ),
        thinking: Type.Optional(
          Type.String({
            description:
              "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
          }),
        ),
        stack: Type.Optional(
          Type.String({
            description: "Optional named stack selection for this agent.",
            minLength: 1,
            pattern: "\\S",
          }),
        ),
        max_turns: Type.Optional(
          Type.Integer({
            description: "Maximum agentic turns. Omit for unlimited.",
            minimum: 1,
            maximum: 10000,
          }),
        ),
        grace_turns: Type.Optional(
          Type.Integer({
            description: "Additional turns after the soft limit. Omit for unlimited.",
            minimum: 0,
            maximum: 1000,
          }),
        ),
        run_in_background: Type.Optional(
          Type.Boolean({
            description:
              "Set to true to run in background. Returns agent ID immediately. You will be notified when it completes.",
          }),
        ),
        resume: Type.Optional(
          Type.String({
            description:
              "Optional child agent ID to resume using only its persisted history and the new task.",
            minLength: 1,
            pattern: "\\S",
          }),
        ),
      }),

      // ---- Custom rendering: inline subagent results ----

      renderCall(args: Record<string, unknown>, theme: Theme) {
        const displayName = args.subagent_type
          ? getDisplayName(args.subagent_type as string, registry)
          : "Subagent";
        const desc = (args.description as string | undefined) ?? "";
        return new Text(
          `${GLYPHS.toolCall} ` +
            theme.fg("toolTitle", theme.bold(displayName)) +
            (desc ? "  " + theme.fg("muted", desc) : ""),
          0,
          0,
        );
      },

      renderResult(
        result: AgentToolResult<AgentDetails | undefined>,
        { expanded, isPartial }: ToolRenderResultOptions,
        theme: Theme,
      ) {
        const details = result.details;
        if (!details) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          return new Text(text, 0, 0);
        }
        const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(renderAgentResult(details, resultText, expanded, isPartial, theme), 0, 0);
      },

      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
        ctx: ExtensionContext,
      ) => this.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
}
