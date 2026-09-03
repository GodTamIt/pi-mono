import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bucketTokens, headerFor, scanSessions, windowize } from "../src/aggregate.ts";
import type { ScanCache } from "../src/cache.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function writeJsonl(path: string, entries: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

const entryBase = (id: string, parentId: string | null) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-06-01T12:00:00.000Z",
});

const usage = (scale: number) => ({
  input: 100 * scale,
  output: 200 * scale,
  cacheRead: 50 * scale,
  cacheWrite: 10 * scale,
  cacheWrite1h: 0,
  reasoning: 0,
  totalTokens: 360 * scale,
  cost: {
    input: scale,
    output: 2 * scale,
    cacheRead: 0.5 * scale,
    cacheWrite: 0.1 * scale,
    total: 3.6 * scale,
  },
});

const assistantMessage = (scale: number) => ({
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  model: "test-model",
  provider: "test-provider",
  usage: usage(scale),
  timestamp: 1_748_800_000_000,
});

const record = (data: Record<string, unknown>) => ({
  type: "custom",
  id: `entry-${JSON.stringify(data).length}-${String(data.childSessionId ?? "")}`,
  parentId: null,
  timestamp: "2026-06-01T12:01:00.000Z",
  customType: "subagents:record",
  data,
});

const info = (path: string, id: string, modified: number): SessionInfo => ({
  path,
  id,
  cwd: "/proj",
  created: new Date(1000),
  modified: new Date(modified),
  messageCount: 0,
  firstMessage: "",
  allMessagesText: "",
});

/** parent.jsonl + child.jsonl (direct sibling) + nested grandchild of the child. */
function scanFixture(): {
  dir: string;
  parent: string;
  child: string;
  omittedRoot: string;
  omittedChild: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-scan-"));
  const parent = join(dir, "parent.jsonl");
  writeJsonl(parent, [
    {
      type: "session",
      version: 3,
      id: "root-1",
      timestamp: "2026-06-01T11:00:00.000Z",
      cwd: "/proj",
    },
    {
      ...entryBase("p1", null),
      message: { role: "user", content: "run the task", timestamp: 1_748_799_000_000 },
    },
    { ...entryBase("p2", "p1"), message: assistantMessage(1) },
    record({
      childSessionId: "child-1",
      task: "Recorded task",
      type: "worker",
      status: "completed",
      startedAt: 1000,
      completedAt: 2000,
    }),
  ]);
  const child = join(dir, "child-1.jsonl");
  writeJsonl(child, [
    {
      type: "session",
      version: 3,
      id: "child-1",
      timestamp: "2026-06-01T12:00:00.000Z",
      cwd: "/proj",
      parentSession: "root-1",
    },
    { ...entryBase("c1", null), message: assistantMessage(2) },
  ]);
  const grandchild = join(dir, "child-1", "tasks", "grand.jsonl");
  writeJsonl(grandchild, [
    {
      type: "session",
      version: 3,
      id: "grand-1",
      timestamp: "2026-06-01T12:05:00.000Z",
      cwd: "/proj",
      parentSession: "child-1",
    },
    { ...entryBase("g1", null), message: assistantMessage(4) },
  ]);
  // An older root (omitted by the cap) with its own direct sibling child.
  const omittedRoot = join(dir, "old.jsonl");
  writeJsonl(omittedRoot, [
    {
      type: "session",
      version: 3,
      id: "root-2",
      timestamp: "2026-05-01T11:00:00.000Z",
      cwd: "/proj",
    },
    { ...entryBase("o1", null), message: assistantMessage(1000) },
  ]);
  const omittedChild = join(dir, "old-child.jsonl");
  writeJsonl(omittedChild, [
    {
      type: "session",
      version: 3,
      id: "child-2",
      timestamp: "2026-05-01T12:00:00.000Z",
      cwd: "/proj",
      parentSession: "root-2",
    },
    { ...entryBase("oc1", null), message: assistantMessage(1000) },
  ]);
  return { dir, parent, child, omittedRoot, omittedChild };
}

function newCache(): ScanCache {
  return { version: 6, pricesKey: "", excludesKey: "", sessions: {} };
}

describe("scanSessions", () => {
  it("counts root and delegated child usage exactly once through parse and cache flow", async () => {
    const { dir, parent, child, omittedRoot, omittedChild } = scanFixture();
    vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      info(parent, "root-1", 2000),
      info(child, "child-1", 1500),
      info(omittedRoot, "root-2", 1000),
      info(omittedChild, "child-2", 900),
    ]);

    const openSpy = vi.spyOn(SessionManager, "open");
    const cache = newCache();
    const report = await scanSessions(1, [], undefined, undefined, cache);
    const totals = windowize(report, "all", {
      toolToPlugin: new Map(),
      skillToPlugin: new Map(),
    });

    // Only the newest root is selected; the omitted root's child never leaks in.
    expect(report.sessionCount).toBe(3);
    expect(report.entries).toHaveLength(3);
    const tokens = (scale: number) => 360 * scale;
    expect(bucketTokens(totals.total)).toBe(tokens(1) + tokens(2) + tokens(4));
    expect(bucketTokens(totals.direct)).toBe(tokens(1));
    expect(bucketTokens(totals.delegated)).toBe(tokens(2) + tokens(4));
    expect(totals.total.cost).toBeCloseTo(3.6 * 7, 10);

    // Delegated child turns are attributed once, under their own session ids.
    expect(report.entries.filter((turn) => turn.sessionId === "child-1")).toHaveLength(1);
    expect(report.entries.filter((turn) => turn.sessionId === "grand-1")).toHaveLength(1);
    const childSummary = report.children.find((c) => c.id === "child-1");
    expect(childSummary?.parentSessionId).toBe("root-1");
    expect(childSummary?.task).toBe("Recorded task");
    const grandSummary = report.children.find((c) => c.id === "grand-1");
    expect(grandSummary?.parentSessionId).toBe("child-1");

    // Cached second scan (no file changes) does not full-parse any transcript.
    expect(openSpy).toHaveBeenCalledTimes(3);
    const cached = await scanSessions(1, [], undefined, undefined, cache);
    const cachedTotals = windowize(cached, "all", {
      toolToPlugin: new Map(),
      skillToPlugin: new Map(),
    });
    expect(openSpy).toHaveBeenCalledTimes(3);
    expect(cached.entries).toHaveLength(3);
    expect(bucketTokens(cachedTotals.total)).toBe(bucketTokens(totals.total));
    expect(bucketTokens(cachedTotals.direct) + bucketTokens(cachedTotals.delegated)).toBe(
      bucketTokens(cachedTotals.total),
    );
  });

  it("refreshes a cached child summary when parent record metadata changes", async () => {
    const { parent, child, omittedRoot, omittedChild } = scanFixture();
    vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      info(parent, "root-1", 2000),
      info(child, "child-1", 1500),
      info(omittedRoot, "root-2", 1000),
      info(omittedChild, "child-2", 900),
    ]);

    const openSpy = vi.spyOn(SessionManager, "open");
    const cache = newCache();
    await scanSessions(1, [], undefined, undefined, cache);
    expect(cache.sessions[child]?.child?.task).toBe("(untitled)");
    expect(cache.sessions[child]?.records).toEqual([]);
    expect(cache.sessions[parent]?.records).toHaveLength(1);

    // Append a newer resumed record for the same child, then touch the parent.
    appendFileSync(
      parent,
      `${JSON.stringify(
        record({
          childSessionId: "child-1",
          task: "Resumed task",
          type: "reviewer",
          status: "error",
          startedAt: 5000,
          completedAt: 8000,
        }),
      )}\n`,
    );
    const refreshed = await scanSessions(1, [], undefined, undefined, cache);

    // The child transcript itself was unchanged (cache hit) but its summary
    // reflects the parent's new metadata: newer run wins, earlier survives.
    expect(openSpy).toHaveBeenCalledTimes(4);
    const childSummary = refreshed.children.find((c) => c.id === "child-1");
    expect(childSummary?.task).toBe("Resumed task");
    expect(childSummary?.agentType).toBe("reviewer");
    expect(childSummary?.status).toBe("error");
    expect(childSummary?.startedAt).toBe(5000);
    expect(cache.sessions[child]?.child?.task).toBe("(untitled)");
    expect(cache.sessions[parent]?.records).toHaveLength(2);
  });

  it("bounds header classification to the transcript prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-header-"));
    const path = join(dir, "late-header.jsonl");
    writeFileSync(path, `${" ".repeat(1024 * 1024 + 1)}\n`);
    appendFileSync(
      path,
      `${JSON.stringify({ type: "session", id: "too-late", parentSession: "root-1" })}\n`,
    );

    expect(headerFor(path)).toEqual({});
  });
});
