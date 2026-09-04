import type { Usage } from "@earendil-works/pi-ai";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bucketTokens,
  computeConcurrency,
  costFromPrice,
  discoverChildSessionFiles,
  normalizeTurnEntry,
  windowLabel,
  windowMs,
  windowize,
  type ChildSessionSummary,
  type Report,
  type TurnEntry,
} from "../src/aggregate.ts";

const usage = (values: Partial<Usage> = {}): Usage => ({
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  cacheWrite1h: 5,
  reasoning: 7,
  totalTokens: 100,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  ...values,
});

const turn = (delegated: boolean, overrides: Partial<TurnEntry> = {}): TurnEntry => ({
  ts: Date.now(),
  model: "model",
  provider: "provider",
  project: "/project",
  cost: 10,
  usage: usage(),
  skill: null,
  skills: [],
  bundles: [],
  tools: [],
  genMs: 0,
  sessionId: delegated ? "child" : "parent",
  sessionPath: delegated ? "/sessions/parent/tasks/child.jsonl" : "/sessions/parent.jsonl",
  delegated,
  parentSessionId: delegated ? "parent" : null,
  ...overrides,
});

const child = (overrides: Partial<ChildSessionSummary> = {}): ChildSessionSummary => ({
  id: "child",
  path: "/sessions/parent/tasks/child.jsonl",
  parentSessionId: "parent",
  parentLabel: "Parent",
  project: "/project",
  task: "Implement feature",
  agentType: "worker",
  status: "completed",
  startedAt: 100,
  endedAt: 200,
  timingInferred: false,
  compactions: 0,
  ...overrides,
});

const maps = { toolToPlugin: new Map<string, string>(), skillToPlugin: new Map<string, string>() };

describe("child transcript discovery", () => {
  it("finds recursively nested session children without following symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
    const root = join(dir, "root.jsonl");
    writeFileSync(root, "{}\n");
    const nested = join(dir, "root", "tasks", "nested", "subagents");
    mkdirSync(nested, { recursive: true });
    const childPath = join(nested, "child.jsonl");
    writeFileSync(childPath, "malformed but discoverable\n");
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "ignored.jsonl"), "{}\n");
    symlinkSync(outside, join(dir, "root", "linked"));
    expect(discoverChildSessionFiles(root)).toEqual([childPath]);
  });
});

describe("delegation and token composition", () => {
  it("keeps direct and delegated totals as a strict partition", () => {
    const report: Report = {
      computedAt: Date.now(),
      sessionCount: 2,
      turnCount: 2,
      entries: [turn(false), turn(true)],
      children: [child({ startedAt: Date.now() - 1000, endedAt: Date.now() })],
    };
    const win = windowize(report, "all", maps);
    expect(bucketTokens(win.direct) + bucketTokens(win.delegated)).toBe(bucketTokens(win.total));
    expect(win.total.reasoning).toBe(14);
    expect(win.total.cacheWrite1h).toBe(10);
    expect(win.total.costInput).toBe(2);
    expect(win.total.costOutput).toBe(4);
    expect(win.total.costCacheRead).toBe(6);
    expect(win.total.costCacheWrite).toBe(8);
  });

  it("normalizes legacy cached turns as direct", () => {
    const { delegated: _delegated, sessionId: _sessionId, ...legacy } = turn(false);
    const normalized = normalizeTurnEntry(legacy as TurnEntry);
    expect(normalized.delegated).toBe(false);
    expect(normalized.sessionId).toBe("");
  });

  it("prices every component consistently and does not add reasoning", () => {
    const priced = costFromPrice(usage(), {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    });
    expect(priced).toBe(100);
  });

  it("includes the rolling 30-day month window", () => {
    const now = Date.now();
    const report: Report = {
      computedAt: now,
      sessionCount: 2,
      turnCount: 2,
      entries: [
        turn(false, { ts: now - 29 * 24 * 60 * 60 * 1000 }),
        turn(false, { ts: now - 31 * 24 * 60 * 60 * 1000 }),
      ],
      children: [
        child({
          id: "recent",
          startedAt: now - 31 * 24 * 60 * 60 * 1000,
          endedAt: now - 29 * 24 * 60 * 60 * 1000,
        }),
        child({
          id: "old",
          startedAt: now - 32 * 24 * 60 * 60 * 1000,
          endedAt: now - 31 * 24 * 60 * 60 * 1000,
        }),
      ],
    };

    const win = windowize(report, "30d", maps);
    expect(windowMs("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(windowLabel("30d")).toBe("Last 30 days");
    expect(win.total.turns).toBe(1);
    expect(win.children.map((item) => item.id)).toEqual(["recent"]);
  });
});

describe("computeConcurrency", () => {
  it("handles no valid intervals without NaN or Infinity", () => {
    const stats = computeConcurrency([child({ startedAt: 0, endedAt: 0 })]);
    expect(stats.peak).toBeNull();
    expect(stats.parallelism).toBeNull();
    expect(stats.unionMs).toBeNull();
  });

  it("computes overlap and peak and clamps to the report window", () => {
    const stats = computeConcurrency(
      [
        child({ id: "a", startedAt: 1, endedAt: 20 }),
        child({ id: "b", startedAt: 10, endedAt: 30 }),
      ],
      5,
      25,
    );
    expect(stats.childCount).toBe(2);
    expect(stats.peak).toBe(2);
    expect(stats.unionMs).toBe(20);
    expect(stats.summedMs).toBe(30);
    expect(stats.overlapSavedMs).toBe(10);

    const overlap = computeConcurrency([
      child({ id: "a", startedAt: 100, endedAt: 300 }),
      child({ id: "b", startedAt: 200, endedAt: 400, timingInferred: true }),
    ]);
    expect(overlap.peak).toBe(2);
    expect(overlap.unionMs).toBe(300);
    expect(overlap.summedMs).toBe(400);
    expect(overlap.overlapSavedMs).toBe(100);
    expect(overlap.parallelism).toBeCloseTo(4 / 3);
    expect(overlap.inferred).toBe(true);
  });
});
