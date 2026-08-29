/**
 * subagent.ts — Subagent class: identity, lifecycle status, and per-subagent behavior.
 *
 * Status/stats are delegated to the SubagentState value object; listener
 * lifecycle to RunListeners; workspace prepare/dispose to WorkspaceBracket.
 * Behavior (abort, steer buffering) lives here rather than on SubagentManager.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { debugLog } from "../debug.ts";
import { subscribeSubagentObserver } from "../observation/record-observer.ts";
import type { RunConfig } from "../runtime.ts";
import type { ModelRegistry } from "../session/model-resolver.ts";
import type {
  AgentInvocation,
  CompactionInfo,
  ParentSessionInfo,
  SessionMessage,
  SubagentType,
  ThinkingLevel,
} from "../types.ts";
import type { ChildModelIdentity, ChildRuntimeBaseline } from "./child-runtime-baseline.ts";
import type { CreateSubagentSessionParams } from "./create-subagent-session.ts";
import { RunListeners } from "./run-listeners.ts";
import type { SubagentSession, TurnLoopResult } from "./subagent-session.ts";
import { SubagentState, type SubagentStatus } from "./subagent-state.ts";
import type { LifetimeUsage } from "./usage.ts";
import type { WorkspaceProvider } from "./workspace.ts";
import { WorkspaceBracket } from "./workspace-bracket.ts";

/** Per-subagent lifecycle observer — created by SubagentManager for each spawn. */
export interface SubagentLifecycleObserver {
  /** Fires when the subagent transitions to running (inside run(), after markRunning). */
  onStarted?(agent: Subagent): void;
  /** Fires once the session is created — the subagent's subagentSession is now available. */
  onSessionCreated?(agent: Subagent): void;
  /** Fires once when the run completes or fails (for concurrency drain). */
  onRunFinished?(agent: Subagent): void;
  /** Fires once when a resumed run reaches a terminal state. */
  onResumeFinished?(agent: Subagent): void;
  /** Fires on compaction events during the run. */
  onCompacted?(agent: Subagent, info: CompactionInfo): void;
}

export type { SubagentStatus } from "./subagent-state.ts";

/**
 * The result of a steer attempt. `Subagent.steer` owns the non-running
 * rejection rule and reports it here, so coordinators switch on the outcome
 * instead of pre-checking status (tell by id, with outcomes).
 */
export type SteerOutcome =
  | { kind: "delivered" }
  | { kind: "buffered" }
  | { kind: "rejected"; status: SubagentStatus };

/**
 * The execution machinery a Subagent needs to run. A single mandatory
 * collaborator: production (SubagentManager.spawn) always supplies it, so run()
 * needs no "not configured" guards. The genuinely-optional behavior knobs stay
 * optional; the four inputs run() cannot proceed without are required.
 */
export interface SubagentExecution {
  readonly baseline: ChildRuntimeBaseline;
  readonly task: string;
  readonly baseCwd: string;
  model?: ChildModelIdentity | undefined;
  maxTurns?: number | undefined;
  graceTurns?: number | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  readonly parentSession?: ParentSessionInfo | undefined;
  isBackground: boolean;
}

/** Live collaborators attached only once the manager admits the child. */
export interface AdmittedSubagentRuntime {
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  modelRegistry: ModelRegistry;
  defaultModel?: Model<any> | undefined;
  model?: Model<any> | undefined;
  observer?: SubagentLifecycleObserver | undefined;
  runConfig?: RunConfig | undefined;
  workspaceProvider?: WorkspaceProvider | undefined;
  signal?: AbortSignal | undefined;
}

export interface SubagentInit {
  // Identity
  id: string;
  type: SubagentType;
  description: string;
  invocation?: AgentInvocation | undefined;

  /** Execution machinery — always supplied; construct-complete, no test fallbacks. */
  execution: SubagentExecution;

  /** Lifecycle status and metrics. Defaults to a fresh queued state. */
  state?: SubagentState | undefined;
}

export class Subagent {
  // Identity — set once at construction
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  invocation?: AgentInvocation | undefined;

  // Lifecycle status and metrics — owned by a private value object; getters and
  // mutation methods below delegate to it one line.
  private readonly state: SubagentState;
  get status(): SubagentStatus {
    return this.state.status;
  }
  get result(): string | undefined {
    return this.state.result;
  }
  get error(): string | undefined {
    return this.state.error;
  }
  get stoppedWhileQueued(): boolean {
    return this.state.stoppedWhileQueued;
  }
  get startedAt(): number {
    return this.state.startedAt;
  }
  get completedAt(): number | undefined {
    return this.state.completedAt;
  }
  get consumedAt(): number | undefined {
    return this.state.consumedAt;
  }
  get consumed(): boolean {
    return this.state.consumed;
  }
  get toolUses(): number {
    return this.state.toolUses;
  }
  get lifetimeUsage(): Readonly<LifetimeUsage> {
    return this.state.lifetimeUsage;
  }
  get compactionCount(): number {
    return this.state.compactionCount;
  }
  get turnCount(): number {
    return this.state.turnCount;
  }
  get activeTools(): ReadonlyMap<string, string> {
    return this.state.activeTools;
  }
  get responseText(): string {
    return this.state.responseText;
  }
  isActive(): boolean {
    return this.state.isActive();
  }
  isTerminalError(): boolean {
    return this.state.isTerminalError();
  }
  isRunning(): boolean {
    return this.state.isRunning();
  }
  canBeSteered(): boolean {
    return this.state.canBeSteered();
  }
  get maxTurns(): number | undefined {
    return this.execution.maxTurns;
  }
  get graceTurns(): number | undefined {
    return this.execution.graceTurns;
  }

  abortController: AbortController;
  private _promise?: Promise<void> | undefined;
  /** Handle on the agent's current run — the initial run, or the live resume that replaced it. */
  get promise(): Promise<void> | undefined {
    return this._promise;
  }

  readonly execution: SubagentExecution;
  private runtime?: AdmittedSubagentRuntime | undefined;
  private readonly listeners = new RunListeners();
  private workspaceBracket?: WorkspaceBracket | undefined;

  subagentSession?: SubagentSession | undefined;

  // Retained after releaseSession() disposes the heavy session, so outputFile
  // (transcript pointer) survives and the resume path can tell "released" from
  // "never had a session."
  private _releasedOutputFile?: string | undefined;
  private _releasedSessionId?: string | undefined;
  private _sessionReleased = false;
  /** True once releaseSession() has freed a live session (distinct from never having had one). */
  get sessionReleased(): boolean {
    return this._sessionReleased;
  }

  // Steer buffer — messages queued before the session is ready
  private _pendingSteers: string[] = [];
  /** Number of steer messages waiting to be delivered. */
  get pendingSteerCount(): number {
    return this._pendingSteers.length;
  }

  /**
   * Path to the agent's session JSONL file, or undefined if not yet available.
   * Falls back to the path captured at releaseSession() once the live session is gone.
   */
  get outputFile(): string | undefined {
    return this.subagentSession?.outputFile ?? this._releasedOutputFile;
  }

  /** Stable child session ID, retained after the heavy session is released. */
  get childSessionId(): string | undefined {
    return this.subagentSession?.sessionId ?? this._releasedSessionId;
  }

  /** Lineage metadata retained for storage and UI only. */
  get parentSessionId(): string | undefined {
    return this.execution.parentSession?.parentSessionId;
  }
  get toolCallId(): string | undefined {
    return this.execution.parentSession?.toolCallId;
  }
  private _task: string;
  get task(): string {
    return this._task;
  }

  /** Returns true when a SubagentSession is available (session is ready). */
  isSessionReady(): boolean {
    return this.subagentSession != null;
  }

  /**
   * Steer a running agent, owning the non-running rejection rule.
   * Returns a `rejected` outcome (with the observed status) when the agent is
   * not running, a `buffered` outcome when the session is not yet ready, or a
   * `delivered` outcome once the message reaches the session.
   */
  async steer(message: string): Promise<SteerOutcome> {
    if (!this.canBeSteered()) {
      return { kind: "rejected", status: this.status };
    }
    if (!this.subagentSession) {
      this.queueSteer(message);
      return { kind: "buffered" };
    }
    await this.subagentSession.steer(message);
    return { kind: "delivered" };
  }

  /** Return the session conversation as formatted text, or undefined if no session. */
  getConversation(): string | undefined {
    return this.subagentSession?.getConversation();
  }

  /** Return the session context window utilization (0-100), or null if unavailable. */
  getContextPercent(): number | null {
    return this.subagentSession?.getContextPercent() ?? null;
  }

  /**
   * Subscribe to session events for live updates (e.g., conversation viewer).
   * Returns an unsubscribe function, or undefined if no session is available.
   */
  subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined {
    return this.subagentSession?.subscribe(fn);
  }

  /** The session's message history, or an empty array if no session. */
  get messages(): readonly unknown[] {
    return this.subagentSession?.messages ?? [];
  }

  /** The session's message history typed for Pi's session-rendering machinery, or empty if no session. */
  get agentMessages(): readonly SessionMessage[] {
    return this.subagentSession?.agentMessages ?? [];
  }

  /** Resolve a registered tool definition by name, or undefined if no session. */
  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.subagentSession?.getToolDefinition(name);
  }

  constructor(init: SubagentInit) {
    // Identity
    this.id = init.id;
    this.type = init.type;
    this.description = init.description;
    this.invocation = init.invocation;

    // Lifecycle status and metrics — fresh queued state unless one is supplied
    this.state = init.state ?? new SubagentState();

    // Abort controller — always created, never injected
    this.abortController = new AbortController();

    // Execution machinery — a single mandatory collaborator
    this.execution = init.execution;
    this._task = init.execution.task;
  }

  /** Attach live collaborators after admission. */
  admit(runtime: AdmittedSubagentRuntime): void {
    if (this.runtime) throw new Error(`Subagent ${this.id} was admitted more than once`);
    this.runtime = runtime;
    this.workspaceBracket = new WorkspaceBracket(runtime.workspaceProvider);
  }

  private admitted(): AdmittedSubagentRuntime {
    if (!this.runtime) throw new Error(`Subagent ${this.id} has not been admitted`);
    return this.runtime;
  }

  /**
   * Execute the full agent lifecycle: workspace preparation, session creation
   * via the factory, observer wiring, the turn loop, workspace disposal, and
   * status transitions.
   *
   * Execution is supplied at construction (mandatory), so run() needs no
   * "not configured" guards. The returned promise always resolves (errors are
   * captured internally).
   */
  async run(): Promise<void> {
    const runtime = this.admitted();
    const workspaceBracket = this.workspaceBracket!;
    this.markRunning(Date.now());
    runtime.observer?.onStarted?.(this);
    this.listeners.wireSignal(runtime.signal, () => this.abort());

    // Guard the await so the no-provider path stays synchronous, preserving
    // the original run() timing: the factory is called in the same turn as
    // spawn() when no workspace provider is registered.
    let cwd: string | undefined;
    if (workspaceBracket.hasProvider()) {
      try {
        cwd = await workspaceBracket.prepare({
          agentId: this.id,
          agentType: this.type,
          baseCwd: this.execution.baseCwd,
          invocation: this.invocation,
        });
      } catch (err) {
        this.markError(err);
        this.listeners.release();
        this.runtime?.observer?.onRunFinished?.(this);
        return;
      }
    }
    if (!this.isRunning()) {
      this.finishStoppedRun();
      return;
    }

    try {
      this.subagentSession = await runtime.createSubagentSession({
        baseline: this.execution.baseline,
        modelRegistry: runtime.modelRegistry,
        defaultModel: runtime.defaultModel,
        type: this.type,
        cwd,
        parentSession: this.execution.parentSession,
        model: runtime.model,
        thinkingLevel: this.execution.thinkingLevel,
        invocation: this.invocation,
      });
    } catch (err) {
      // The factory disposed its own session on a post-creation failure.
      this.failRun(err);
      return;
    }
    if (!this.isRunning()) {
      await this.releaseSession();
      this.finishStoppedRun();
      return;
    }

    this.flushPendingSteers();
    this.listeners.attachObserver(
      subscribeSubagentObserver(this.subagentSession, this.state, {
        onCompact: (info) => this.admitted().observer?.onCompacted?.(this, info),
      }),
    );
    runtime.observer?.onSessionCreated?.(this);

    const runConfig = this.admitted().runConfig;
    try {
      const result = await this.subagentSession.runTurnLoop(this._task, {
        maxTurns: this.execution.maxTurns,
        defaultMaxTurns: runConfig?.defaultMaxTurns,
        graceTurns: this.execution.graceTurns ?? runConfig?.graceTurns,
        signal: this.abortController.signal,
      });
      this.completeRun(result);
    } catch (err) {
      this.failRun(err);
    }
  }

  /**
   * Start execution immediately (foreground / bypassQueue paths).
   * Stores the run promise so it is awaitable via the `promise` getter.
   */
  start(runtime?: AdmittedSubagentRuntime): void {
    if (runtime) this.admit(runtime);
    else this.admitted();
    this._promise = this.guardedRun();
  }

  /** Attach the manager-owned queue settlement promise before admission. */
  setQueuedPromise(promise: Promise<void>): void {
    this._promise = promise;
  }

  /**
   * Run unless the agent left the active set before its slot opened
   * (e.g. abort-while-queued): a non-queued, non-running status resolves
   * immediately without running.
   */
  private guardedRun(): Promise<void> {
    if (!this.isActive()) return Promise.resolve();
    return this.run();
  }

  /**
   * Wait until this agent's current run settles.
   * Resolves immediately when the agent is no longer active or has no run
   * handle. A queued agent is awaitable because scheduleVia() captures the
   * limiter promise at spawn, so the wait spans both the queue slot and the
   * run that follows it.
   *
   * When `signal` fires the wait ends early and the agent keeps running: this
   * is a query, so interrupting it must not cancel the work. Cancelling the
   * work on a parent interrupt is InterruptHandler's separate decision.
   */
  async waitUntilSettled(signal: AbortSignal): Promise<void> {
    const run = this._promise;
    if (!run || !this.isActive()) return;
    await settleOrAbort(run, signal);
  }

  /**
   * Resume an existing child-owned transcript with a new prompt. Provider-backed
   * runs always receive a fresh workspace and session; without a provider, a
   * retained live session remains reusable.
   */
  resume(
    task: string,
    signal?: AbortSignal,
    budgets?: { maxTurns?: number | undefined; graceTurns?: number | undefined },
    invocation?: { model: Model<any> | undefined; snapshot: AgentInvocation },
  ): Promise<void> {
    const session = this.subagentSession;
    const transcriptPath = session?.outputFile ?? this._releasedOutputFile;
    if (!session && !transcriptPath) {
      return Promise.reject(new Error("Subagent not configured for resume — missing session"));
    }
    if (this.isActive()) return Promise.reject(new Error(`Subagent ${this.id} is already running`));

    const runtime = this.admitted();
    if ((runtime.workspaceProvider || invocation) && !transcriptPath) {
      return Promise.reject(
        new Error("Subagent not configured for reconstructed resume — missing child transcript"),
      );
    }

    this._task = task;
    if (budgets?.maxTurns !== undefined || budgets?.graceTurns !== undefined) {
      this.invocation = {
        ...this.invocation,
        maxTurns: budgets.maxTurns ?? this.invocation?.maxTurns,
        graceTurns: budgets.graceTurns ?? this.invocation?.graceTurns,
      };
    }
    if (invocation) {
      this.invocation = { ...invocation.snapshot };
      this.execution.model = invocation.model
        ? { provider: invocation.model.provider, id: invocation.model.id }
        : undefined;
      this.execution.thinkingLevel = invocation.snapshot.thinking;
      if (invocation.snapshot.runInBackground !== undefined) {
        this.execution.isBackground = invocation.snapshot.runInBackground;
      }
    }
    if (budgets?.maxTurns !== undefined) this.execution.maxTurns = budgets.maxTurns;
    if (budgets?.graceTurns !== undefined) this.execution.graceTurns = budgets.graceTurns;
    this.abortController = new AbortController();
    this.resetForResume(Date.now());
    runtime.observer?.onStarted?.(this);

    if (session && !runtime.workspaceProvider && !invocation) {
      this._promise = this.runResume(session, task, signal, budgets, true);
      return this._promise;
    }

    this._promise = this.reconstructAndResume(transcriptPath!, session, task, signal, budgets);
    return this._promise;
  }

  private async reconstructAndResume(
    transcriptPath: string,
    previousSession: SubagentSession | undefined,
    task: string,
    signal?: AbortSignal,
    budgets?: { maxTurns?: number | undefined; graceTurns?: number | undefined },
  ): Promise<void> {
    const runtime = this.admitted();
    this._releasedOutputFile = transcriptPath;
    this._releasedSessionId = previousSession?.sessionId ?? this._releasedSessionId;
    this.subagentSession = undefined;
    this._sessionReleased = true;
    await disposeQuietly(previousSession, "child session workspace resume");

    const workspaceBracket = new WorkspaceBracket(runtime.workspaceProvider);
    this.workspaceBracket = workspaceBracket;

    try {
      const cwd = workspaceBracket.hasProvider()
        ? await workspaceBracket.prepare(this.workspacePrepareContext())
        : this.execution.baseline.cwd;
      if (!this.isRunning()) {
        this.completeResume("");
        return;
      }
      this.subagentSession = await runtime.createSubagentSession({
        baseline: this.execution.baseline,
        modelRegistry: runtime.modelRegistry,
        defaultModel: runtime.defaultModel,
        type: this.type,
        cwd,
        parentSession: this.execution.parentSession,
        model: this.execution.model
          ? runtime.modelRegistry.find(this.execution.model.provider, this.execution.model.id)
          : runtime.model,
        thinkingLevel: this.execution.thinkingLevel,
        invocation: this.invocation,
        resumeTranscriptPath: transcriptPath,
      });
      if (!this.isRunning()) {
        await this.releaseSession();
        this.completeResume("");
        return;
      }
      this._sessionReleased = false;
      this.flushPendingSteers();
      runtime.observer?.onSessionCreated?.(this);
      await this.runResume(this.subagentSession, task, signal, budgets, true);
    } catch (err) {
      this.failResume(err);
    }
  }

  /** The resume body. Always resolves — errors terminate through failResume(). */
  private async runResume(
    subagentSession: SubagentSession,
    task: string,
    signal?: AbortSignal,
    budgets?: { maxTurns?: number | undefined; graceTurns?: number | undefined },
    alreadyRunning = false,
  ): Promise<void> {
    if (!alreadyRunning) this.resetForResume(Date.now());
    this.listeners.attachObserver(
      subscribeSubagentObserver(subagentSession, this.state, {
        onCompact: (info) => this.admitted().observer?.onCompacted?.(this, info),
      }),
    );

    const combinedSignal = combineAbortSignals(this.abortController.signal, signal);
    try {
      const runConfig = this.admitted().runConfig;
      this.completeResume(
        await subagentSession.resumeTurnLoop(task, {
          maxTurns: budgets?.maxTurns ?? this.execution.maxTurns,
          defaultMaxTurns: runConfig?.defaultMaxTurns,
          graceTurns: budgets?.graceTurns ?? this.execution.graceTurns ?? runConfig?.graceTurns,
          signal: combinedSignal.signal,
        }),
      );
    } catch (err) {
      this.failResume(err);
    } finally {
      combinedSignal.cleanup();
    }
  }

  /** Terminate a resume as completed: mark, release listeners, notify observer. */
  completeResume(result: string): void {
    this.listeners.release();
    const status = this.status === "stopped" ? "stopped" : "completed";
    const addendum = this.workspaceBracket?.dispose({
      status,
      description: this.description,
    });
    this.markCompleted(result + (addendum ?? ""));
    this.admitted().observer?.onResumeFinished?.(this);
  }

  /** Terminate a resume as errored: mark, release listeners, notify observer. */
  failResume(err: unknown): void {
    this.listeners.release();
    let addendum = "";
    try {
      addendum =
        this.workspaceBracket?.dispose({
          status: this.status === "stopped" ? "stopped" : "error",
          description: this.description,
        }) ?? "";
    } catch (cleanupErr) {
      debugLog("workspace dispose on agent resume error", cleanupErr);
    }
    const message = err instanceof Error ? err.message : String(err);
    this.markError(message + addendum);
    this.admitted().observer?.onResumeFinished?.(this);
  }

  /** Transition to running state. Sets status and startedAt. */
  markRunning(startedAt: number): void {
    this.state.markRunning(startedAt);
  }

  /**
   * Transition to completed state.
   * Always sets result and completedAt (??=). Only changes status if not stopped.
   */
  markCompleted(result: string, completedAt?: number): void {
    this.state.markCompleted(result, completedAt);
  }

  /**
   * Transition to aborted state.
   * Always sets result and completedAt (??=). Only changes status if not stopped.
   */
  markAborted(result: string, completedAt?: number): void {
    this.state.markAborted(result, completedAt);
  }

  /**
   * Transition to steered state.
   * Always sets result and completedAt (??=). Only changes status if not stopped.
   */
  markSteered(result: string, completedAt?: number): void {
    this.state.markSteered(result, completedAt);
  }

  /**
   * Transition to error state.
   * Always sets error (formatted) and completedAt (??=). Only changes status if not stopped.
   */
  markError(error: unknown, completedAt?: number): void {
    this.state.markError(error, completedAt);
  }

  /** Transition to stopped state. Always valid — no guard. */
  markStopped(completedAt?: number): void {
    this.state.markStopped(completedAt);
  }

  /** Record the parent collected this agent's outcome. Idempotent. */
  markConsumed(at?: number): void {
    this.state.markConsumed(at);
  }

  /**
   * Stop an agent that never started, then notify like every other terminal
   * transition. No listener release: nothing is wired before run().
   * The record leaves the active set here, so the thunk the limiter runs when
   * the slot finally frees no-ops on guardedRun()'s guard — one notification.
   */
  stopQueued(): void {
    this.state.stopQueued();
    this.runtime?.observer?.onRunFinished?.(this);
  }

  /**
   * Abort a running agent: fire AbortController and transition to stopped.
   * Returns false if the agent is not running.
   * A still-queued agent is stopped via stopQueued(); its scheduled thunk
   * then no-ops on the queued-status guard.
   */
  abort(): boolean {
    if (!this.isRunning()) return false;
    this._pendingSteers = [];
    this.abortController.abort();
    this.markStopped();
    return true;
  }

  /**
   * Buffer a steer message for delivery once the session is ready.
   * Called internally from steer() before the session is ready.
   */
  private queueSteer(message: string): void {
    this._pendingSteers.push(message);
  }

  /**
   * Flush all buffered steer messages to the session and clear the buffer.
   * Called once the session is available (inside run()).
   */
  private flushPendingSteers(): void {
    for (const msg of this._pendingSteers) {
      this.subagentSession?.steer(msg).catch(() => {});
    }
    this._pendingSteers = [];
  }

  /** Reset for resume: running status, new startedAt, clear completedAt/result/error/consumedAt/listeners. */
  resetForResume(startedAt: number): void {
    this.state.resetForResume(startedAt);
    this.listeners.release();
  }

  private workspacePrepareContext() {
    return {
      agentId: this.id,
      agentType: this.type,
      baseCwd: this.execution.baseCwd,
      invocation: this.invocation,
    };
  }

  private finishStoppedRun(): void {
    this.listeners.release();
    let addendum = "";
    try {
      addendum =
        this.workspaceBracket?.dispose({
          status: "stopped",
          description: this.description,
        }) ?? "";
    } catch (err) {
      debugLog("workspace dispose on stopped agent", err);
    }
    this.markCompleted(addendum);
    this.runtime?.observer?.onRunFinished?.(this);
  }

  /** Complete a run: release listeners, dispose the workspace, status transition, notify observer. */
  completeRun(result: TurnLoopResult): void {
    this.listeners.release();

    const finalStatus: SubagentStatus = result.aborted
      ? "aborted"
      : result.steered
        ? "steered"
        : "completed";
    const finalResult =
      result.responseText +
      this.workspaceBracket!.dispose({ status: finalStatus, description: this.description });

    if (result.aborted) this.markAborted(finalResult);
    else if (result.steered) this.markSteered(finalResult);
    else this.markCompleted(finalResult);

    this.runtime?.observer?.onRunFinished?.(this);
  }

  /**
   * Dispose the wrapped session, firing the `disposed` lifecycle event.
   * Resolves once the child's extensions have shut down; a failing teardown is
   * swallowed so the caller's remaining cleanup still runs.
   */
  async disposeSession(): Promise<void> {
    this.listeners.release();
    try {
      this.workspaceBracket?.dispose({ status: this.status, description: this.description });
    } catch (err) {
      debugLog("workspace dispose on child session teardown", err);
    }
    await disposeQuietly(this.subagentSession, "child session dispose");
  }

  /**
   * Release the heavy session while keeping the record: capture the transcript
   * pointer, dispose the session (firing `disposed`), clear it, and mark released.
   * A no-op once the session is gone — the retention sweep may call it repeatedly.
   *
   * The record's own state is updated before the teardown is awaited, so a sweep
   * tick arriving mid-teardown sees a released record rather than starting a
   * second one.
   */
  async releaseSession(): Promise<void> {
    const session = this.subagentSession;
    if (!session) return;
    this._releasedOutputFile = session.outputFile ?? this._releasedOutputFile;
    this._releasedSessionId = session.sessionId;
    this.subagentSession = undefined;
    this._sessionReleased = true;
    await disposeQuietly(session, "child session release");
  }

  /** Fail a run: mark error, release listeners, best-effort workspace dispose, notify observer. */
  failRun(err: unknown): void {
    this.markError(err);
    this.listeners.release();

    try {
      this.workspaceBracket?.dispose({ status: "error", description: this.description });
    } catch (cleanupErr) {
      debugLog("workspace dispose on agent error", cleanupErr);
    }

    this.runtime?.observer?.onRunFinished?.(this);
  }
}

/**
 * Tear a child session down without letting its failure escape.
 * Both teardown paths are cleanup: a child that will not shut down cleanly must
 * not stop the caller from finishing the rest of its own cleanup.
 */
async function disposeQuietly(
  session: SubagentSession | undefined,
  context: string,
): Promise<void> {
  try {
    await session?.dispose();
  } catch (err) {
    debugLog(context, err);
  }
}

/**
 * Settle with `run`, or early when `signal` fires — whichever comes first.
 * The inner controller is the listener-cleanup channel: it detaches the abort
 * listener whichever branch wins, so repeated waits within one parent turn do
 * not accumulate listeners on that turn's signal.
 */
function settleOrAbort(run: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const detach = new AbortController();
  const interrupted = new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true, signal: detach.signal },
    );
  });
  return Promise.race([run, interrupted]).finally(() => {
    detach.abort();
  });
}

function combineAbortSignals(
  primary: AbortSignal,
  secondary?: AbortSignal,
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  if (!secondary || secondary === primary) return { signal: primary, cleanup: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (primary.aborted || secondary.aborted) controller.abort();
  else {
    primary.addEventListener("abort", abort, { once: true });
    secondary.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener("abort", abort);
      secondary.removeEventListener("abort", abort);
    },
  };
}
