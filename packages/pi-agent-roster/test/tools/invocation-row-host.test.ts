import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { AgentTool } from "../../src/tools/agent-tool.ts";
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

describe("native subagent invocation row", () => {
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
    expect(text(host)).toContain("Subagent · Architect 🧭 · running");
    expect(text(host)).toContain("Background · stack: deep · model: sonnet · thinking: high");

    const beforeEvent = requestRender.mock.calls.length;
    child.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "read-2" });
    expect(requestRender.mock.calls.length).toBeGreaterThan(beforeEvent);

    host.setExpanded(true);
    const expanded = text(host);
    expect(expanded).toContain("Task: Inspect the child lifecycle exactly.");
    expect(expanded).toContain("Agent ID: agent-1");
    expect(expanded).toContain("Child session ID: child-1");
    expect(expanded).toContain("tool · read");
    expect(expanded).toContain("Read-only transcript: /subagents:sessions");
    host.setExpanded(false);
    expect(text(host)).not.toContain("Task:");

    const replacement = createMockSession();
    const secondSession = createSubagentSessionStub(replacement, "/tmp/child.jsonl", "child-2");
    record.subagentSession = toSubagentSession(secondSession);
    rows.onSubagentSessionCreated(record);
    expect(secondSession.subscribe).toHaveBeenCalledOnce();
    const afterReplacement = requestRender.mock.calls.length;
    child.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "old" });
    expect(requestRender).toHaveBeenCalledTimes(afterReplacement);
    replacement.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "new" });
    expect(requestRender.mock.calls.length).toBeGreaterThan(afterReplacement);

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
    expect(text(host).trimStart().startsWith(`Subagent · Architect 🧭 · ${expected}`)).toBe(true);
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
    host.setExpanded(true);
    expect(text(host)).toContain("Agent ID: missing");
    expect(text(host)).toContain("Child session ID: not available");
    expect(text(host)).toContain("fallback output");
  });
});
