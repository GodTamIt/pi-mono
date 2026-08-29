/**
 * types.ts — Type definitions for the subagent system.
 */

import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  SessionContext as SdkSessionContext,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "./session/model-resolver.ts";

export type { SteerOutcome } from "./lifecycle/subagent.ts";
export { Subagent } from "./lifecycle/subagent.ts";
export type { AgentSessionEvent, ThinkingLevel };

/**
 * One message in a child session's history, typed from Pi's `SessionContext`.
 *
 * Derived from the barrel-exported `SessionContext` (whose `messages` field is
 * `AgentMessage[]`) so the package needs no direct dependency on
 * `@earendil-works/pi-agent-core`, which is not re-exported from the public barrel.
 */
export type SessionMessage = SdkSessionContext["messages"][number];

/**
 * Narrow session interface for event subscription.
 * Used by record-observer — only the subscribe method is needed.
 */
export interface SubscribableSession {
  subscribe(fn: (event: AgentSessionEvent) => void): () => void;
}

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

export type AgentMode = "primary" | "subagent" | "all";

export interface AgentStackProfile {
  model: string;
  thinking?: ThinkingLevel | undefined;
}

export interface AgentDiagnostic {
  path: string;
  message: string;
  source: "project" | "global";
}

/** UI display and agent listing — name, display name, description, prompt mode. */
export interface AgentIdentity {
  name: string;
  displayName?: string | undefined;
  description: string;
  promptMode: "replace" | "append";
}

/** Prompt assembly — name, prompt mode, system prompt. */
export interface AgentPromptConfig {
  name: string;
  promptMode: "replace" | "append";
  systemPrompt: string;
}

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig extends AgentIdentity, AgentPromptConfig {
  /** Stable, case-insensitive identity derived from the Markdown filename. */
  id?: string | undefined;
  mode?: AgentMode | undefined;
  /** Agent identities this primary may delegate to. Omission means unrestricted. */
  allowedAgents?: string[] | undefined;
  stacks?: ReadonlyMap<string, AgentStackProfile> | undefined;
  defaultStack?: string | undefined;
  /** The agent's tool allowlist. Entries name built-in or extension-registered tools; omitted means every built-in. */
  toolNames?: string[] | undefined;
  model?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  maxTurns?: number | undefined;
  graceTurns?: number | undefined;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean | undefined;
  /** One-line usage guideline for the subagent tool's Guidelines: block. Omitted — no guideline line. */
  toolGuideline?: string | undefined;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean | undefined;
  /** false = agent is hidden from the registry */
  enabled?: boolean | undefined;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global" | undefined;
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  maxTurns?: number | undefined;
  graceTurns?: number | undefined;
  stack?: string | undefined;
  runInBackground?: boolean | undefined;
}

/**
 * Narrow shell-exec callback replacing `ExtensionAPI` in `detectEnv()`.
 * Matches the shape of `pi.exec()` without carrying an SDK dependency.
 */
/**
 * Narrow interface capturing the ExtensionContext fields SubagentRuntime needs.
 * Avoids coupling runtime to the full SDK ExtensionContext surface (ISP).
 */
export interface SessionContext {
  readonly cwd: string;
  readonly model: Model<any> | undefined;
  readonly modelRegistry: ModelRegistry;
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
}

/**
 * Narrow shell-exec callback replacing `ExtensionAPI` in `detectEnv()`.
 * Matches the shape of `pi.exec()` without carrying an SDK dependency.
 */
export type ShellExec = (
  command: string,
  args: string[],
  options?: { cwd?: string | undefined; timeout?: number } | undefined,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Parent session identity — grouped fields that travel together from the tool boundary. */
export interface ParentSessionInfo {
  /** Path to the parent session's JSONL file (for deriving the subagent session directory). */
  parentSessionFile?: string | undefined;
  /** Session ID of the parent agent (stored in the child session's parentSession header). */
  parentSessionId?: string | undefined;
  /** Tool call ID for background notification wiring. Exposed on the record via Subagent.toolCallId. */
  toolCallId?: string | undefined;
}

/** Compaction event info passed through lifecycle observers. */
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };
