import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { SubagentStatus } from "../lifecycle/subagent.ts";
import type { LifetimeUsage } from "../lifecycle/usage.ts";
import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "../lifecycle/workspace.ts";

export type { SubagentStatus } from "../lifecycle/subagent.ts";
export type {
  LifetimeUsage,
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
};

export interface SubagentRecord {
  id: string;
  parentSessionId?: string | undefined;
  type: string;
  description: string;
  task: string;
  status: SubagentStatus;
  activity: string;
  turnCount: number;
  maxTurns: number | "unlimited";
  graceTurns: number | "unlimited";
  stack?: string | undefined;
  model?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  result?: string | undefined;
  error?: string | undefined;
  toolUses: number;
  startedAt: number;
  completedAt?: number | undefined;
  lifetimeUsage: LifetimeUsage;
  contextPercent: number | null;
  compactionCount: number;
  conversation?: string | undefined;
  transcriptPath?: string | undefined;
}

export interface SpawnRequest {
  type: string;
  task: string;
  description?: string | undefined;
  stack?: string | undefined;
  maxTurns?: number | undefined;
  graceTurns?: number | undefined;
  foreground?: boolean | undefined;
  bypassQueue?: boolean | undefined;
}

export interface ResumeRequest {
  id: string;
  task: string;
  stack?: string | undefined;
  maxTurns?: number | undefined;
  graceTurns?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface SubagentsService {
  spawn(request: SpawnRequest): string;
  resume(request: ResumeRequest): Promise<SubagentRecord | undefined>;
  inspect(id: string): SubagentRecord | undefined;
  listAgents(): SubagentRecord[];
  abort(id: string): boolean;
  steer(id: string, steering: string): Promise<boolean>;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
}

export const SUBAGENT_EVENTS = {
  STARTED: "subagents:started",
  COMPLETED: "subagents:completed",
  FAILED: "subagents:failed",
  RESUMED: "subagents:resumed",
  COMPACTED: "subagents:compacted",
  CREATED: "subagents:created",
  STEERED: "subagents:steered",
} as const;

const SERVICE_KEY = Symbol.for("pi-agent-roster:service");

export function publishSubagentsService(service: SubagentsService): () => void {
  const services = globalThis as Record<symbol, unknown>;
  services[SERVICE_KEY] = service;
  return () => {
    if (services[SERVICE_KEY] === service) delete services[SERVICE_KEY];
  };
}

export function getSubagentsService(): SubagentsService | undefined {
  return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as SubagentsService | undefined;
}

export function unpublishSubagentsService(): void {
  delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
}
