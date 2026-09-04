import type { Usage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ChildSessionSummary, Report, TurnEntry } from "../src/aggregate.ts";
import { UsageView, type ViewKey } from "../src/view.ts";

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: 51_800_000,
  output: 3_700_000,
  cacheRead: 97_700_000,
  cacheWrite: 1_200_000,
  cacheWrite1h: 100_000,
  reasoning: 700_000,
  totalTokens: 154_400_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ...over,
});

const now = Date.now();
const entries: TurnEntry[] = Array.from({ length: 900 }, (_, i) => ({
  ts: now - i * 60 * 60 * 1000,
  model: i % 2 ? "glm-5.2" : "anthropic/claude-opus-4.7-with-a-long-suffix",
  provider: i % 3 ? "zai" : "openai-codex",
  project: "/home/user/some/deeply/nested/project-path",
  cost: 0.5,
  usage: usage(),
  skill: null,
  skills: [],
  bundles: [],
  tools: ["read", "bash", "a_plugin_tool_with_a_long_name"],
  genMs: 30_000,
  sessionId: i % 4 === 0 ? `child-${i}` : "parent",
  sessionPath: "/sessions/parent/tasks/child.jsonl",
  delegated: i % 4 === 0,
  parentSessionId: i % 4 === 0 ? "parent" : null,
}));

const children: ChildSessionSummary[] = Array.from({ length: 25 }, (_, i) => ({
  id: `child-${i * 4}`,
  path: `/sessions/parent/tasks/child-${i * 4}.jsonl`,
  parentSessionId: "parent",
  parentLabel: "Parent session with a long descriptive name",
  project: "/project",
  task: "A long child task description that must be truncated at narrow widths",
  agentType: "worker-profile-long-name",
  status: "completed",
  isBackground: i % 2 === 0,
  startedAt: now - 3_600_000 * (i + 1),
  endedAt: now - 3_600_000 * (i + 1) + 1_800_000,
  timingInferred: i % 3 === 0,
  compactions: 1,
}));

const report: Report = {
  computedAt: now,
  sessionCount: 254,
  turnCount: entries.length,
  entries,
  children,
};

const views: ViewKey[] = [
  "overview",
  "models",
  "delegation",
  "daily",
  "stats",
  "hourly",
  "providers",
  "wrapped",
];

describe("UsageView rendering", () => {
  it("keeps every line within the terminal width at 40/54/64 columns", () => {
    const overflows: string[] = [];
    for (const width of [40, 54, 64]) {
      const view = new UsageView({
        theme: {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
        } as never,
        tui: { requestRender: () => {}, terminal: { rows: 40 } } as never,
        maps: { toolToPlugin: new Map(), skillToPlugin: new Map() },
        home: "/home/user",
        getConfig: () => ({}),
        onClose: () => {},
        onRefresh: () => {},
        onConfigure: () => {},
      });
      view.setReport(report);
      for (const viewKey of views) {
        view.setInitialView(viewKey);
        view.render(width).forEach((line, i) => {
          const w = visibleWidth(line);
          if (w > width) overflows.push(`${width}/${viewKey}[${i}] width ${w}: ${line}`);
        });
      }
    }
    expect(overflows).toEqual([]);
  });

  const makeView = (rep: Report, view: ViewKey) => {
    const v = new UsageView({
      theme: {
        fg: (_c: string, t: string) => t,
        bg: (_c: string, t: string) => t,
        bold: (t: string) => t,
      } as never,
      tui: { requestRender: () => {}, terminal: { rows: 200 } } as never,
      maps: { toolToPlugin: new Map(), skillToPlugin: new Map() },
      home: "/home/user",
      getConfig: () => ({}),
      onClose: () => {},
      onRefresh: () => {},
      onConfigure: () => {},
    });
    v.setReport(rep);
    v.setInitialView(view);
    return v;
  };

  it("shows all eight view tabs at 128+ columns and degrades gracefully below", () => {
    const wide = makeView(report, "overview").render(128).join("\n");
    for (const short of ["Over", "Mod", "Del", "Day", "Stat", "Hr", "Prov", "Wrap"]) {
      expect(wide).toContain(short);
    }
    // Narrow terminals collapse to an active-tab-centered row that still
    // names the current view and its position.
    const narrow = makeView(report, "delegation").render(40).join("\n");
    expect(narrow).toContain("Delegation");
    expect(narrow).toContain("3/8");
  });

  it("labels inferred concurrency honestly in Delegation and Overview", () => {
    const inferred = makeView(report, "delegation").render(100).join("\n");
    expect(inferred).toContain("(inferred)");
    expect(inferred).not.toContain("estimated/inferred");
    const overview = makeView(report, "overview").render(100).join("\n");
    expect(overview).toContain("est. peak");

    // All children with precise timing: no "est."/"inferred" hedging.
    const recorded: Report = {
      ...report,
      children: children.map((c) => ({ ...c, timingInferred: false })),
    };
    const recDel = makeView(recorded, "delegation").render(100).join("\n");
    expect(recDel).not.toContain("(inferred)");
    const recOv = makeView(recorded, "overview").render(100).join("\n");
    expect(recOv).not.toContain("est. peak");
    expect(recOv).toContain("peak");
  });

  it("supports the month window only on generic-window views", () => {
    const view = makeView(report, "overview");
    for (const viewKey of ["overview", "models", "delegation"] as ViewKey[]) {
      view.setInitialView(viewKey);
      view.handleInput("m");
      const output = view.render(100).join("\n");
      expect(output).toContain("Showing: last 30 days");
      expect(output).toContain("MONTH");
    }

    for (const viewKey of ["daily", "hourly", "providers", "wrapped"] as ViewKey[]) {
      view.setInitialView("overview");
      view.handleInput("a");
      view.setInitialView(viewKey);
      view.handleInput("m");
      view.setInitialView("overview");
      expect(view.render(100).join("\n")).toContain("Showing: all time");
    }

    view.setInitialView("overview");
    view.handleInput("a");
    view.setInitialView("stats");
    view.handleInput("m");
    const stats = view.render(100).join("\n");
    expect(stats).toContain("Last 30 days");
    expect(stats).not.toContain("MONTH");
    view.setInitialView("overview");
    expect(view.render(100).join("\n")).toContain("Showing: all time");
  });

  it("shows an explicit empty state when no child sessions are in the window", () => {
    // Delegated turns exist but no child transcripts were discovered: the
    // Child sessions section must say so rather than render a bare header.
    const noChildren: Report = { ...report, children: [] };
    const out = makeView(noChildren, "delegation").render(100).join("\n");
    expect(out).toContain("Child sessions");
    expect(out).toContain("— none in this window —");

    // Fully delegation-free: a single friendly empty state, no empty grids.
    const directOnly: Report = {
      ...report,
      children: [],
      entries: entries.map((e) => ({ ...e, delegated: false, parentSessionId: null })),
    };
    const empty = makeView(directOnly, "delegation").render(100).join("\n");
    expect(empty).toContain("No delegated child sessions in this window.");
    expect(empty).not.toContain("Concurrency");
  });

  it("advertises the window keys on Delegation and keeps month lines inside 40 cols", () => {
    const view = makeView(report, "delegation");
    const out = view.render(100).join("\n");
    expect(out).toContain("d/w/m/a window");
    view.handleInput("m");
    const narrow = view.render(40);
    expect(narrow.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(narrow.join("\n")).toContain("MONTH");
    const footer = narrow[narrow.length - 2];
    expect(footer).toContain("q");
  });

  it("keeps one physical row per line when Delegation metadata contains control characters", () => {
    // Regression: session-derived task/parent/agent/status text can carry
    // newlines, tabs, and escape bytes. visibleWidth() counts \n as 0, so a
    // poisoned "line" passed the width clamp yet wrapped into extra physical
    // rows, desyncing pi-tui's differential renderer (stale rows, duplicated
    // header) after leaving or closing the Delegation tab.
    const poisoned: Report = {
      ...report,
      children: children.map((c, i) =>
        i === 0
          ? {
              ...c,
              task: "first line\nsecond line\t\x1b[2J\x1b[31mred",
              parentLabel: "parent\nlabel",
              agentType: "agent\r\ntype",
              status: "done\n\x1b[2J",
            }
          : c,
      ),
    };
    // Strip legitimate SGR (truncateToWidth appends resets); any control
    // char left over — or a stray ESC — is leaked session data.
    const expectRowContract = (lines: string[], width: number) => {
      for (const line of lines) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: This assertion intentionally detects leaked control characters.
        expect(stripTerminalSequences(line)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    };

    // Navigate forward onto Delegation (1 → 2 → 3) and check every frame.
    const view = makeView(poisoned, "overview");
    expectRowContract(view.render(100), 100);
    view.handleInput("\t");
    expect(view.activeView).toBe("models");
    expectRowContract(view.render(100), 100);
    view.handleInput("\t");
    expect(view.activeView).toBe("delegation");
    const delegation = view.render(100);
    expectRowContract(delegation, 100);
    const joined = delegation.join("\n");
    expect(joined).toContain("first line second line");
    expect(joined).toContain("parent label");
    expect(joined).toContain("agent type");
    expect(joined).not.toContain("\x1b[2J");

    // Portable (RPC) rendering obeys the same single-row contract.
    expectRowContract(view.renderPortable(100), 100);

    // Back out in reverse (shift+tab), jump back in, then leave forward.
    view.handleInput("\x1b[Z");
    expect(view.activeView).toBe("models");
    expectRowContract(view.render(100), 100);
    view.handleInput("3");
    expect(view.activeView).toBe("delegation");
    expectRowContract(view.render(40), 40);
    view.handleInput("\t");
    expect(view.activeView).toBe("daily");
    expectRowContract(view.render(100), 100);
  });

  it("shares semantic actions with terminal key handling without changing TUI controls", () => {
    const view = makeView(report, "overview");
    view.applyAction({ type: "view", view: "models" });
    expect(view.render(100).join("\n")).toContain("Models");
    view.handleInput("7");
    expect(view.activeView).toBe("providers");
    view.applyAction({ type: "providerSort", sort: "name" });
    expect(view.render(100).join("\n")).toContain("sort: name");
  });
});
