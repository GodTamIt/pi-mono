import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.ts";
import { PRIMARY_AGENT_FLAG, PRIMARY_STACK_FLAG } from "../src/public.ts";

function loadExtension() {
  const pi = {
    registerFlag: vi.fn(),
  } as unknown as ExtensionAPI;

  extension(pi);
  return pi;
}

describe("pi-agent-roster extension", () => {
  it("registers only the primary agent and stack flags", () => {
    const pi = loadExtension();

    expect(pi.registerFlag).toHaveBeenCalledTimes(2);
    expect(pi.registerFlag).toHaveBeenNthCalledWith(1, PRIMARY_AGENT_FLAG, {
      description: expect.any(String),
      type: "string",
    });
    expect(pi.registerFlag).toHaveBeenNthCalledWith(2, PRIMARY_STACK_FLAG, {
      description: expect.any(String),
      type: "string",
    });
  });
});
