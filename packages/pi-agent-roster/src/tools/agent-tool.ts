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
import type { AgentStackOverrides } from "../stacks/stack-resolver.ts";
import type { ParentSessionInfo, Subagent } from "../types.ts";
import type { AgentDetails, Theme } from "../ui/display.ts";
import { spawnBackground } from "./background-spawner.ts";
import { runForeground } from "./foreground-runner.ts";
import { buildAgentGuidelines, buildTypeListText, textResult } from "./helpers.ts";
import {
  type InvocationRowRegistry,
  type InvocationRowRenderContext,
  renderInvocationRow,
} from "./invocation-row.ts";
import {
  type ModelInfo,
  resolveInvocationForAgent,
  resolveResumeConfig,
  resolveSpawnConfig,
} from "./spawn-config.ts";

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
    invocation?: {
      model: import("@earendil-works/pi-ai").Model<any> | undefined;
      snapshot: import("../types.ts").AgentInvocation;
    },
  ) => Promise<Subagent | undefined>;
  getRecord: (id: string) => Subagent | undefined;
}

/** Narrow runtime interface — the Agent tool's slice of SubagentRuntime. */
export interface AgentToolRuntime {
  readonly stackOverrides?: AgentStackOverrides | undefined;
  buildChildBaseline(): ChildRuntimeBaseline;
  getModelInfo(): ModelInfo;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

export interface AgentToolOptions {
  /** Reconcile discovery-dependent state immediately before delegation. */
  refreshRegistry?: (() => void) | undefined;
  stackOverrides?: AgentStackOverrides | undefined;
  authorizeTarget?: ((type: string) => string | undefined) | undefined;
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
    private readonly options: AgentToolOptions = {},
    private readonly invocationRows?: InvocationRowRegistry | undefined,
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
    ctx: ExtensionContext,
  ) {
    // Revalidate discovery/auth immediately before any work can enter the queue.
    (this.options.refreshRegistry ?? (() => this.registry.reload()))();

    // ---- Resume existing agent ----
    if (params.resume !== undefined) {
      const config = resolveResumeConfig(params);
      if ("error" in config) return textResult(config.error);
      const resumeId = typeof params.resume === "string" ? params.resume.trim() : "";
      if (!resumeId) return textResult("resume must be a non-empty string");
      const existing = this.manager.getRecord(resumeId);
      if (!existing) {
        return textResult(
          `Agent not found: "${resumeId}". Records are cleared at session start/switch, so it may be from a previous session.`,
        );
      }
      const authorizationError = this.options.authorizeTarget?.(existing.type);
      if (authorizationError) return textResult(authorizationError);
      if (existing.isActive())
        return textResult(`Agent "${resumeId}" is still running and cannot be resumed.`);
      if (!existing.isSessionReady() && !existing.sessionReleased) {
        return textResult(`Agent "${resumeId}" has no child transcript to resume.`);
      }
      const stackOverrides = this.options.stackOverrides ?? this.runtime.stackOverrides;
      const selection = resolveInvocationForAgent(
        existing.type,
        {
          ...(config.stack ? { stack: config.stack } : {}),
          ...(config.model ? { model: config.model } : {}),
          ...(config.thinking ? { thinking: config.thinking } : {}),
        },
        this.registry,
        this.runtime.getModelInfo(),
        { stackOverrides },
      );
      if ("error" in selection) return textResult(selection.error);
      if (selection.notice) ctx.ui.notify(selection.notice, "warning");
      const record = await this.manager.resume(
        resumeId,
        config.task,
        signal ?? new AbortController().signal,
        {
          maxTurns: config.maxTurns,
          graceTurns: config.graceTurns,
        },
        {
          model: selection.model,
          snapshot: {
            ...existing.invocation,
            ...selection.invocation,
            maxTurns: config.maxTurns ?? existing.invocation?.maxTurns,
            graceTurns: config.graceTurns ?? existing.invocation?.graceTurns,
          },
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
      { stackOverrides: this.options.stackOverrides ?? this.runtime.stackOverrides },
    );
    if ("error" in config) return textResult(config.error);
    const authorizationError = this.options.authorizeTarget?.(config.identity.subagentType);
    if (authorizationError) return textResult(authorizationError);
    if (config.execution.notice) ctx.ui.notify(config.execution.notice, "warning");

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
    const invocationRows = this.invocationRows;
    const getRecord = (id: string) => this.manager.getRecord(id);

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
              "Thinking level: minimal, low, medium, high, xhigh, or max. Overrides agent default.",
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

      // The result renderer owns the complete logical row; the call slot stays empty.
      renderShell: "self",
      renderCall() {
        return new Text("", 0, 0);
      },

      renderResult(
        result: AgentToolResult<AgentDetails | undefined>,
        _options: ToolRenderResultOptions,
        theme: Theme,
        context: InvocationRowRenderContext,
      ) {
        const details = result.details;
        if (!details) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          return new Text(text, 0, 0);
        }
        const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
        return renderInvocationRow(details, resultText, theme, context, invocationRows, getRecord);
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
