/**
 * runtime.ts — SubagentRuntime: composition root for all mutable extension state.
 *
 * Eliminates module-scope state in agent-runner.ts and closure-scoped state
 * in index.ts by consolidating them into a single, testable object.
 * Follows the same pattern as pi-permission-system's ExtensionRuntime.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  buildChildRuntimeBaseline,
  type ChildRuntimeBaseline,
} from "./lifecycle/child-runtime-baseline.ts";
import type { ModelRegistry } from "./session/model-resolver.ts";
import { AgentStackOverrides } from "./stacks/stack-resolver.ts";
import type { ModelInfo } from "./tools/spawn-config.ts";
import type { SessionContext } from "./types.ts";

/**
 * Narrow config subset read by Agent when driving the turn loop (defaultMaxTurns, graceTurns).
 * Kept separate so callers can satisfy it without depending on the full runtime.
 */
export interface RunConfig {
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number | undefined;
}

/**
 * All mutable state owned by the pi-agent-roster extension.
 *
 * Created once inside `piSubagentsExtension()` via `createSubagentRuntime()`.
 * Tests construct a fresh runtime per test for full isolation.
 */
export class SubagentRuntime {
  constructor(readonly stackOverrides: AgentStackOverrides = new AgentStackOverrides()) {}

  // ── Session state (was closure-scoped in index.ts) ───────────────────────
  /** Active Pi session context — set on session_start, cleared on session_shutdown. */
  currentCtx: SessionContext | undefined = undefined;

  // ── Session-context methods ──────────────────────────────────────────────

  /** Store the active Pi session context (called from session_start). */
  setSessionContext(ctx: SessionContext): void {
    this.currentCtx = ctx;
  }

  /** Clear the session context (called from session_shutdown). */
  clearSessionContext(): void {
    this.currentCtx = undefined;
  }

  /** Build the content-free runtime baseline for a new child. */
  buildChildBaseline(): ChildRuntimeBaseline {
    if (!this.currentCtx) throw new Error("No active session");
    return buildChildRuntimeBaseline(this.currentCtx);
  }

  getModelRegistry(): ModelRegistry {
    if (!this.currentCtx) throw new Error("No active session");
    return this.currentCtx.modelRegistry;
  }

  getDefaultModel(): Model<any> | undefined {
    return this.currentCtx?.model;
  }

  /** Extract model info from the current session context. */
  getModelInfo(): ModelInfo {
    return {
      parentModel: this.currentCtx?.model,
      modelRegistry: this.currentCtx?.modelRegistry,
    };
  }

  /** Extract session identity from the current session context. */
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string } {
    return {
      parentSessionFile: this.currentCtx?.sessionManager.getSessionFile() ?? "",
      parentSessionId: this.currentCtx?.sessionManager.getSessionId() ?? "",
    };
  }
}

/**
 * Create a fully-initialized SubagentRuntime with default values.
 *
 * Call once at extension startup; pass the result to factories and handlers.
 */
export function createSubagentRuntime(stackOverrides?: AgentStackOverrides): SubagentRuntime {
  return new SubagentRuntime(stackOverrides);
}
