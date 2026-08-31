import { describe, expect, it, vi } from "vitest";
import {
  composeFooterStatus,
  FooterStatus,
  normalizeTaskSummary,
} from "../../src/ui/footer-status.ts";

describe("normalizeTaskSummary", () => {
  it("sanitizes controls, markdown prefixes, quotes, and whitespace", () => {
    expect(normalizeTaskSummary("\u001b[31m> ## `  Ship\n\tthe footer  `\u001b[0m")).toBe(
      "Ship the footer",
    );
  });

  it("truncates at a word boundary to at most 48 characters", () => {
    expect(normalizeTaskSummary("one two three four five six seven eight nine ten eleven")).toBe(
      "one two three four five six seven eight nine…",
    );
  });

  it("returns undefined for an empty normalized prompt", () => {
    expect(normalizeTaskSummary("  \u001b[2J  ")).toBeUndefined();
  });
});

describe("composeFooterStatus", () => {
  it("joins independently optional segments in canonical order", () => {
    expect(
      composeFooterStatus({
        taskSummary: "Current task",
        primaryName: "Lead Agent",
        stack: "deep",
        runningCount: 2,
        queuedCount: 1,
      }),
    ).toBe("Current task · Lead Agent · stack: deep · agents: 2 running, 1 queued");
    expect(composeFooterStatus({ taskSummary: "Current task", runningCount: 1 })).toBe(
      "Current task · agents: 1 running",
    );
    expect(composeFooterStatus({ primaryName: "Lead Agent", stack: "deep" })).toBe(
      "Lead Agent · stack: deep",
    );
    expect(composeFooterStatus({})).toBeUndefined();
  });
});

describe("FooterStatus", () => {
  it("retains task state while counts transition active to idle and deduplicates updates", () => {
    const setStatus = vi.fn();
    const footer = new FooterStatus();
    footer.attach({ setStatus });
    footer.setTaskPrompt("# Current task");
    footer.setPrimary("Lead Agent", "deep");
    footer.setAgentCounts(2, 1);

    expect(setStatus).toHaveBeenLastCalledWith(
      "subagents",
      "Current task · Lead Agent · stack: deep · agents: 2 running, 1 queued",
    );

    footer.setAgentCounts(0, 0);
    expect(setStatus).toHaveBeenLastCalledWith(
      "subagents",
      "Current task · Lead Agent · stack: deep",
    );
    const calls = setStatus.mock.calls.length;
    footer.setAgentCounts(0, 0);
    expect(setStatus).toHaveBeenCalledTimes(calls);
  });

  it("retains the previous summary for an empty prompt and resets it for a session", () => {
    const setStatus = vi.fn();
    const footer = new FooterStatus();
    footer.attach({ setStatus });
    footer.setTaskPrompt("First task");
    footer.setTaskPrompt("\u001b[2J   ");
    expect(setStatus).toHaveBeenLastCalledWith("subagents", "First task");

    footer.reset();
    expect(setStatus).toHaveBeenLastCalledWith("subagents", undefined);
    expect(setStatus).toHaveBeenCalledWith("primary-agent", undefined);
  });
});
