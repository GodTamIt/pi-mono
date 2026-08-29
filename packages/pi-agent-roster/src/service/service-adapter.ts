import type { Model } from "@earendil-works/pi-ai";
import type { AgentTypeRegistry } from "../config/agent-types.ts";
import type { ChildRuntimeBaseline } from "../lifecycle/child-runtime-baseline.ts";
import type { WorkspaceProvider } from "../lifecycle/workspace.ts";
import { AgentStackOverrides } from "../stacks/stack-resolver.ts";
import type { AgentInvocation, SessionContext, Subagent } from "../types.ts";
import {
  type ModelInfo,
  resolveInvocationForAgent,
  resolveSpawnConfig,
} from "../tools/spawn-config.ts";
import { describeActivity } from "../ui/display.ts";
import type { ResumeRequest, SpawnRequest, SubagentRecord, SubagentsService } from "./service.ts";

export interface SubagentManagerLike {
  spawn(baseline: ChildRuntimeBaseline, type: string, task: string, options: unknown): string;
  resume(
    id: string,
    task: string,
    signal?: AbortSignal,
    budgets?: { maxTurns?: number | undefined; graceTurns?: number | undefined },
    invocation?: { model: Model<any> | undefined; snapshot: AgentInvocation },
  ): Promise<Subagent | undefined>;
  getRecord(id: string): Subagent | undefined;
  listAgents(): Subagent[];
  abort(id: string): boolean;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
}

export interface ServiceRuntimeLike {
  readonly currentCtx: SessionContext | undefined;
  buildChildBaseline(): ChildRuntimeBaseline;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
  getModelInfo?(): ModelInfo;
}

export interface SubagentsServiceAdapterOptions {
  registry: AgentTypeRegistry;
  stackOverrides?: AgentStackOverrides | undefined;
  refreshRegistry?: (() => void) | undefined;
  authorizeTarget?: ((type: string) => string | undefined) | undefined;
  notify?: ((message: string) => void) | undefined;
  settings?:
    | { readonly defaultMaxTurns: number | undefined; readonly graceTurns?: number | undefined }
    | undefined;
}

export class SubagentsServiceAdapter implements SubagentsService {
  constructor(
    private readonly manager: SubagentManagerLike,
    private readonly runtime: ServiceRuntimeLike,
    private readonly options?: SubagentsServiceAdapterOptions,
  ) {}

  spawn(request: SpawnRequest): string {
    rejectInheritedContext(request);
    if (!this.runtime.currentCtx) throw new Error("No active session — cannot spawn a child.");
    const type = requireText(request.type, "type");
    const task = requireText(request.task, "task");
    const stack = optionalText(request.stack, "stack");
    validateBudget(request.maxTurns, "maxTurns", 1, 10_000);
    validateBudget(request.graceTurns, "graceTurns", 0, 1_000);
    const description = optionalText(request.description, "description") ?? task.slice(0, 80);
    const options = this.requireResolution();
    (options.refreshRegistry ?? (() => options.registry.reload()))();
    const resolved = resolveSpawnConfig(
      {
        subagent_type: type,
        task,
        description,
        stack,
        max_turns: request.maxTurns,
        grace_turns: request.graceTurns,
        run_in_background: !(request.foreground ?? false),
      },
      options.registry,
      this.getModelInfo(),
      options.settings ?? { defaultMaxTurns: undefined },
      { stackOverrides: options.stackOverrides },
    );
    if ("error" in resolved) throw new Error(resolved.error);
    const authorizationError = options.authorizeTarget?.(resolved.identity.subagentType);
    if (authorizationError) throw new Error(authorizationError);
    if (resolved.execution.notice) options.notify?.(resolved.execution.notice);
    const parent = this.runtime.getSessionInfo();
    return this.manager.spawn(
      this.runtime.buildChildBaseline(),
      resolved.identity.subagentType,
      task,
      {
        description,
        model: resolved.execution.model,
        maxTurns: resolved.execution.effectiveMaxTurns,
        graceTurns: resolved.execution.effectiveGraceTurns,
        thinkingLevel: resolved.execution.thinking,
        bypassQueue: request.bypassQueue,
        isBackground: !(request.foreground ?? false),
        parentSession: parent,
        invocation: {
          ...resolved.execution.agentInvocation,
          runInBackground: !(request.foreground ?? false),
        },
      },
    );
  }

  async resume(request: ResumeRequest): Promise<SubagentRecord | undefined> {
    rejectInheritedContext(request);
    const id = requireText(request.id, "id");
    const task = requireText(request.task, "task");
    const stack = optionalText(request.stack, "stack");
    validateBudget(request.maxTurns, "maxTurns", 1, 10_000);
    validateBudget(request.graceTurns, "graceTurns", 0, 1_000);
    const existing = this.manager.getRecord(id);
    if (!existing) return undefined;
    const options = this.requireResolution();
    (options.refreshRegistry ?? (() => options.registry.reload()))();
    const authorizationError = options.authorizeTarget?.(existing.type);
    if (authorizationError) throw new Error(authorizationError);
    const selection = resolveInvocationForAgent(
      existing.type,
      stack ? { stack } : {},
      options.registry,
      this.getModelInfo(),
      { stackOverrides: options.stackOverrides },
    );
    if ("error" in selection) throw new Error(selection.error);
    if (selection.notice) options.notify?.(selection.notice);
    const invocation = {
      model: selection.model,
      snapshot: {
        ...existing.invocation,
        ...selection.invocation,
        maxTurns: request.maxTurns ?? existing.invocation?.maxTurns,
        graceTurns: request.graceTurns ?? existing.invocation?.graceTurns,
      },
    };
    const record = await this.manager.resume(
      id,
      task,
      request.signal,
      { maxTurns: request.maxTurns, graceTurns: request.graceTurns },
      invocation,
    );
    return record ? toSubagentRecord(record) : undefined;
  }

  inspect(id: string): SubagentRecord | undefined {
    const record = this.manager.getRecord(requireText(id, "id"));
    return record ? toSubagentRecord(record) : undefined;
  }

  listAgents(): SubagentRecord[] {
    return this.manager.listAgents().map(toSubagentRecord);
  }

  abort(id: string): boolean {
    return this.manager.abort(requireText(id, "id"));
  }

  async steer(id: string, steering: string): Promise<boolean> {
    const record = this.manager.getRecord(requireText(id, "id"));
    if (!record) return false;
    const outcome = await record.steer(requireText(steering, "steering"));
    return outcome.kind !== "rejected";
  }

  waitForAll(): Promise<void> {
    return this.manager.waitForAll();
  }

  hasRunning(): boolean {
    return this.manager.hasRunning();
  }

  registerWorkspaceProvider(provider: WorkspaceProvider): () => void {
    return this.manager.registerWorkspaceProvider(provider);
  }

  private getModelInfo(): ModelInfo {
    if (!this.runtime.getModelInfo) {
      throw new Error("SubagentsServiceAdapter requires model resolution wiring.");
    }
    return this.runtime.getModelInfo();
  }

  private requireResolution(): SubagentsServiceAdapterOptions {
    if (!this.options) {
      throw new Error(
        "SubagentsServiceAdapter requires registry/model resolution wiring before spawn or stack resume.",
      );
    }
    return this.options;
  }
}

export function toSubagentRecord(record: Subagent): SubagentRecord {
  const out: SubagentRecord = {
    id: record.id,
    parentSessionId: record.parentSessionId,
    type: record.type,
    description: record.description,
    task: record.task,
    status: record.status,
    activity: describeActivity(record.activeTools, record.responseText),
    turnCount: record.turnCount,
    maxTurns: record.maxTurns ?? "unlimited",
    graceTurns: record.graceTurns ?? "unlimited",
    stack: record.invocation?.stack,
    model: record.invocation?.modelName,
    thinking: record.invocation?.thinking,
    toolUses: record.toolUses,
    startedAt: record.startedAt,
    lifetimeUsage: record.lifetimeUsage,
    contextPercent: record.getContextPercent(),
    compactionCount: record.compactionCount,
    conversation: record.getConversation(),
    transcriptPath: record.outputFile,
  };
  if (record.result !== undefined) out.result = record.result;
  if (record.error !== undefined) out.error = record.error;
  if (record.completedAt !== undefined) out.completedAt = record.completedAt;
  return out;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireText(value, name);
}

function rejectInheritedContext(request: object): void {
  const raw = request as Record<string, unknown>;
  if (Object.hasOwn(raw, "inheritContext") || Object.hasOwn(raw, "inherit_context")) {
    throw new Error(
      "inheritContext is unsupported. Children receive no parent conversation; include all required context in task.",
    );
  }
}

function validateBudget(value: unknown, name: string, minimum: number, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}
