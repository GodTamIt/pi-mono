import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { createJiti } from "jiti";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";

const [agentDir, workDir, childWorkDir, parentSessionDir, installedPackage] = process.argv.slice(2);
if (!agentDir || !workDir || !childWorkDir || !parentSessionDir || !installedPackage) {
  throw new Error(
    "usage: actual-pi.mjs <agent-dir> <work-dir> <child-work-dir> <parent-session-dir> <installed-package>",
  );
}
process.chdir(workDir);

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { AgentTypeRegistry } = await jiti.import(
  join(installedPackage, "src", "config", "agent-types.ts"),
);
const { discoverCustomAgents } = await jiti.import(
  join(installedPackage, "src", "config", "custom-agents.ts"),
);
const discovery = discoverCustomAgents(workDir);
const registry = new AgentTypeRegistry(() => discovery.agents);
const snapshot = registry.snapshot();
if (
  registry.resolveAgentConfig("actual-pi").source !== "project" ||
  !registry.resolveAgentConfig("actual-pi").systemPrompt.includes("PROJECT_AGENT_PROMPT_594a") ||
  !snapshot.all.includes("actual-pi") ||
  !snapshot.all.includes("layered") ||
  !snapshot.primary.includes("primary-only") ||
  snapshot.subagent.includes("primary-only") ||
  !snapshot.subagent.includes("global-worker")
) {
  throw new Error(`Installed layered agent classification failed: ${JSON.stringify(snapshot)}`);
}

const sentinels = {
  prompt: "PARENT_SYSTEM_d82f18",
  message: "PARENT_MESSAGE_13ea62",
  backgroundMessage: "PARENT_BACKGROUND_MESSAGE_a8e093",
  thinking: "PARENT_THINKING_62cd41",
  summary: "PARENT_SUMMARY_55af09",
  event: "PARENT_EVENT_713ceb",
  callback: "PARENT_CALLBACK_8ea21c",
};
const tasks = {
  tool: "TOOL_TASK_59fd read marker.txt and report it",
  backgroundTool: "TOOL_BACKGROUND_TASK_a930 read marker.txt and report it",
  foreground: "SERVICE_FOREGROUND_TASK_a921 report foreground",
  background: "SERVICE_BACKGROUND_TASK_4d81 wait for steering",
  queued: "SERVICE_QUEUED_TASK_f388 report queued",
  resume: "RESUME_TASK_01c7 use only your history and this request",
};
const steering = "CHILD_STEERING_70b2 now finish with the marker";
const workspaceMarker = "CHILD_WORKSPACE_f24a3d";
const requests = [];
let backgroundFirstRequest;
let resolveBackgroundFirstRequest;
const backgroundObserved = new Promise((resolve) => {
  resolveBackgroundFirstRequest = resolve;
});

function textOf(message) {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  if (message.role === "assistant") {
    return message.content
      .map((part) =>
        part.type === "text"
          ? part.text
          : part.type === "thinking"
            ? part.thinking
            : `${part.name}:${JSON.stringify(part.arguments)}`,
      )
      .join("\n");
  }
  return `${message.toolName}\n${message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")}`;
}

function contextText(context) {
  return [context.systemPrompt, ...context.messages.map(textOf)].filter(Boolean).join("\n");
}

function responseFor(context) {
  const snapshot = {
    systemPrompt: context.systemPrompt,
    messages: structuredClone(context.messages),
    tools: context.tools?.map((tool) => ({ name: tool.name, description: tool.description })),
  };
  requests.push(snapshot);
  const text = contextText(context);

  for (const invocation of [
    {
      sentinel: sentinels.backgroundMessage,
      task: tasks.backgroundTool,
      background: true,
      toolCallId: "parent-background-tool-call",
    },
    {
      sentinel: sentinels.message,
      task: tasks.tool,
      background: false,
      toolCallId: "parent-tool-call",
    },
  ]) {
    if (!text.includes(invocation.sentinel)) continue;
    const hasToolResult = context.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "subagent" &&
        message.toolCallId === invocation.toolCallId,
    );
    if (!hasToolResult) {
      return fauxAssistantMessage(
        [
          fauxThinking(sentinels.thinking),
          fauxToolCall(
            "subagent",
            {
              task: invocation.task,
              subagent_type: "actual-pi",
              run_in_background: invocation.background,
            },
            { id: invocation.toolCallId },
          ),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(
      invocation.background ? "parent launched background child" : "parent received child result",
    );
  }

  if (text.includes(tasks.resume)) return fauxAssistantMessage("resumed from child history only");
  if (text.includes(tasks.tool) || text.includes(tasks.backgroundTool)) {
    if (!text.includes(workspaceMarker)) {
      return fauxAssistantMessage(
        fauxToolCall("read", { path: "marker.txt" }, { id: "child-read" }),
        {
          stopReason: "toolUse",
        },
      );
    }
    return fauxAssistantMessage(`tool child saw ${workspaceMarker}`);
  }
  if (text.includes(tasks.foreground)) return fauxAssistantMessage("service foreground complete");
  if (text.includes(tasks.background)) {
    if (text.includes(steering)) return fauxAssistantMessage("steered background complete");
    if (!backgroundFirstRequest) {
      backgroundFirstRequest = snapshot;
      resolveBackgroundFirstRequest();
    }
    return fauxAssistantMessage("background first segment ".repeat(30));
  }
  if (text.includes(tasks.queued)) return fauxAssistantMessage("queued child complete");
  throw new Error(`Unexpected faux request: ${text.slice(-500)}`);
}

const faux = fauxProvider({
  api: "roster-faux-api",
  provider: "roster-faux",
  models: [
    { id: "roster-faux-model", name: "Roster Faux", contextWindow: 32_000, maxTokens: 2_000 },
    { id: "roster-faux-deep", name: "Roster Faux Deep", contextWindow: 32_000, maxTokens: 2_000 },
  ],
  tokensPerSecond: 200,
  tokenSize: { min: 8, max: 8 },
});
faux.setResponses(Array.from({ length: 20 }, () => responseFor));

const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
modelRuntime.registerNativeProvider(faux.provider);
const model = modelRuntime.getModel("roster-faux", "roster-faux-model");
if (!model) throw new Error("Faux model was not registered");

const eventBus = createEventBus();
const lifecycle = [];
for (const channel of [
  "subagents:child:spawning",
  "subagents:child:session-created",
  "subagents:child:completed",
  "subagents:child:disposed",
  "subagents:created",
  "subagents:started",
  "subagents:completed",
  "subagents:resumed",
  "subagents:steered",
]) {
  eventBus.on(channel, (data) => lifecycle.push({ channel, data }));
}
eventBus.emit("parent:test-event", { sentinel: sentinels.event });

const parentManager = SessionManager.create(workDir, parentSessionDir);
parentManager.newSession();
const oldMessageId = parentManager.appendMessage({
  role: "user",
  content: sentinels.message,
  timestamp: Date.now(),
});
parentManager.appendMessage(fauxAssistantMessage(fauxThinking(sentinels.thinking)));
parentManager.appendCompaction(sentinels.summary, oldMessageId, 100);

const settings = SettingsManager.create(workDir, agentDir);
const loader = new DefaultResourceLoader({
  cwd: workDir,
  agentDir,
  settingsManager: settings,
  eventBus,
  systemPromptOverride: () => sentinels.prompt,
});
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (handler, delay, ...args) =>
  nativeSetInterval(handler, delay === 60_000 ? 20 : delay, ...args);
try {
  await loader.reload();
} finally {
  globalThis.setInterval = nativeSetInterval;
}
const extensionErrors = loader.getExtensions().errors;
if (extensionErrors.length)
  throw new Error(`Extension load errors: ${JSON.stringify(extensionErrors)}`);

const { session } = await createAgentSession({
  cwd: workDir,
  agentDir,
  model,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: parentManager,
  settingsManager: settings,
  thinkingLevel: "off",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertNoParentSentinels(value, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of Object.values(sentinels)) {
    assert(!serialized.includes(sentinel), `${label} leaked ${sentinel}`);
  }
}

try {
  await session.bindExtensions({});
  const service = globalThis[Symbol.for("pi-agent-roster:service")];
  assert(service, "Packed extension did not publish its service");

  const workspaceCalls = [];
  let workspaceSequence = 0;
  service.registerWorkspaceProvider({
    async prepare(context) {
      const callbackSentinel = sentinels.callback;
      const cwd = join(childWorkDir, `run-${++workspaceSequence}`);
      mkdirSync(cwd, { recursive: true });
      copyFileSync(join(childWorkDir, "marker.txt"), join(cwd, "marker.txt"));
      workspaceCalls.push({ ...context, cwd, closureWasPresent: callbackSentinel.length > 0 });
      return {
        cwd,
        dispose(outcome) {
          workspaceCalls.push({ disposed: outcome, cwd });
          rmSync(cwd, { recursive: true, force: true });
          return { resultAddendum: "workspace disposed" };
        },
      };
    },
  });

  await session.prompt(`${sentinels.message}: invoke the foreground child now`);
  const toolRecord = service.listAgents().find((record) => record.task === tasks.tool);
  assert(
    toolRecord?.status === "completed",
    `Foreground tool child did not complete: ${JSON.stringify({ records: service.listAgents(), tools: requests[0]?.tools?.map((tool) => tool.name), messages: session.messages })}`,
  );
  assert(
    toolRecord.result.includes(workspaceMarker),
    "Foreground tool did not use the child workspace",
  );

  await session.prompt(`${sentinels.backgroundMessage}: launch the background child now`);
  const backgroundToolRecord = await waitFor(
    () =>
      service
        .listAgents()
        .find((record) => record.task === tasks.backgroundTool && record.status === "completed"),
    "background tool child",
  );
  assert(
    backgroundToolRecord.result.includes(workspaceMarker),
    "Background tool did not use the child workspace",
  );

  const nativeNow = Date.now;
  Date.now = () => nativeNow() + 61_000;
  try {
    await waitFor(
      () => service.inspect(toolRecord.id)?.conversation === undefined,
      "consumed session retention release",
    );
  } finally {
    Date.now = nativeNow;
  }
  const reconstructed = await service.resume({ id: toolRecord.id, task: tasks.resume });
  assert(
    reconstructed?.result.includes("resumed from child history only"),
    "Released child was not reconstructed from its JSONL",
  );

  const foregroundId = service.spawn({
    type: "actual-pi",
    task: tasks.foreground,
    description: "service foreground",
    stack: "deep",
    foreground: true,
  });
  await waitFor(() => service.inspect(foregroundId)?.status === "completed", "service foreground");
  assert(
    service.inspect(foregroundId)?.stack === "deep" &&
      service.inspect(foregroundId)?.model === "roster-faux/roster-faux-deep",
    "Foreground service run lost its explicit deep stack/model",
  );

  const backgroundId = service.spawn({
    type: "actual-pi",
    task: tasks.background,
    description: "service background",
    stack: "fast",
  });
  await backgroundObserved;
  const queuedId = service.spawn({
    type: "actual-pi",
    task: tasks.queued,
    description: "delayed queued",
  });
  await waitFor(() => service.inspect(queuedId)?.status === "queued", "queued admission");
  assert(
    !requests.some((context) => contextText(context).includes(tasks.queued)),
    "Queued child reached the model before admission",
  );
  assert(await service.steer(backgroundId, steering), "Steering was rejected");
  await service.waitForAll();
  assert(
    service.inspect(backgroundId)?.status === "completed",
    "Background child did not complete",
  );
  assert(
    service.inspect(backgroundId)?.stack === "fast" &&
      service.inspect(backgroundId)?.model === "roster-faux/roster-faux-model",
    "Background service run lost its explicit fast stack/model",
  );
  assert(
    service.inspect(queuedId)?.status === "completed",
    "Queued child was not admitted after the slot settled",
  );

  const resumed = await service.resume({ id: backgroundId, task: tasks.resume });
  assert(
    resumed?.result.includes("resumed from child history only"),
    "Resume did not use the child session",
  );

  const records = service.listAgents();
  const internalManager = service.manager;
  assert(internalManager?.getRecord, "Installed service did not retain its Pi record manager");
  const transcripts = records.map((record) => {
    assert(record.transcriptPath, `Missing transcript for ${record.id}`);
    const jsonl = readFileSync(record.transcriptPath, "utf8");
    const header = JSON.parse(jsonl.split("\n").find(Boolean));
    const internalRecord = internalManager.getRecord(record.id);
    const sessionId = internalRecord?.childSessionId;
    assert(sessionId, `Internal record omitted child session identity for ${record.id}`);
    assert(header.id === sessionId, `JSONL and record session identities differ for ${record.id}`);
    assert(
      lifecycle.some(
        (entry) =>
          entry.channel === "subagents:child:session-created" && entry.data.sessionId === sessionId,
      ),
      `Session registry entry omitted canonical identity ${sessionId}`,
    );
    return { record, internalRecord, sessionId, jsonl };
  });

  const { InvocationRowComponent } = await jiti.import(
    join(installedPackage, "src", "tools", "invocation-row.ts"),
  );
  const identitySample = transcripts.find(({ record }) => record.id === foregroundId);
  assert(identitySample, "Missing foreground identity sample");
  const plainTheme = { fg: (_style, text) => text, bold: (text) => text };
  const rowDetails = {
    displayName: "actual-pi",
    description: identitySample.record.description,
    task: identitySample.record.task,
    subagentType: "actual-pi",
    isBackground: false,
    stack: identitySample.record.stack,
    modelName: identitySample.record.model,
    thinking: identitySample.record.thinking,
    maxTurns: undefined,
    graceTurns: undefined,
    toolUses: identitySample.record.toolUses,
    tokens: "",
    durationMs: 1,
    status: identitySample.record.status,
    agentId: identitySample.record.id,
    childSessionId: identitySample.sessionId,
  };
  const row = new InvocationRowComponent(
    "installed-headless-row",
    rowDetails,
    identitySample.record.result ?? "",
    plainTheme,
    undefined,
    (id) => (id === identitySample.record.id ? identitySample.internalRecord : undefined),
  );
  row.update(rowDetails, identitySample.record.result ?? "", true, plainTheme);
  const expandedRow = row.render(160).join("\n");
  assert(
    expandedRow.includes(`Child session ID: ${identitySample.sessionId}`),
    "Expanded invocation row lost the canonical child session ID",
  );
  assert(
    expandedRow.includes("Task: SERVICE_FOREGROUND_TASK_a921"),
    "Expanded invocation row omitted task semantics",
  );
  assert(
    expandedRow.includes("Agent: actual-pi") &&
      expandedRow.includes("Foreground") &&
      expandedRow.includes("stack: deep") &&
      expandedRow.includes("model: roster-faux/roster-faux-deep") &&
      expandedRow.includes("thinking: —"),
    `Expanded invocation row omitted invocation semantics: ${expandedRow}`,
  );
  assert(
    expandedRow.includes("Read-only transcript: /subagents:sessions"),
    "Expanded invocation row omitted transcript ownership hint",
  );
  const workspacePrepares = workspaceCalls.filter((call) => "agentId" in call);
  const workspaceDisposals = workspaceCalls.filter((call) => "disposed" in call);
  const resumeCount = 2;
  assert(
    workspacePrepares.length === records.length + resumeCount &&
      workspaceDisposals.length === records.length + resumeCount,
    "Workspace prepare/dispose did not bracket every child run and resume",
  );
  assert(
    new Set(workspacePrepares.map((call) => call.cwd)).size === workspacePrepares.length,
    "Workspace resumes reused a cwd",
  );
  assert(
    workspacePrepares.every((call) => call.baseCwd === workDir),
    "Workspace provider lost the configured base cwd",
  );

  assertNoParentSentinels(workspaceCalls, "workspace provider context");
  const childRequests = requests.filter(
    (context) =>
      !context.tools?.some((tool) =>
        ["subagent", "get_subagent_result", "steer_subagent"].includes(tool.name),
      ),
  );
  assert(childRequests.length >= 7, "Expected actual child and resumed model requests");
  for (const context of childRequests) {
    assertNoParentSentinels(context, "child model request");
    assert(
      context.tools?.every(
        (tool) => !["subagent", "get_subagent_result", "steer_subagent"].includes(tool.name),
      ),
      "Recursive managed tool reached a child request",
    );
    assert(
      context.tools?.some((tool) => tool.name === "read"),
      "Configured child read tool was unavailable",
    );
  }
  const resumedRequests = childRequests.filter((context) =>
    contextText(context).includes(tasks.resume),
  );
  assert(resumedRequests.length === 2, "Expected retained and reconstructed resume requests");
  assert(
    resumedRequests.some((context) => {
      const text = contextText(context);
      return text.includes(tasks.tool) && text.includes(workspaceMarker);
    }),
    "Reconstructed request omitted persisted child history",
  );
  assert(
    resumedRequests.some((context) => {
      const text = contextText(context);
      return text.includes(tasks.background) && text.includes(steering);
    }),
    "Retained resume omitted child-owned history or steering",
  );

  for (const { record, jsonl } of transcripts) {
    assertNoParentSentinels(record, "service record");
    assertNoParentSentinels(jsonl, "child JSONL");
    assert(jsonl.includes(record.task), `Child JSONL omitted explicit task for ${record.id}`);
  }

  const order = lifecycle.map((entry) => entry.channel);
  const spawning = order.indexOf("subagents:child:spawning");
  const created = order.indexOf("subagents:child:session-created");
  const completed = order.indexOf("subagents:child:completed");
  assert(
    spawning >= 0 && spawning < created && created < completed,
    "Child creation/completion lifecycle was out of order",
  );
  assert(
    lifecycle.some((entry) => entry.channel === "subagents:resumed"),
    "Actual resume event was not published",
  );

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  const createdSessionCount = lifecycle.filter(
    (entry) => entry.channel === "subagents:child:session-created",
  ).length;
  await waitFor(
    () =>
      lifecycle.filter((entry) => entry.channel === "subagents:child:disposed").length ===
      createdSessionCount,
    "child disposal on parent shutdown",
  );
  const firstCompleted = order.indexOf("subagents:child:completed");
  const firstDisposed = lifecycle.findIndex(
    (entry) => entry.channel === "subagents:child:disposed",
  );
  assert(firstDisposed > firstCompleted, "A child session was disposed before its run completed");
  assert(
    globalThis[Symbol.for("pi-agent-roster:service")] === undefined,
    "Service remained published after shutdown",
  );
  const observedSessions = globalThis[Symbol.for("pi-agent-roster:installed-observer")] ?? [];
  const childWorkspacePrefix = childWorkDir + sep;
  const childStarts = observedSessions.filter(
    (entry) => entry.type === "start" && entry.cwd.startsWith(childWorkspacePrefix),
  );
  const childShutdowns = observedSessions.filter(
    (entry) => entry.type === "shutdown" && entry.cwd.startsWith(childWorkspacePrefix),
  );
  assert(
    childStarts.length === createdSessionCount,
    `Actual child session_start count did not match created sessions: ${JSON.stringify({ createdSessionCount, observedSessions })}`,
  );
  assert(
    childShutdowns.length === createdSessionCount,
    `Actual child session_shutdown count did not match disposed sessions: ${JSON.stringify({ createdSessionCount, observedSessions })}`,
  );
  assert(
    childStarts.every((entry) => entry.tools.includes("read")),
    "Child session_start lacked configured read access",
  );
  assert(
    childStarts.every((entry) =>
      ["subagent", "get_subagent_result", "steer_subagent"].every(
        (name) => !entry.tools.includes(name),
      ),
    ),
    "Recursive managed tools were active in a child session",
  );
  const childHookEntries = observedSessions.filter(
    (entry) => entry.type === "before" && entry.cwd.startsWith(childWorkspacePrefix),
  );
  assert(
    childHookEntries.length >= records.length,
    "Child before_agent_start hooks were not observable",
  );
  assertNoParentSentinels(childHookEntries, "child extension hook callback");
  assert(
    childStarts.every((entry) => entry.prompt.includes("PROJECT_AGENT_PROMPT_594a")),
    "Child session hook did not observe the project-layer prompt override",
  );

  console.log(
    "Actual Pi layering, classifications, lifecycle, isolation, stacks, invocation-row, identity, steering, resume, persistence, and shutdown checks passed.",
  );
} finally {
  session.dispose();
  eventBus.clear();
}
