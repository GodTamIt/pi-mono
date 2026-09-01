import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KEYBINDINGS } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ToolExecutionComponent } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { AgentTool } from "../../src/tools/agent-tool.ts";
import { GetResultTool } from "../../src/tools/get-result-tool.ts";
import { InvocationRowRegistry } from "../../src/tools/invocation-row.ts";
import type { AgentDetails } from "../../src/ui/display.ts";
import { createToolDeps } from "../helpers/make-deps.ts";
import { createTestSubagent } from "../helpers/make-subagent.ts";
import {
  createMockSession,
  createSubagentSessionStub,
  toSubagentSession,
} from "../helpers/mock-session.ts";

beforeAll(() => initTheme(undefined, false));

function details(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    displayName: "Architect 🧭",
    description: "inspect lifecycle",
    task: "Inspect the child lifecycle exactly.",
    subagentType: "Architect",
    isBackground: true,
    stack: "deep",
    modelName: "sonnet",
    thinking: "high",
    maxTurns: 20,
    graceTurns: 2,
    toolUses: 0,
    tokens: "",
    durationMs: 250,
    status: "running",
    agentId: "agent-1",
    ...overrides,
  };
}

function text(component: ToolExecutionComponent, width = 120): string {
  return stripTerminalSequences(component.render(width).join("\n"));
}

function baseline(component: ToolExecutionComponent, width = 120): string {
  const lines = component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const indentation = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^ */)?.[0].length ?? 0),
  );
  return lines.map((line) => line.slice(indentation)).join("\n");
}

function standaloneHost(overrides: Partial<AgentDetails> = {}, output = "child output") {
  const deps = createToolDeps();
  deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
  const definition = new AgentTool(
    deps.manager,
    deps.runtime,
    deps.settings,
    deps.registry,
    deps.agentDir,
  ).toToolDefinition();
  const host = new ToolExecutionComponent(
    "subagent",
    "tc-baseline",
    { task: "Inspect the child lifecycle exactly.", subagent_type: "Architect" },
    {},
    definition,
    { requestRender: vi.fn() } as never,
    process.cwd(),
  );
  const resultDetails = details({ agentId: undefined, ...overrides });
  host.updateResult({
    content: [{ type: "text", text: output }],
    details: resultDetails,
    isError: resultDetails.status === "error",
  });
  return host;
}

describe("native subagent invocation row", () => {
  it("uses the same host-owned status shell as get_subagent_result", () => {
    const deps = createToolDeps();
    const subagentDefinition = new AgentTool(
      deps.manager,
      deps.runtime,
      deps.settings,
      deps.registry,
      deps.agentDir,
    ).toToolDefinition();
    const getResultDefinition = new GetResultTool(deps.manager, deps.registry).toToolDefinition();
    const requestRender = vi.fn();
    const subagent = new ToolExecutionComponent(
      "subagent",
      "tc-shell-subagent",
      { task: "Inspect the shell.", subagent_type: "Architect" },
      {},
      subagentDefinition,
      { requestRender } as never,
      process.cwd(),
    );
    const getResult = new ToolExecutionComponent(
      "get_subagent_result",
      "tc-shell-result",
      { agent_id: "agent-1" },
      {},
      getResultDefinition,
      { requestRender } as never,
      process.cwd(),
    );
    const shellFrame = (component: ToolExecutionComponent) =>
      component.render(72).find((line) => line.length > 0);

    const pendingFrame = shellFrame(subagent);
    expect(pendingFrame).toBe(shellFrame(getResult));
    expect(baseline(subagent)).toBe("Subagent");

    subagent.updateResult({
      content: [{ type: "text", text: "done" }],
      details: details({ status: "completed", agentId: undefined }),
      isError: false,
    });
    getResult.updateResult({
      content: [{ type: "text", text: "Status: completed" }],
      isError: false,
    });

    const successFrame = shellFrame(subagent);
    expect(successFrame).toBe(shellFrame(getResult));
    expect(successFrame).not.toBe(pendingFrame);

    subagent.updateResult({
      content: [{ type: "text", text: "failed" }],
      details: details({ status: "error", agentId: undefined }),
      isError: true,
    });
    getResult.updateResult({
      content: [{ type: "text", text: "failed" }],
      isError: true,
    });

    expect(shellFrame(subagent)).toBe(shellFrame(getResult));
    expect(shellFrame(subagent)).not.toBe(successFrame);
    expect(
      subagent
        .render(72)
        .slice(1)
        .every((line) => visibleWidth(line) === 72),
    ).toBe(true);
  });

  it("pins collapsed lifecycle rows", () => {
    const statuses: AgentDetails["status"][] = [
      "queued",
      "running",
      "completed",
      "steered",
      "aborted",
      "stopped",
      "error",
    ];
    const rows = Object.fromEntries(
      statuses.map((status) => [status, baseline(standaloneHost({ status }))]),
    );

    expect(rows.running).toContain("Architect 🧭 · ▸ running");
    expect(rows.running).toContain("Summary: inspect lifecycle");
    expect(rows.running).toContain("Activity: thinking…");
    expect(rows.completed).toContain("Activity: completed");
    expect(rows.error).toContain("Activity: failed");
  });

  it("uses the host-owned Ctrl+O expansion state for the native detail view", () => {
    expect(KEYBINDINGS["app.tools.expand"].defaultKeys).toBe("ctrl+o");
    const host = standaloneHost({
      status: "completed",
      agentId: "agent-restored",
      task: "Inspect the child lifecycle exactly.",
      childSessionId: "child-restored",
      turnCount: 7,
      maxTurns: 20,
      graceTurns: 2,
      toolUses: 4,
      tokens: "12.3k tokens",
      compactions: 1,
      output: "A compact final answer.",
    });

    const collapsed = baseline(host, 76);
    host.setExpanded(true);
    const expanded = baseline(host, 76);

    expect(collapsed).toContain("Summary: inspect lifecycle");
    expect(collapsed).toContain("Activity: completed");
    expect(expanded).toContain("Task\n  Inspect the child lifecycle exactly.");
    expect(expanded).toContain("Current/final output\n  A compact final answer.");
    expect(expanded).toContain("Turns: 7/20 · grace: 2 · tool uses: 4");
    expect(collapsed).not.toContain("\nTask\n");
  });

  it("shows unlimited budgets explicitly in the expanded view", () => {
    const host = standaloneHost({
      status: "running",
      turnCount: 3,
      maxTurns: undefined,
      graceTurns: undefined,
    });
    host.setExpanded(true);

    expect(baseline(host, 80)).toContain("Turns: 3/unlimited · grace: unlimited · tool uses: 0");
  });

  it("retains the renderer component and invalidates it from one child subscription", () => {
    const child = createMockSession({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
        },
      ],
    });
    const firstSession = createSubagentSessionStub(child, "/tmp/child.jsonl", "child-1");
    firstSession.getConversation.mockReturnValue("[User]: hidden background transcript");
    const record = createTestSubagent({
      status: "running",
      startedAt: Date.now() - 250,
      toolCallId: "tc-host",
      invocation: {
        runInBackground: true,
        stack: "deep",
        modelName: "sonnet",
        thinking: "high",
        maxTurns: 20,
        graceTurns: 2,
      },
      execution: {
        ...createTestSubagent().execution,
        task: "Inspect the child lifecycle exactly.",
        isBackground: true,
        parentSession: { toolCallId: "tc-host" },
        maxTurns: 20,
        graceTurns: 2,
      },
    });
    record.subagentSession = toSubagentSession(firstSession);

    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn((id: string) => (id === record.id ? record : undefined));
    const rows = new InvocationRowRegistry((id) => deps.manager.getRecord(id));
    const definition = new AgentTool(
      deps.manager,
      deps.runtime,
      deps.settings,
      deps.registry,
      deps.agentDir,
      {},
      rows,
    ).toToolDefinition();
    const requestRender = vi.fn();
    const host = new ToolExecutionComponent(
      "subagent",
      "tc-host",
      { task: record.task, subagent_type: "Architect", run_in_background: true },
      {},
      definition,
      { requestRender } as never,
      process.cwd(),
    );

    host.setArgsComplete();
    host.markExecutionStarted();
    host.updateResult({
      content: [{ type: "text", text: "launch metadata" }],
      details: details(),
      isError: false,
    });
    rows.onSubagentSessionCreated(record);
    rows.onSubagentSessionCreated(record);
    expect(firstSession.subscribe).toHaveBeenCalledOnce();
    expect(baseline(host)).toContain("Subagent\nArchitect 🧭 · ▸ running");
    expect(text(host)).toContain("Background · stack deep · model sonnet · thinking high");

    const beforeEvent = requestRender.mock.calls.length;
    child.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "read-2" });
    expect(requestRender.mock.calls.length).toBeGreaterThan(beforeEvent);

    host.setExpanded(true);
    const expanded = baseline(host);
    expect(expanded).toContain("Task\n  Inspect the child lifecycle exactly.");
    expect(expanded).toContain("Agent ID: agent-1");
    expect(expanded).toContain("Child session ID: child-1");
    expect(expanded).toContain("⎿ tool · read");
    expect(expanded).toContain("Read-only transcript · /subagents:sessions");
    expect(expanded).not.toContain("hidden background transcript");
    host.setExpanded(false);
    expect(text(host)).not.toContain("\nTask\n");

    const replacement = createMockSession();
    const secondSession = createSubagentSessionStub(replacement, "/tmp/child.jsonl", "child-2");
    record.subagentSession = toSubagentSession(secondSession);
    rows.onSubagentSessionCreated(record);
    expect(secondSession.subscribe).toHaveBeenCalledOnce();
    host.setExpanded(true);
    expect(text(host)).not.toContain("tool · read");
    const afterReplacement = requestRender.mock.calls.length;
    child.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "old" });
    expect(requestRender).toHaveBeenCalledTimes(afterReplacement);
    replacement.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "new" });
    expect(requestRender.mock.calls.length).toBeGreaterThan(afterReplacement);
    expect(text(host)).toContain("tool · bash");

    record.markCompleted("final output", Date.now());
    rows.onSubagentCompleted(record);
    const afterCompletion = requestRender.mock.calls.length;
    replacement.emit({ type: "tool_execution_start", toolName: "edit", toolCallId: "late" });
    expect(requestRender).toHaveBeenCalledTimes(afterCompletion);
    expect(text(host)).toContain("completed");

    rows.dispose();
    replacement.emit({ type: "tool_execution_start", toolName: "write", toolCallId: "shutdown" });
    expect(requestRender).toHaveBeenCalledTimes(afterCompletion);
  });

  it("inlines a retained foreground conversation only after completion", () => {
    const session = createSubagentSessionStub(
      createMockSession(),
      "/tmp/foreground.jsonl",
      "child-foreground",
    );
    session.getConversation.mockReturnValue(
      "[User]: inspect the implementation\n[Assistant]: verified \x1b[31mthe behavior\x1b[0m",
    );
    const record = createTestSubagent({
      status: "running",
      toolCallId: "tc-inline",
      description: "verify implementation",
      execution: {
        ...createTestSubagent().execution,
        task: "Inspect every implementation detail.",
        isBackground: false,
        parentSession: { toolCallId: "tc-inline" },
      },
    });
    record.subagentSession = toSubagentSession(session);

    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn((id: string) => (id === record.id ? record : undefined));
    const rows = new InvocationRowRegistry((id) => deps.manager.getRecord(id));
    const definition = new AgentTool(
      deps.manager,
      deps.runtime,
      deps.settings,
      deps.registry,
      deps.agentDir,
      {},
      rows,
    ).toToolDefinition();
    const host = new ToolExecutionComponent(
      "subagent",
      "tc-inline",
      { task: record.task, description: record.description, subagent_type: "Architect" },
      {},
      definition,
      { requestRender: vi.fn() } as never,
      process.cwd(),
    );
    host.updateResult({
      content: [{ type: "text", text: "Agent completed.\n\nfinal output" }],
      details: details({
        status: "running",
        isBackground: false,
        agentId: record.id,
        description: record.description,
      }),
      isError: false,
    });
    host.setExpanded(true);
    expect(baseline(host)).not.toContain("Child conversation");

    record.markCompleted("final output", Date.now());
    rows.onSubagentCompleted(record);
    const expanded = baseline(host);
    expect(expanded).toContain("Child conversation");
    expect(expanded).toContain("[User]: inspect the implementation");
    expect(expanded).toContain("[Assistant]: verified the behavior");
    expect(expanded).not.toContain("\u001b");
    expect(expanded).toContain("Task\n  Inspect every implementation detail.");
  });

  it("caps retained bindings at 128 and evicts the oldest row", () => {
    const invalidates = Array.from({ length: 129 }, () => vi.fn());
    const rows = new InvocationRowRegistry(() => undefined);
    for (let index = 0; index < invalidates.length; index++) {
      const invalidate = invalidates[index];
      if (!invalidate) throw new Error("missing invalidation fixture");
      rows.bind(`tc-${index}`, `agent-${index}`, invalidate);
    }

    rows.onSubagentCreated(
      createTestSubagent({ id: "agent-0", status: "queued", toolCallId: "tc-0" }),
    );
    rows.onSubagentCreated(
      createTestSubagent({ id: "agent-1", status: "queued", toolCallId: "tc-1" }),
    );
    rows.onSubagentCreated(
      createTestSubagent({ id: "agent-128", status: "queued", toolCallId: "tc-128" }),
    );

    expect(invalidates[0]).not.toHaveBeenCalled();
    expect(invalidates[1]).toHaveBeenCalledOnce();
    expect(invalidates[128]).toHaveBeenCalledOnce();

    const settledRows = new InvocationRowRegistry(() => undefined);
    for (let index = 0; index < 129; index++) {
      const record = createTestSubagent({
        id: `settled-${index}`,
        status: "queued",
        toolCallId: `settled-tc-${index}`,
        description: `task ${index}`,
      });
      settledRows.bind(`settled-tc-${index}`, record.id, vi.fn());
      settledRows.onSubagentCreated(record);
      record.markCompleted(`result ${index}`);
      settledRows.onSubagentCompleted(record);
    }
    expect(settledRows.getActivity("settled-tc-0", "settled-0")).toEqual([]);
    expect(settledRows.getActivity("settled-tc-1", "settled-1")).toEqual([
      "queued · task 1",
      "completed",
    ]);
  });

  it("retains only the latest 40 child-activity rows", () => {
    const child = createMockSession();
    const session = createSubagentSessionStub(child, "/tmp/child.jsonl", "child-activity");
    const record = createTestSubagent({ status: "running", toolCallId: "tc-activity" });
    record.subagentSession = toSubagentSession(session);
    const rows = new InvocationRowRegistry((id) => (id === record.id ? record : undefined));
    rows.bind("tc-activity", record.id, vi.fn());

    for (let index = 0; index < 45; index++) {
      child.emit({
        type: "tool_execution_start",
        toolName: `tool-${index}`,
        toolCallId: `child-tool-${index}`,
      });
    }

    const activity = rows.getActivity("tc-activity", record.id);
    expect(activity).toHaveLength(40);
    expect(activity[0]).toBe("tool · tool-5");
    expect(activity.at(-1)).toBe("tool · tool-44");
  });

  it("shows the complete expanded output", () => {
    const output = Array.from({ length: 55 }, (_, index) => `output-${index + 1}`).join("\n");
    const host = standaloneHost({ status: "completed" }, output);
    host.setExpanded(true);
    const expanded = baseline(host);
    const outputRows = expanded.split("\n").filter((line) => /^output-\d+$/.test(line.trim()));

    expect(outputRows).toHaveLength(55);
    expect(outputRows[0]?.trim()).toBe("output-1");
    expect(outputRows.at(-1)?.trim()).toBe("output-55");
    expect(expanded).not.toContain("output truncated");
  });

  it("sanitizes terminal controls and wraps Unicode expanded output to the host width", () => {
    const host = standaloneHost(
      { status: "completed" },
      `\x1b[31mred\x1b[0m\bX\r\n${"界🚀".repeat(20)}\t`,
    );
    host.setExpanded(true);
    const lines = host.render(24);
    const expanded = baseline(host, 24);

    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(expanded).toContain("redX");
    expect(expanded).not.toContain("\b");
    expect(expanded).not.toContain("\r");
    expect(expanded).not.toContain("\t");
    expect(expanded).not.toContain("\u001b");
  });

  it("releases a foreground row subscription when its final result settles", () => {
    const child = createMockSession();
    const session = createSubagentSessionStub(child, "/tmp/child.jsonl", "child-1");
    const record = createTestSubagent({ status: "running", toolCallId: "tc-foreground" });
    record.subagentSession = toSubagentSession(session);
    const invalidate = vi.fn();
    const rows = new InvocationRowRegistry((id) => (id === record.id ? record : undefined));

    rows.bind("tc-foreground", record.id, invalidate);
    expect(session.subscribe).toHaveBeenCalledOnce();

    record.markCompleted("final output", Date.now());
    rows.bind("tc-foreground", record.id, invalidate);
    child.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "late" });

    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["queued", "queued"],
    ["running", "running"],
    ["completed", "completed"],
    ["steered", "completed (turn limit)"],
    ["aborted", "aborted (max turns)"],
    ["stopped", "stopped"],
    ["error", "failed"],
  ] as const)("maps %s to %s", (status, expected) => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
    const definition = new AgentTool(
      deps.manager,
      deps.runtime,
      deps.settings,
      deps.registry,
      deps.agentDir,
    ).toToolDefinition();
    const host = new ToolExecutionComponent(
      "subagent",
      `tc-${status}`,
      { task: "task", subagent_type: "Architect" },
      {},
      definition,
      { requestRender: vi.fn() } as never,
      process.cwd(),
    );
    host.updateResult({
      content: [{ type: "text", text: "output" }],
      details: details({ agentId: undefined, status }),
      isError: status === "error",
    });
    expect(baseline(host).split("\n")[1]?.endsWith(expected)).toBe(true);
  });

  it("wraps ANSI and Unicode safely and handles records absent after restoration", () => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
    const rows = new InvocationRowRegistry((id) => deps.manager.getRecord(id));
    const definition = new AgentTool(
      deps.manager,
      deps.runtime,
      deps.settings,
      deps.registry,
      deps.agentDir,
      {},
      rows,
    ).toToolDefinition();
    const host = new ToolExecutionComponent(
      "subagent",
      "tc-unknown",
      { task: "未知 task", subagent_type: "Architect" },
      {},
      definition,
      { requestRender: vi.fn() } as never,
      process.cwd(),
    );
    host.updateResult({
      content: [{ type: "text", text: "fallback output" }],
      details: details({ agentId: "missing", task: "未知 task", status: "completed" }),
      isError: false,
    });

    for (const width of [40, 60, 80, 120]) {
      for (const line of host.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(baseline(host, 40)).toContain("Summary: inspect lifecycle");
    expect(baseline(host, 40)).toContain("Activity: completed");
    host.setExpanded(true);
    expect(text(host)).toContain("Agent ID: missing");
    expect(text(host)).toContain("Child session ID: not available");
    expect(text(host)).toContain("fallback output");
  });
});
