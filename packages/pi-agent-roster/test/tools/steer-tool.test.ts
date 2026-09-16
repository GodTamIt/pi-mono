import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  SteerTool,
  type SteerToolEvents,
  type SteerToolManager,
} from "../../src/tools/steer-tool.ts";
import type { Subagent } from "../../src/types.ts";
import { createTestSubagent } from "../helpers/make-subagent.ts";
import {
  createMockSession,
  createSubagentSessionStub,
  toSubagentSession,
} from "../helpers/mock-session.ts";
import { STUB_CTX } from "../helpers/stub-ctx.ts";

function makeManager(records: Map<string, Subagent> = new Map()): SteerToolManager {
  return {
    getRecord: (id: string) => records.get(id),
  };
}

function makeEvents(): SteerToolEvents {
  return { emit: vi.fn() };
}

async function execute(
  manager: SteerToolManager,
  events: SteerToolEvents,
  params: { agent_id: string; steering: string },
) {
  const tool = new SteerTool(manager, events);
  return tool.execute("tc-1", params, new AbortController().signal, undefined, STUB_CTX);
}

const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function renderCall(args: Record<string, unknown> | undefined, width = 120): string {
  const def = new SteerTool(makeManager(), makeEvents()).toToolDefinition();
  const renderer = def.renderCall;
  if (!renderer) throw new Error("renderCall missing");
  return renderer(args as never, PLAIN_THEME as never, {} as never)
    .render(width)
    .join("\n");
}

describe("SteerTool", () => {
  it("returns tool definition with correct name", () => {
    const tool = new SteerTool(makeManager(), makeEvents());
    expect(tool.toToolDefinition().name).toBe("steer_subagent");
  });

  it("includes promptSnippet", () => {
    const tool = new SteerTool(makeManager(), makeEvents());
    expect(tool.toToolDefinition().promptSnippet).toBe(
      "Send a mid-run message to redirect a running background agent.",
    );
  });

  it("shows the target and a bounded steering preview in the call slot", () => {
    const text = renderCall({ agent_id: "agent-1", steering: "change design" });
    expect(text).toContain("Steer Agent");
    expect(text).toContain("agent-1");
    expect(text).toContain('"change design"');
  });

  it("bounds long previews and sanitizes terminal controls in displayed args", () => {
    const bounded = renderCall({ agent_id: "agent-1", steering: "x".repeat(200) });
    expect(bounded).toContain(`${"x".repeat(80)}…`);
    expect(bounded).not.toContain("x".repeat(81));

    const hostile =
      "npm WARN \u001b[31mdeprecated\u001b[0m\u001b]0;title\u0007" +
      "\u001b[3Aoverwrite\rprogress\b!";
    const safe = renderCall({ agent_id: "a\u001b[2Jgent-1", steering: hostile });
    expect(safe).toContain("agent-1");
    expect(safe).toContain("npm WARN deprecatedoverwriteprogress!");
    for (const control of ["\u001b", "\r", "\b", "\u0007", "\u009b"]) {
      expect(safe).not.toContain(control);
    }
  });

  it("renders partial or missing call args without failing", () => {
    expect(renderCall({ agent_id: "agent-1" })).toContain("agent-1");
    expect(renderCall({ steering: "later" })).toContain('"later"');
    expect(renderCall(undefined)).toContain("Steer Agent");
    expect(renderCall({})).not.toContain("undefined");
  });

  it("wraps the call preview within narrow widths", () => {
    const text = renderCall(
      { agent_id: "agent-1", steering: "a long steering message ".repeat(20) },
      20,
    );
    expect(text.split("\n").every((line) => visibleWidth(line) <= 20)).toBe(true);
  });

  it("requires explicit non-empty steering and rejects undeclared context fields", () => {
    const parameters = new SteerTool(makeManager(), makeEvents()).toToolDefinition().parameters;
    expect(Object.keys(parameters.properties)).toEqual(["agent_id", "steering"]);
    expect(parameters.properties.steering.description).toContain("child's own conversation");
    expect(Value.Check(parameters, { agent_id: "agent-1", steering: "Check the parser" })).toBe(
      true,
    );
    expect(Value.Check(parameters, { agent_id: "agent-1", steering: "  " })).toBe(false);
    expect(
      Value.Check(parameters, {
        agent_id: "agent-1",
        steering: "Check the parser",
        inherit_context: true,
      }),
    ).toBe(false);
  });

  it("returns not-found message for unknown agent ID without claiming cleanup", async () => {
    const result = await execute(makeManager(), makeEvents(), {
      agent_id: "unknown",
      steering: "hi",
    });
    expect(result.content[0]?.text).toContain("Agent not found");
    expect(result.content[0]?.text).not.toContain("cleaned up");
  });

  it("rejects steering a non-running agent", async () => {
    const records = new Map([["agent-1", createTestSubagent({ status: "completed" })]]);
    const result = await execute(makeManager(records), makeEvents(), {
      agent_id: "agent-1",
      steering: "hi",
    });
    expect(result.content[0]?.text).toContain("not running");
    expect(result.content[0]?.text).toContain("completed");
  });

  it("queues steer when session is not ready", async () => {
    // No execution state set — session not yet created
    const record = createTestSubagent({ status: "running" });
    const records = new Map([["agent-1", record]]);
    const manager = makeManager(records);
    const events = makeEvents();
    const result = await execute(manager, events, { agent_id: "agent-1", steering: "redirect" });
    expect(result.content[0]?.text).toContain("queued");
    expect(record.pendingSteerCount).toBe(1);
    expect(events.emit).toHaveBeenCalledWith("subagents:steered", {
      id: "agent-1",
      steering: "redirect",
    });
  });

  it("sends steer and emits event on success", async () => {
    const record = createTestSubagent({ status: "running" });
    const mockSession = createMockSession();
    record.subagentSession = toSubagentSession(createSubagentSessionStub(mockSession));
    const records = new Map([["agent-1", record]]);
    const manager = makeManager(records);
    const events = makeEvents();
    const result = await execute(manager, events, {
      agent_id: "agent-1",
      steering: "change design",
    });
    expect(mockSession.steer).toHaveBeenCalledWith("change design");
    expect(events.emit).toHaveBeenCalledWith("subagents:steered", {
      id: "agent-1",
      steering: "change design",
    });
    expect(result.content[0]?.text).toContain("Steering message sent");
    expect(result.content[0]?.text).toContain("3 tool uses");
    // Steering text lives only in the TUI call row; the model-facing result is unchanged.
    expect(result.content[0]?.text).not.toContain("change design");
    expect(result.details).toBeUndefined();
  });

  it("returns error message when steer fails", async () => {
    const record = createTestSubagent({ status: "running" });
    const mockSession = createMockSession();
    mockSession.steer.mockRejectedValue(new Error("session closed"));
    record.subagentSession = toSubagentSession(createSubagentSessionStub(mockSession));
    const records = new Map([["agent-1", record]]);
    const result = await execute(makeManager(records), makeEvents(), {
      agent_id: "agent-1",
      steering: "hi",
    });
    expect(result.content[0]?.text).toContain("Failed to steer agent");
    expect(result.content[0]?.text).toContain("session closed");
  });
});
