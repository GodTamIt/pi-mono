import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { extractText } from "../../src/session/context.ts";

describe("extractText", () => {
  it("extracts and joins actual Pi text content blocks", () => {
    const content: UserMessage["content"] = [
      { type: "text", text: "first" },
      { type: "image", data: "ignored", mimeType: "image/png" },
      { type: "text", text: "second" },
    ];
    expect(extractText(content)).toBe("first\nsecond");
  });

  it("ignores thinking and tool calls from an actual assistant content union", () => {
    const content: AssistantMessage["content"] = [
      { type: "thinking", thinking: "private", thinkingSignature: "sig" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "x" } },
      { type: "text", text: "visible" },
    ];
    expect(extractText(content)).toBe("visible");
  });

  it("returns empty text when no text blocks are present", () => {
    expect(extractText([])).toBe("");
    expect(extractText([{ type: "thinking", thinking: "hidden" }])).toBe("");
  });
});
