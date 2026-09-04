import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../src/aggregate.ts";

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  detectProvider: vi.fn(),
  fetchQuota: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock("../src/cache.ts", () => ({
  loadScanCache: () => ({ files: {} }),
  saveScanCache: vi.fn(),
}));
vi.mock("../src/config.ts", () => ({
  loadConfig: () => ({}),
  saveConfig: mocks.saveConfig,
}));
vi.mock("../src/aggregate.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/aggregate.ts")>()),
  scanSessions: mocks.scan,
}));
vi.mock("../src/provider.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/provider.ts")>()),
  detectActiveProvider: mocks.detectProvider,
  fetchProviderQuota: mocks.fetchQuota,
}));

import usageExtension from "../src/index.ts";

const entries = Array.from({ length: 45 }, (_, index) => ({
  ts: Date.now() - index * 24 * 60 * 60 * 1000,
  model: "test-model",
  provider: "test-provider",
  project: "/test",
  cost: 0.01,
  usage: {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  },
  skill: null,
  skills: [],
  bundles: [],
  tools: [],
  genMs: 1000,
  sessionId: "session",
  sessionPath: "/sessions/session.jsonl",
  delegated: false,
  parentSessionId: null,
}));

const report: Report = {
  computedAt: Date.now(),
  sessionCount: 1,
  turnCount: entries.length,
  entries,
  children: [],
};

type Command = { handler: (args: string, ctx: never) => Promise<void> };

function setupExtension() {
  const commands = new Map<string, Command>();
  const pi = {
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: vi.fn(),
    events: { on: vi.fn() },
  };
  usageExtension(pi as never);
  return commands;
}

function rpcContext(responses: Array<string | undefined>) {
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const selections: Array<{ title: string; options: string[] }> = [];
  const ui = {
    theme: {
      fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[0m`,
      bg: (_color: string, text: string) => `\u001b[41m${text}\u001b[0m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
    },
    setWidget: (key: string, lines: string[] | undefined) => widgets.push({ key, lines }),
    setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    notify: (message: string, type: string) => notifications.push({ message, type }),
    select: async (title: string, options: string[]) => {
      selections.push({ title, options });
      const response = responses.shift();
      if (response !== undefined) expect(options).toContain(response);
      return response;
    },
    input: vi.fn(),
  };
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui,
    modelRegistry: {},
    model: undefined,
    signal: undefined,
    sessionManager: { getBranch: () => [] },
  };
  return { ctx, widgets, statuses, notifications, selections };
}

beforeEach(() => {
  mocks.scan.mockReset().mockImplementation(async (_max, _excluded, progress) => {
    progress(1, 3);
    progress(3, 3);
    return report;
  });
  mocks.detectProvider.mockReset().mockResolvedValue(null);
  mocks.fetchQuota.mockReset().mockResolvedValue({
    active: null,
    fetchedAt: Date.now(),
    rateLimits: [],
    source: "none",
    notes: [],
  });
  mocks.saveConfig.mockReset();
});

describe("RPC usage dashboard", () => {
  it("opens a direct view, publishes plain bounded pages, and cleans up on close", async () => {
    const commands = setupExtension();
    const rpc = rpcContext(["Window: 30 days", "Close usage dashboard"]);

    await commands.get("usage-models")?.handler("", rpc.ctx as never);

    const dashboard = rpc.widgets.find(
      (entry) =>
        entry.key === "usage-panel" && entry.lines?.some((line) => line.includes("Models")),
    );
    expect(dashboard?.lines?.length).toBeLessThanOrEqual(21);
    expect(dashboard?.lines?.join("\n")).not.toContain("\u001b[");
    expect(rpc.selections[0]?.options).toContain("Window: 30 days");
    expect(rpc.selections[0]?.options).toContain("Sort models: Name");
    expect(
      rpc.widgets.some((entry) => entry.lines?.some((line) => line.includes("last 30 days"))),
    ).toBe(true);
    expect(rpc.selections).toHaveLength(2);
    expect(rpc.statuses).toContain("Scanning sessions… 1/3");
    expect(rpc.statuses.at(-1)).toBeUndefined();
    expect(rpc.widgets.at(-1)).toEqual({ key: "usage-panel", lines: undefined });
  });

  it("navigates context controls, pages, refreshes, and cleans up on cancel", async () => {
    const commands = setupExtension();
    const rpc = rpcContext([
      "View: Daily",
      "Sort daily: Date (toggle direction)",
      "Page: Next",
      "Refresh usage and provider quota",
      undefined,
    ]);

    await commands.get("usage")?.handler("", rpc.ctx as never);

    expect(rpc.selections.some((request) => request.title.includes("daily"))).toBe(true);
    expect(
      rpc.selections.find((request) => request.title.includes("daily"))?.options,
    ).not.toContain("Window: 30 days");
    expect(rpc.selections.some((request) => request.title.includes("page 2/"))).toBe(true);
    expect(mocks.scan).toHaveBeenCalledTimes(2);
    expect(mocks.fetchQuota).toHaveBeenCalledTimes(2);
    expect(rpc.widgets.at(-1)).toEqual({ key: "usage-panel", lines: undefined });
  });

  it("opens the Providers view via the usage-agents compatibility alias", async () => {
    const commands = setupExtension();
    const rpc = rpcContext(["Close usage dashboard"]);

    await commands.get("usage-agents")?.handler("", rpc.ctx as never);

    expect(rpc.selections[0]?.title).toContain("providers");
    expect(rpc.selections[0]?.options).toContain("Sort providers: Usage");
    expect(rpc.widgets.find((entry) => entry.key === "usage-panel")?.lines?.join("\n")).toContain(
      "Providers",
    );
  });

  it("keeps scan failures protocol-visible and reports an RPC error notification", async () => {
    mocks.scan.mockRejectedValueOnce(new Error("broken transcript"));
    const commands = setupExtension();
    const rpc = rpcContext(["Close usage dashboard"]);

    await commands.get("usage")?.handler("", rpc.ctx as never);

    expect(rpc.widgets.some((entry) => entry.lines?.join("\n").includes("broken transcript"))).toBe(
      true,
    );
    expect(rpc.notifications).toContainEqual({
      message: "Failed to scan sessions: broken transcript",
      type: "error",
    });
    expect(rpc.statuses.at(-1)).toBeUndefined();
  });

  it("keeps aggregate usage visible when provider detection fails", async () => {
    mocks.detectProvider.mockRejectedValueOnce(new Error("provider unavailable"));
    const commands = setupExtension();
    const rpc = rpcContext(["Close usage dashboard"]);

    await commands.get("usage")?.handler("", rpc.ctx as never);

    expect(
      rpc.widgets.find(
        (entry) => entry.key === "usage-panel" && entry.lines?.join("\n").includes("Overview"),
      ),
    ).toBeDefined();
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(rpc.selections).toHaveLength(1);
  });

  it("uses a distinct ANSI-free compact summary widget in RPC mode", async () => {
    const commands = setupExtension();
    const rpc = rpcContext([]);

    await commands.get("usage-widget")?.handler("", rpc.ctx as never);

    const summary = rpc.widgets.find((entry) => entry.key === "usage" && entry.lines);
    expect(summary?.lines?.join("\n")).toContain("usage  5H");
    expect(summary?.lines?.join("\n")).not.toContain("\u001b[");
    expect(rpc.widgets.some((entry) => entry.key === "usage-panel")).toBe(false);
  });

  it("rejects interactive commands in print and JSON modes", async () => {
    const commands = setupExtension();
    const ctx = { ...rpcContext([]).ctx, mode: "print", hasUI: false };
    for (const name of ["usage", "usage-config", "usage-pricing", "usage-widget"]) {
      await expect(commands.get(name)?.handler("", ctx as never)).rejects.toThrow(
        "requires interactive TUI or RPC mode",
      );
    }
  });
});
