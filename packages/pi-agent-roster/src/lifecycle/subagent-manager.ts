/**
 * subagent-manager.ts - Tracks subagents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are scheduled on a ConcurrencyLimiter and auto-started as running
 * agents complete. Foreground agents bypass the limiter (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { debugLog } from "../debug.ts";
import type { RunConfig } from "../runtime.ts";
import type { ModelRegistry } from "../session/model-resolver.ts";
import type {
  AgentInvocation,
  CompactionInfo,
  ParentSessionInfo,
  SubagentType,
  ThinkingLevel,
} from "../types.ts";
import { type ChildRuntimeBaseline, modelIdentity } from "./child-runtime-baseline.ts";
import type { ConcurrencyLimiter } from "./concurrency-limiter.ts";
import type { CreateSubagentSessionParams } from "./create-subagent-session.ts";
import {
  type AdmittedSubagentRuntime,
  Subagent,
  type SubagentLifecycleObserver,
} from "./subagent.ts";
import type { SubagentSession } from "./subagent-session.ts";
import { SubagentState } from "./subagent-state.ts";
import type { WorkspaceProvider } from "./workspace.ts";

/**
 * Session-retention windows (minutes). `SettingsManager` satisfies this
 * structurally; a live getter (`getRetentionPolicy`) lets the sweep read the
 * current values without a construction-time settings dependency.
 */
export interface RetentionPolicy {
  readonly consumedSessionRetentionMinutes: number;
  readonly unconsumedSessionRetentionMinutes: number;
}

const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  consumedSessionRetentionMinutes: 10,
  unconsumedSessionRetentionMinutes: 720,
};

const EMPTY_MODEL_REGISTRY: ModelRegistry = {
  find: () => undefined,
  getAll: () => [],
};

/** Observer interface for agent lifecycle notifications. */
export interface SubagentManagerObserver {
  onSubagentStarted(record: Subagent): void;
  onSubagentCompleted(record: Subagent): void;
  /** Fires when a resumed run reaches a terminal state (distinct from a fresh completion). */
  onSubagentResumed(record: Subagent): void;
  onSubagentCompacted(record: Subagent, info: CompactionInfo): void;
  /** Fires synchronously after a background agent record is created (before run). */
  onSubagentCreated(record: Subagent): void;
}

export interface SubagentManagerOptions {
  /** Assembly factory that produces a born-complete SubagentSession per spawn. */
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  /** Concurrency limiter — schedules background run thunks FIFO against the limit. */
  limiter: ConcurrencyLimiter;
  /** Base working directory handed to a workspace provider (the parent cwd). */
  baseCwd: string;
  /** Live SDK model values, read only after admission. */
  getModelRegistry?: (() => ModelRegistry) | undefined;
  getDefaultModel?: (() => Model<any> | undefined) | undefined;
  getRunConfig?: (() => RunConfig) | undefined;
  /** Live accessor for the session-retention windows; defaults applied when absent. */
  getRetentionPolicy?: (() => RetentionPolicy) | undefined;
  observer?: SubagentManagerObserver | undefined;
}

export interface AgentSpawnConfig {
  description: string;
  model?: Model<any> | undefined;
  maxTurns?: number | undefined;
  graceTurns?: number | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  isBackground?: boolean | undefined;
  /**
   * Skip the maxConcurrent queue check for this spawn - start immediately even
   * if the configured concurrency limit would otherwise queue it. Useful for
   * callers (e.g. cross-extension RPC) that must not be deferred by the queue.
   */
  bypassQueue?: boolean | undefined;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation | undefined;
  /** Parent abort signal - when aborted, the subagent is also stopped. */
  signal?: AbortSignal | undefined;
  /** Per-subagent lifecycle observer — replaces onSessionCreated callback. */
  observer?: SubagentLifecycleObserver | undefined;
  /** Parent session identity - grouped fields that travel together from the tool boundary. */
  parentSession?: ParentSessionInfo | undefined;
}

export class SubagentManager {
  private agents = new Map<string, Subagent>();
  private sweepInterval: ReturnType<typeof setInterval>;
  private readonly observer?: SubagentManagerObserver | undefined;
  private readonly createSubagentSession: (
    params: CreateSubagentSessionParams,
  ) => Promise<SubagentSession>;
  private readonly limiter: ConcurrencyLimiter;
  private readonly baseCwd: string;
  private readonly getModelRegistry?: (() => ModelRegistry) | undefined;
  private readonly getDefaultModel?: (() => Model<any> | undefined) | undefined;
  private getRunConfig: (() => RunConfig) | undefined;
  private getRetentionPolicy: (() => RetentionPolicy) | undefined;
  private _workspaceProvider?: WorkspaceProvider | undefined;

  /** The registered workspace provider, or undefined when none is registered. */
  get workspaceProvider(): WorkspaceProvider | undefined {
    return this._workspaceProvider;
  }

  constructor(options: SubagentManagerOptions) {
    this.createSubagentSession = options.createSubagentSession;
    this.limiter = options.limiter;
    this.baseCwd = options.baseCwd;
    this.getModelRegistry = options.getModelRegistry;
    this.getDefaultModel = options.getDefaultModel;
    this.observer = options.observer;
    this.getRunConfig = options.getRunConfig;
    this.getRetentionPolicy = options.getRetentionPolicy;
    // Periodically release the heavy session of terminal agents past their
    // retention window. The lightweight record (with its result) is kept for the
    // session lifetime, so get_subagent_result never misses in-session.
    this.sweepInterval = setInterval(() => this.sweep(), 60_000);
    this.sweepInterval.unref();
  }

  /**
   * Register the single workspace provider. Throws if one is already
   * registered (chaining is out of scope — see ADR 0002). Returns a disposer
   * that clears the slot only if this provider is still the active one.
   */
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void {
    if (this._workspaceProvider) {
      throw new Error("A WorkspaceProvider is already registered; only one is supported.");
    }
    this._workspaceProvider = provider;
    return () => {
      if (this._workspaceProvider === provider) this._workspaceProvider = undefined;
    };
  }

  /** Compose a per-agent lifecycle observer from manager and spawn-config concerns. */
  private buildObserver(
    isBackground: boolean,
    foregroundObserver?: SubagentLifecycleObserver,
  ): SubagentLifecycleObserver {
    return {
      onStarted: (agent) => {
        this.observer?.onSubagentStarted(agent);
      },
      ...(foregroundObserver?.onSessionCreated
        ? { onSessionCreated: (agent: Subagent) => foregroundObserver.onSessionCreated?.(agent) }
        : {}),
      onRunFinished: (agent) => {
        if (isBackground) {
          try {
            this.observer?.onSubagentCompleted(agent);
          } catch (err) {
            debugLog("onSubagentCompleted observer", err);
          }
        }
      },
      onResumeFinished: (agent) => {
        if (isBackground) {
          try {
            this.observer?.onSubagentResumed(agent);
          } catch (err) {
            debugLog("onSubagentResumed observer", err);
          }
        }
      },
      onCompacted: (agent, info) => {
        this.observer?.onSubagentCompacted(agent, info);
      },
    };
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    baseline: ChildRuntimeBaseline,
    type: SubagentType,
    task: string,
    options: AgentSpawnConfig,
  ): string {
    const id = randomUUID().slice(0, 17);
    const record = new Subagent({
      id,
      type,
      description: options.description,
      invocation: options.invocation ? { ...options.invocation } : undefined,
      state: new SubagentState({
        status: options.isBackground ? "queued" : "running",
        startedAt: Date.now(),
      }),
      execution: {
        baseline: {
          cwd: baseline.cwd,
          model: baseline.model && { ...baseline.model },
        },
        task,
        baseCwd: this.baseCwd,
        model: modelIdentity(options.model),
        maxTurns: options.maxTurns,
        graceTurns: options.graceTurns,
        thinkingLevel: options.thinkingLevel,
        parentSession: options.parentSession
          ? {
              parentSessionFile: options.parentSession.parentSessionFile,
              parentSessionId: options.parentSession.parentSessionId,
              toolCallId: options.parentSession.toolCallId,
            }
          : undefined,
        isBackground: options.isBackground === true,
      },
    });
    this.agents.set(id, record);

    if (options.isBackground) {
      this.observer?.onSubagentCreated(record);
    }

    if (options.isBackground && !options.bypassQueue) {
      record.setQueuedPromise(this.limiter.schedule(id));
      this.runAdmissions();
      return id;
    }

    record.start(this.buildAdmittedRuntime(record, options.signal, options.observer));
    return id;
  }

  private buildAdmittedRuntime(
    record: Subagent,
    signal?: AbortSignal,
    foregroundObserver?: SubagentLifecycleObserver,
  ): AdmittedSubagentRuntime {
    const modelRegistry = this.getModelRegistry?.() ?? EMPTY_MODEL_REGISTRY;
    const defaultIdentity = record.execution.baseline.model;
    const selectedIdentity = record.execution.model;
    return {
      createSubagentSession: this.createSubagentSession,
      modelRegistry,
      defaultModel: defaultIdentity
        ? modelRegistry.find(defaultIdentity.provider, defaultIdentity.id)
        : this.getDefaultModel?.(),
      model: selectedIdentity
        ? modelRegistry.find(selectedIdentity.provider, selectedIdentity.id)
        : undefined,
      observer: this.buildObserver(record.execution.isBackground, foregroundObserver),
      runConfig: this.getRunConfig?.(),
      workspaceProvider: this._workspaceProvider,
      signal,
    };
  }

  /** Single manager-level runner for every limiter admission. */
  private runAdmissions(): void {
    for (const id of this.limiter.admit()) void this.runAdmitted(id);
  }

  private async runAdmitted(id: string): Promise<void> {
    const record = this.agents.get(id);
    try {
      if (record?.status === "queued") {
        record.admit(this.buildAdmittedRuntime(record));
        await record.run();
      }
      this.limiter.settle(id);
    } catch (err) {
      this.limiter.settle(id, err);
    } finally {
      this.runAdmissions();
    }
  }

  /** Re-read the dynamic limit and admit any newly available IDs. */
  recheckAdmissions(): void {
    this.runAdmissions();
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    baseline: ChildRuntimeBaseline,
    type: SubagentType,
    task: string,
    options: Omit<AgentSpawnConfig, "isBackground">,
  ): Promise<Subagent> {
    const id = this.spawn(baseline, type, task, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   * Delegates to Subagent.resume(), which owns the observer subscription lifecycle.
   */
  async resume(
    id: string,
    task: string,
    signal?: AbortSignal | undefined,
    budgets?: { maxTurns?: number | undefined; graceTurns?: number | undefined },
  ): Promise<Subagent | undefined> {
    const agent = this.agents.get(id);
    if (!agent || agent.isActive() || (!agent.isSessionReady() && !agent.sessionReleased)) {
      return undefined;
    }
    await agent.resume(task, signal, budgets);
    return agent;
  }

  getRecord(id: string): Subagent | undefined {
    return this.agents.get(id);
  }

  listAgents(): Subagent[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // A queued agent has not started; stop it through the same terminal funnel
    // a running agent's stop uses. Its scheduled thunk becomes a no-op (status
    // guard) when its slot finally opens.
    if (record.status === "queued") {
      record.stopQueued();
      this.limiter.cancel(id);
      this.notifyQueuedStopped(record);
      this.runAdmissions();
      return true;
    }

    return record.abort();
  }

  /**
   * Remove a record from the map and tear its session down.
   * The map is updated first so the record is unreachable while its child's
   * extensions shut down.
   */
  private removeRecord(id: string, record: Subagent): Promise<void> {
    this.agents.delete(id);
    return record.disposeSession();
  }

  /**
   * Release the heavy session of any terminal agent past its retention window.
   * The record (with its result) is retained for the session lifetime; only the
   * live `AgentSession` is freed. A consumed agent releases on the short window,
   * measured from the later of completion or consumption (so a late read still
   * gets a full resume window); an unconsumed agent holds until the long cap.
   */
  private sweep() {
    const policy = this.getRetentionPolicy?.() ?? DEFAULT_RETENTION_POLICY;
    const now = Date.now();
    for (const record of this.agents.values()) {
      if (record.isActive()) continue;
      if (!record.isSessionReady()) continue; // already released, or never had a session
      const referenceAt = record.consumed
        ? Math.max(record.completedAt ?? 0, record.consumedAt ?? 0)
        : (record.completedAt ?? 0);
      const windowMinutes = record.consumed
        ? policy.consumedSessionRetentionMinutes
        : policy.unconsumedSessionRetentionMinutes;
      // Fire-and-forget: the sweep runs on an interval with no one to await it,
      // and Subagent.releaseSession() already swallows a failing teardown.
      if (now - referenceAt >= windowMinutes * 60_000) void record.releaseSession();
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  async clearCompleted(): Promise<void> {
    const teardowns: Promise<void>[] = [];
    for (const [id, record] of this.agents) {
      if (record.isActive()) continue;
      teardowns.push(this.removeRecord(id, record));
    }
    await Promise.all(teardowns);
  }

  /** Whether any agents are still running or queued. */
  // fallow-ignore-next-line unused-class-member
  hasRunning(): boolean {
    return [...this.agents.values()].some((r) => r.isActive());
  }

  private notifyQueuedStopped(record: Subagent): void {
    try {
      this.observer?.onSubagentCompleted(record);
    } catch (err) {
      debugLog("onSubagentCompleted observer", err);
    }
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (record.status === "queued") {
        record.stopQueued();
        this.limiter.cancel(record.id);
        this.notifyQueuedStopped(record);
        count++;
      } else if (record.abort()) {
        count++;
      }
    }
    // Drop pending thunks (their promises resolve).
    this.limiter.clear();
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  // fallow-ignore-next-line unused-class-member
  async waitForAll(): Promise<void> {
    // Every spawned agent has a settled-on-completion promise (the limiter starts
    // queued ones as slots free), so a single allSettled covers the queued case.
    // The loop only catches agents spawned during the wait.
    let pending = this.pendingPromises();
    while (pending.length > 0) {
      await Promise.allSettled(pending);
      pending = this.pendingPromises();
    }
  }

  /** Promises of all running/queued agents that have one. */
  private pendingPromises(): Promise<void>[] {
    return [...this.agents.values()]
      .filter((r) => r.isActive())
      .map((r) => r.promise)
      .filter((p): p is Promise<void> => p != null);
  }

  /**
   * Tear down every record, resolving once each child's extensions have shut
   * down. The registry is emptied before the teardowns are awaited, so nothing
   * can reach a dying record; `allSettled` keeps one failing child from
   * abandoning its siblings.
   */
  async dispose(): Promise<void> {
    clearInterval(this.sweepInterval);
    // Drop pending thunks
    this.limiter.clear();
    const teardowns = [...this.agents.values()].map((record) => record.disposeSession());
    this.agents.clear();
    await Promise.allSettled(teardowns);
  }
}
