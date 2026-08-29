/**
 * Pure selection and transcript sourcing for `/subagents:sessions`.
 */

import {
  buildSessionContext,
  parseSessionEntries,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "../config/agent-types.ts";
import { isRunningStatus, type SubagentStatus } from "../lifecycle/subagent-state.ts";
import type { AgentSessionEvent, SessionMessage, SubagentType } from "../types.ts";
import { formatDuration, getDisplayName } from "./display.ts";

export interface NavigableSubagent {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  readonly agentMessages: readonly SessionMessage[];
  readonly outputFile: string | undefined;
  isSessionReady(): boolean;
  subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

export interface NavigationIdentity {
  /** Picker value. It is deliberately independent of every rendered field. */
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly duration: string;
  readonly toolUses: number;
  readonly sourceLabel: "live session" | "released snapshot";
}

export type NavigationEntry = NavigationIdentity &
  (
    | { readonly kind: "live"; readonly record: NavigableSubagent }
    | { readonly kind: "snapshot"; readonly outputFile: string }
  );

export interface StreamingState {
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
}

/** A child-owned transcript source. It has no path back into the parent session. */
export interface TranscriptSource {
  getMessages(): readonly SessionMessage[];
  subscribe(onChange: (event?: AgentSessionEvent) => void): (() => void) | undefined;
  streaming(): StreamingState | undefined;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

export function listNavigableAgents(
  agents: readonly NavigableSubagent[],
  registry: AgentConfigLookup,
): NavigationEntry[] {
  const live: NavigationEntry[] = [];
  const snapshots: NavigationEntry[] = [];
  for (const record of agents) {
    const identity = buildIdentity(record, registry);
    if (record.isSessionReady()) {
      live.push({
        ...identity,
        key: `live:${record.id}`,
        kind: "live",
        record,
        sourceLabel: "live session",
      });
    } else if (record.outputFile) {
      snapshots.push({
        ...identity,
        key: `snapshot:${record.id}`,
        kind: "snapshot",
        outputFile: record.outputFile,
        sourceLabel: "released snapshot",
      });
    }
  }
  return [...live, ...snapshots];
}

export function fileSnapshotSource(
  outputFile: string,
  readFile: (path: string) => string,
): TranscriptSource {
  const entries = parseSessionEntries(readFile(outputFile));
  const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  const { messages } = buildSessionContext(sessionEntries);
  return {
    getMessages: () => messages,
    subscribe: () => undefined,
    streaming: () => undefined,
    getToolDefinition: () => undefined,
  };
}

export function liveSource(record: NavigableSubagent): TranscriptSource {
  return {
    getMessages: () => record.agentMessages,
    subscribe: (onChange) => record.subscribeToUpdates(onChange),
    streaming: () =>
      isRunningStatus(record.status)
        ? { activeTools: record.activeTools, responseText: record.responseText }
        : undefined,
    getToolDefinition: (name) => record.getToolDefinition(name),
  };
}

function buildIdentity(
  record: NavigableSubagent,
  registry: AgentConfigLookup,
): Omit<NavigationIdentity, "key" | "sourceLabel"> {
  return {
    id: record.id,
    name: getDisplayName(record.type, registry),
    description: record.description,
    status: record.status,
    duration: formatDuration(record.startedAt, record.completedAt),
    toolUses: record.toolUses,
  };
}
