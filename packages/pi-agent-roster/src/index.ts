/**
 * pi-agents — A pi extension providing focused, in-process autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 */

import { readFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  type ModelRuntime,
  type ResourceLoader,
  SettingsManager as SdkSettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { AgentTypeRegistry } from "./config/agent-types.ts";
import { loadCustomAgents } from "./config/custom-agents.ts";
import { InterruptHandler, SessionLifecycleHandler, ToolStartHandler } from "./handlers/index.ts";
import { createChildLifecyclePublisher } from "./lifecycle/child-lifecycle.ts";
import { ConcurrencyLimiter } from "./lifecycle/concurrency-limiter.ts";
import {
  createSubagentSession,
  type SubagentSessionDeps,
} from "./lifecycle/create-subagent-session.ts";
import { SubagentManager } from "./lifecycle/subagent-manager.ts";
import { CompositeSubagentObserver } from "./observation/composite-subagent-observer.ts";
import { type NotificationDetails, NotificationManager } from "./observation/notification.ts";
import { createNotificationRenderer } from "./observation/renderer.ts";
import { SubagentEventsObserver } from "./observation/subagent-events-observer.ts";
import { PRIMARY_AGENT_FLAG, PRIMARY_STACK_FLAG, PrimaryController } from "./primary/controller.ts";
import { createSubagentRuntime } from "./runtime.ts";
import { publishSubagentsService } from "./service/service.ts";
import { SubagentsServiceAdapter } from "./service/service-adapter.ts";
import { detectEnv } from "./session/env.ts";
import { createExcludedPackagesStorage } from "./session/package-exclusions.ts";
import { buildAgentPrompt } from "./session/prompts.ts";
import { deriveSubagentSessionDir } from "./session/session-dir.ts";
import { SettingsManager } from "./settings.ts";
import { AgentTool } from "./tools/agent-tool.ts";
import { GetResultTool } from "./tools/get-result-tool.ts";
import { InvocationRowRegistry } from "./tools/invocation-row.ts";
import { SteerTool } from "./tools/steer-tool.ts";
import { AgentWidget } from "./ui/agent-widget.ts";
import { SessionNavigatorHandler } from "./ui/session-navigator.ts";
import { SubagentsSettingsHandler } from "./ui/subagents-settings.ts";

export default function (pi: ExtensionAPI) {
  if (typeof pi.registerFlag === "function") registerPrimaryFlags(pi);
  if (typeof pi.registerMessageRenderer !== "function") return;

  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    createNotificationRenderer(),
  );

  const registry = new AgentTypeRegistry(() => loadCustomAgents(process.cwd()));

  // ---- Runtime: all mutable extension state in one place ----
  const runtime = createSubagentRuntime();

  // ---- Notification system ----
  // Owns completion nudges and live-activity cleanup. The widget detects finished
  // agents itself (AgentWidget.update self-seeds), so NotificationManager has no
  // widget dependency — keeping the construction graph a cycle-free DAG.
  const notifications = new NotificationManager((msg, opts) =>
    opts
      ? pi.sendMessage(msg, {
          ...(opts.triggerTurn === undefined ? {} : { triggerTurn: opts.triggerTurn }),
          ...(opts.deliverAs === undefined ? {} : { deliverAs: opts.deliverAs }),
        })
      : pi.sendMessage(msg),
  );

  // Gate nudge delivery on the parent's agent run. agent_settled fires exactly
  // once per run (from a finally block, so it also covers error and abort),
  // whereas agent_end fires once per run segment — retries, auto-compaction and
  // followUp continuations each emit one.
  pi.on("agent_start", () => notifications.onParentAgentStart());
  pi.on("agent_settled", () => notifications.onParentAgentSettled());

  let manager: SubagentManager;

  // Settings: owns all three in-memory values and handles load/save/emit.
  const settings: SettingsManager = new SettingsManager({
    emit: (event, payload) => pi.events.emit(event, payload),
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    onMaxConcurrentChanged: (): void => manager?.recheckAdmissions(),
  });
  settings.load();

  // Observer: receives agent lifecycle notifications and dispatches events/notifications.
  const eventsObserver = new SubagentEventsObserver({
    emit: (channel, data) => pi.events.emit(channel, data),
    appendEntry: (customType, data) => {
      if (data) pi.appendEntry(customType, data);
    },
    notifications,
  });

  // Fan-out observer: lets the widget subscribe as a second lifecycle consumer
  // while the manager keeps its single-observer contract. The widget is added
  // after construction (it needs the manager); the manager consults the observer
  // only at spawn time, so registering late is safe.
  const observer = new CompositeSubagentObserver([eventsObserver]);

  const subagentSessionDeps: SubagentSessionDeps = {
    io: {
      detectEnv,
      getAgentDir,
      createResourceLoader: (opts) =>
        new DefaultResourceLoader(opts as ConstructorParameters<typeof DefaultResourceLoader>[0]),
      deriveSessionDir: deriveSubagentSessionDir,
      createSessionManager: (cwd, dir) => SessionManager.create(cwd, dir),
      openSessionManager: (path, cwd) => SessionManager.open(path, undefined, cwd),
      createSettingsManager: (cwd, dir) => SdkSettingsManager.create(cwd, dir),
      // The exclusion policy is resolved here, at the composition root, so the
      // assembly factory stays free of it and gets a ready-made settings view.
      createLoaderSettingsManager: (parent) => {
        const excluded = new Set<string>(settings.excludedExtensionPackages);
        if (excluded.size === 0) return parent;
        return SdkSettingsManager.fromStorage(createExcludedPackagesStorage(parent, excluded), {
          projectTrusted: parent.isProjectTrusted(),
        });
      },
      // The factory states its collaborators as narrow structural contracts so
      // it can be tested with plain stubs. Here at the composition root the
      // values really are the SDK objects, so widen those three and let every
      // other option type-check against the SDK signature.
      createSession: ({
        sessionManager,
        resourceLoader,
        modelRegistry,
        model,
        thinkingLevel,
        excludeTools,
        ...rest
      }) =>
        createAgentSession({
          ...rest,
          ...(model === undefined ? {} : { model }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          ...(excludeTools === undefined ? {} : { excludeTools }),
          sessionManager: sessionManager as SessionManager,
          resourceLoader: resourceLoader as ResourceLoader,
          modelRuntime: (modelRegistry as unknown as { runtime: ModelRuntime }).runtime,
        }),
      assemblerIO: {
        buildAgentPrompt,
      },
    },
    exec: (cmd, args, opts) =>
      pi.exec(
        cmd,
        args,
        opts && {
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
        },
      ),
    registry,
    lifecycle: createChildLifecyclePublisher((channel, data) => pi.events.emit(channel, data)),
  };

  const limiter: ConcurrencyLimiter = new ConcurrencyLimiter((): number => settings.maxConcurrent);

  manager = new SubagentManager({
    createSubagentSession: (params) => createSubagentSession(params, subagentSessionDeps),
    baseCwd: process.cwd(),
    observer,
    limiter,
    getModelRegistry: () => runtime.getModelRegistry(),
    getDefaultModel: () => runtime.getDefaultModel(),
    getRunConfig: () => settings,
    getRetentionPolicy: () => settings,
  });

  const invocationRows = new InvocationRowRegistry((id) => manager.getRecord(id));
  observer.add(invocationRows);

  const primary = new PrimaryController({
    pi,
    registry,
    stackOverrides: runtime.stackOverrides,
  });

  // Typed service published via Symbol.for() for cross-extension access.
  // Consumers: const { getSubagentsService } = await import("pi-agent-roster");
  const service = new SubagentsServiceAdapter(manager, runtime, {
    registry,
    stackOverrides: runtime.stackOverrides,
    settings,
    refreshRegistry: () => primary.reconcileBeforeDelegation(),
    authorizeTarget: (type) => primary.authorizeTarget(type),
    notify: (message) => primary.notify(message),
    getPropagatedStack: () => primary.getPropagatedStack(),
  });
  const unpublishService = publishSubagentsService(service);

  let widget: AgentWidget | undefined;
  const lifecycle = new SessionLifecycleHandler(
    runtime,
    manager,
    () => {
      notifications.dispose();
      invocationRows.dispose();
      widget?.dispose();
      primary.dispose();
    },
    unpublishService,
  );

  pi.on("session_start", async (event, ctx) => {
    invocationRows.clear();
    await lifecycle.handleSessionStart(event, ctx);
    await primary.handleSessionStart(ctx);
  });
  pi.on("session_before_switch", () => {
    invocationRows.clear();
    return lifecycle.handleSessionBeforeSwitch();
  });
  pi.on("session_shutdown", () => lifecycle.handleSessionShutdown());
  pi.on("before_agent_start", (event) => primary.beforeAgentStart(event));

  // Live widget: constructed after the manager (it polls listAgents()) and
  // registered as a lifecycle observer so it self-drives its update timer.
  widget = new AgentWidget(manager, registry);
  observer.add(widget);

  // Grab UI context from first tool execution + clear lingering widget on new turn
  const toolStart = new ToolStartHandler(widget);
  pi.on("tool_execution_start", (event, ctx) => toolStart.handleToolExecutionStart(event, ctx));

  // Abort all subagents when the parent agent loop is interrupted (ESC), unless
  // the user has turned that policy off. The predicate is read at abort time.
  const interrupt = new InterruptHandler(manager, () => settings.abortAllOnInterrupt);
  pi.on("turn_start", (_event, ctx) => {
    interrupt.handleTurnStart(ctx);
    widget?.onTurnStart();
  });

  // ---- Agent tool ----

  pi.registerTool(
    new AgentTool(
      manager,
      runtime,
      settings,
      registry,
      getAgentDir(),
      {
        stackOverrides: runtime.stackOverrides,
        refreshRegistry: () => primary.reconcileBeforeDelegation(),
        authorizeTarget: (type) => primary.authorizeTarget(type),
        getPropagatedStack: () => primary.getPropagatedStack(),
      },
      invocationRows,
    ).toToolDefinition(),
  );

  // ---- get_subagent_result tool ----

  pi.registerTool(new GetResultTool(manager, registry).toToolDefinition());

  // ---- steer_subagent tool ----

  pi.registerTool(new SteerTool(manager, pi.events).toToolDefinition());

  pi.registerCommand("agent", {
    description: "Select a primary agent profile",
    handler: (args, ctx) => primary.handleAgentCommand(args, ctx),
  });

  pi.registerCommand("stack", {
    description: "Select a session-local agent stack",
    getArgumentCompletions: (prefix) => primary.getStackArgumentCompletions(prefix),
    handler: (args, ctx) => primary.handleStackCommand(args, ctx),
  });

  pi.registerCommand("agents:reload", {
    description: "Reload agent definitions",
    handler: (_args, ctx) => primary.reload(ctx),
  });

  // ---- /subagents:settings command ----

  const subagentsSettings = new SubagentsSettingsHandler(settings);

  pi.registerCommand("subagents:settings", {
    description: "Configure project subagent settings (global defaults are read-only)",
    handler: async (_args, ctx) => {
      await subagentsSettings.handle({ ui: ctx.ui });
    },
  });

  // ---- /subagents:sessions command ----

  const sessionNavigator = new SessionNavigatorHandler();

  pi.registerCommand("subagents:sessions", {
    description: "View a subagent's session transcript (read-only)",
    handler: async (_args, ctx) => {
      await sessionNavigator.handle({
        ui: ctx.ui,
        agents: manager.listAgents(),
        registry,
        cwd: ctx.cwd,
        readFile: (path) => readFileSync(path, "utf8"),
      });
    },
  });
}

function registerPrimaryFlags(pi: ExtensionAPI): void {
  pi.registerFlag(PRIMARY_AGENT_FLAG, {
    description: "Select an enabled primary agent profile",
    type: "string",
  });
  pi.registerFlag(PRIMARY_STACK_FLAG, {
    description: "Select a named stack for --agent",
    type: "string",
  });
}
