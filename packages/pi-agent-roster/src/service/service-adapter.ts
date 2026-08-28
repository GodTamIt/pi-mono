import type { ChildRuntimeBaseline } from "../lifecycle/child-runtime-baseline.ts";
import type { WorkspaceProvider } from "../lifecycle/workspace.ts";
import type { SessionContext, Subagent } from "../types.ts";
import { describeActivity } from "../ui/display.ts";
import type { ResumeRequest, SpawnRequest, SubagentRecord, SubagentsService } from "./service.ts";

export interface SubagentManagerLike {
  spawn(baseline: ChildRuntimeBaseline, type: string, task: string, options: unknown): string;
  resume(
    id: string,
    task: string,
    signal?: AbortSignal,
    budgets?: { maxTurns?: number | undefined; graceTurns?: number | undefined },
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
}

export class SubagentsServiceAdapter implements SubagentsService {
  constructor(
    private readonly manager: SubagentManagerLike,
    private readonly runtime: ServiceRuntimeLike,
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
    const parent = this.runtime.getSessionInfo();
    return this.manager.spawn(this.runtime.buildChildBaseline(), type, task, {
      description,
      maxTurns: request.maxTurns,
      graceTurns: request.graceTurns,
      bypassQueue: request.bypassQueue,
      isBackground: !(request.foreground ?? false),
      parentSession: parent,
      invocation: {
        stack,
        maxTurns: request.maxTurns,
        graceTurns: request.graceTurns,
        runInBackground: !(request.foreground ?? false),
      },
    });
  }

  async resume(request: ResumeRequest): Promise<SubagentRecord | undefined> {
    rejectInheritedContext(request);
    const id = requireText(request.id, "id");
    const task = requireText(request.task, "task");
    if (optionalText(request.stack, "stack") !== undefined) {
      throw new Error("stack selection is unavailable when resuming an existing child.");
    }
    validateBudget(request.maxTurns, "maxTurns", 1, 10_000);
    validateBudget(request.graceTurns, "graceTurns", 0, 1_000);
    const record = await this.manager.resume(id, task, request.signal, {
      maxTurns: request.maxTurns,
      graceTurns: request.graceTurns,
    });
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
