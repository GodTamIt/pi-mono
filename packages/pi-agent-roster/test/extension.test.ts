import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.ts";
import {
  PRIMARY_AGENT_FLAG,
  PRIMARY_STACK_FLAG,
  ROSTER_NAME_FLAG,
  ROSTER_NOOP_TOOL,
  ROSTER_STATUS_COMMAND,
} from "../src/public.ts";

function loadExtension() {
  let tool: ToolDefinition | undefined;
  let command: { handler: (args: string, ctx: never) => Promise<void> } | undefined;
  const pi = {
    registerFlag: vi.fn(),
    registerTool: vi.fn((registered) => {
      tool = registered;
    }),
    registerCommand: vi.fn((_name, registered) => {
      command = registered;
    }),
    getFlag: vi.fn(() => "test"),
    getAllTools: vi.fn(() => [{ name: ROSTER_NOOP_TOOL }]),
  } as unknown as ExtensionAPI;

  extension(pi);
  return { pi, getTool: () => tool, getCommand: () => command };
}

describe("pi-agent-roster extension", () => {
  it("registers its public flag, command, and TypeBox tool", () => {
    const { pi, getTool } = loadExtension();
    const tool = getTool();

    expect(pi.registerFlag).toHaveBeenCalledWith(ROSTER_NAME_FLAG, {
      description: expect.any(String),
      type: "string",
      default: "default",
    });
    expect(pi.registerFlag).toHaveBeenCalledWith(PRIMARY_AGENT_FLAG, {
      description: expect.any(String),
      type: "string",
    });
    expect(pi.registerFlag).toHaveBeenCalledWith(PRIMARY_STACK_FLAG, {
      description: expect.any(String),
      type: "string",
    });
    expect(pi.registerCommand).toHaveBeenCalledWith(
      ROSTER_STATUS_COMMAND,
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(tool?.name).toBe(ROSTER_NOOP_TOOL);
    if (!tool) throw new Error("tool was not registered");
    expect(Value.Check(tool.parameters, {})).toBe(true);
    expect(Value.Check(tool.parameters, { note: 42 })).toBe(false);
  });

  it("executes the no-op tool without changing its input", async () => {
    const { getTool } = loadExtension();
    const result = await getTool()?.execute(
      "call",
      { note: "still here" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "still here" }],
      details: {},
    });
  });

  it("reports the parsed flag and registered tool through its command", async () => {
    const { getCommand } = loadExtension();
    const notify = vi.fn();

    await getCommand()?.handler("", { ui: { notify } } as never);

    expect(notify).toHaveBeenCalledWith("Roster test: roster_noop ready", "info");
  });
});
