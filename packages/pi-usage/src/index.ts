/**
 * Pi usage extension — a Claude Code-style `/usage` panel for pi.
 *
 * Commands:
 *   /usage         Open the interactive usage panel (5H / day / week / month / all
 *                  windows, quota bars, model/skill/plugin/tool/project
 *                  breakdowns).
 *   /usage-config  Set your 5-hour and weekly USD budgets.
 *   /usage-widget  Toggle a compact always-on spend widget above the editor.
 *
 * Config: ~/.pi/agent/usage.json (see config.ts).
 *
 * Budgets are user-defined because pi works with any provider — unlike Claude
 * Code's subscription, pi has no built-in quota. Set limits that match your
 * plan and the panel shows progress against them.
 */
import { homedir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type AttributionMaps,
  buildAttributionMaps,
  type Report,
  scanSessions,
} from "./aggregate.ts";
import { loadScanCache, type ScanCache, saveScanCache } from "./cache.ts";
import { loadConfig, saveConfig, type UsageConfig } from "./config.ts";
import { formatCost, formatTokens } from "./format.ts";
import { isReportCacheFresh } from "./freshness.ts";
import {
  type ActiveProvider,
  detectActiveProvider,
  fetchProviderQuota,
  parseRateLimits,
  type RateLimitWindow,
} from "./provider.ts";
import { type UsageAction, UsageView, type ViewKey } from "./view.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes
// RPC widgets cannot negotiate a terminal viewport, so the dashboard is
// deliberately bounded to a fixed portable width/height.
const RPC_RENDER_WIDTH = 80;
const RPC_PAGE_HEIGHT = 20;
const RPC_PANEL_KEY = "usage-panel";
const RPC_STATUS_KEY = "usage-scan";

// RPC clients receive plain string[] widgets; strip all theming so no ANSI
// escape codes ever reach the protocol.
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

export default function usageExtension(pi: ExtensionAPI) {
  const home = homedir();
  let config: UsageConfig = loadConfig();
  let maps: AttributionMaps = {
    toolToPlugin: new Map(),
    skillToPlugin: new Map(),
  };
  let cache: { report: Report; at: number } | null = null;
  // Epoch-ms of the most recent assistant turn seen this run. A new turn
  // invalidates the in-memory report cache (see isReportCacheFresh) so the
  // trend graph reflects current usage instead of a stale snapshot.
  let lastTurnAt = 0;
  // Persistent incremental scan cache (loaded lazily on first scan), so only
  // new/changed session files are re-parsed across opens and restarts.
  let scanCache: ScanCache | null = null;
  // Latest context, captured for widget updates (setWidget needs ctx.ui).
  let latestCtx: ExtensionContext | null = null;
  // Active provider + most recent rate-limit headers, captured live from the
  // provider responses so the panel can show the provider's own quota.
  let activeProvider: ActiveProvider | null = null;
  let capturedRateLimits: RateLimitWindow[] = [];
  // Raw headers from the most recent provider response (for Codex x-codex-* parsing).
  let capturedHeaders: Record<string, string> = {};

  // Track the active provider and capture rate-limit headers from responses.
  pi.on("session_start", async (_e, ctx) => {
    activeProvider = await detectActiveProvider(ctx.modelRegistry, ctx.model);
  });
  pi.on("model_select", async (event, ctx) => {
    activeProvider = await detectActiveProvider(ctx.modelRegistry, event.model);
    refreshWidget();
  });
  pi.on("after_provider_response", async (event) => {
    // Only trust headers from successful responses; 4xx/5xx often omit them.
    if (event.status >= 400) return;
    capturedRateLimits = parseRateLimits(event.headers);
    capturedHeaders = event.headers;
  });

  const captureCtx = (ctx: ExtensionContext) => {
    latestCtx = ctx;
  };

  // Rebuild attribution maps when resources (re)load; refresh the widget.
  pi.on("session_start", async () => {
    maps = buildAttributionMaps(pi);
    refreshWidget();
  });
  pi.on("session_start", async (_e, ctx) => captureCtx(ctx));
  pi.on("turn_end", async (_e, ctx) => {
    captureCtx(ctx);
    // A turn just completed and has been persisted to the session file — mark
    // it so the next /usage open rescans instead of serving a stale cache.
    lastTurnAt = Date.now();
    refreshWidget();
  });

  // Delegation lifecycle channels are optional — they are only emitted by
  // delegation frameworks (e.g. a subagent roster extension), and subscribing
  // on the shared event bus is safe when nothing emits. A finished subagent
  // run appends turns, so treat it like turn_end for cache freshness. There
  // is no extension-lifetime disposer registry, so these subscriptions live
  // for the extension's lifetime.
  for (const channel of ["subagents:completed", "subagents:failed", "subagents:resumed"]) {
    pi.events.on(channel, () => {
      lastTurnAt = Date.now();
      refreshWidget();
    });
  }

  // ------------------------------------------------------------------ /usage

  pi.registerCommand("usage", {
    description:
      "Usage panel — Overview / Models / Delegation / Daily / Stats / Hourly / Providers / Wrapped AI",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx);
    },
  });

  // View shortcuts: open the panel directly on a specific menu.
  pi.registerCommand("usage-models", {
    description: "Open the usage panel on the Models view",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx, "models");
    },
  });
  pi.registerCommand("usage-delegation", {
    description: "Open the usage panel on the Delegation view",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx, "delegation");
    },
  });
  pi.registerCommand("usage-daily", {
    description: "Open the usage panel on the Daily summary view",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx, "daily");
    },
  });
  pi.registerCommand("usage-stats", {
    description: "Open the usage panel on the Stats (contribution graph) view",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx, "stats");
    },
  });
  pi.registerCommand("usage-hourly", {
    description: "Open the usage panel on the Hourly (time-of-day) view",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx, "hourly");
    },
  });
  pi.registerCommand("usage-providers", {
    description: "Open the usage panel on the Providers view",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx, "providers");
    },
  });
  pi.registerCommand("usage-agents", {
    description: "Compatibility alias for the Providers view",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx, "providers");
    },
  });
  pi.registerCommand("usage-wrapped", {
    description: "Open the usage panel on the Wrapped AI year-in-review view",
    handler: async (_args, ctx) => {
      await openUsagePanel(ctx, "wrapped");
    },
  });

  async function openUsagePanel(ctx: ExtensionContext, initialView?: ViewKey): Promise<void> {
    requireUI(ctx, "/usage");
    if (ctx.mode === "rpc") {
      await openRpcUsagePanel(ctx, initialView);
      return;
    }
    if (ctx.mode !== "tui") return;

    // Constructed with tui undefined; it is bound inside custom() where pi
    // hands us the terminal instance and active theme.
    const view = new UsageView({
      theme: ctx.ui.theme,
      tui: undefined,
      maps,
      home,
      getConfig: () => config,
      onClose: () => undefined,
      onRefresh: () => {
        void runScan(ctx, view, true);
        void runProviderQuota(ctx, view);
      },
      onConfigure: () => {
        void configureLimits(ctx);
      },
    });
    if (initialView) view.setInitialView(initialView);

    await ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
      view.bind(tui, theme, () => done(undefined));
      void runProviderQuota(ctx, view);

      const cached = cache;
      const fresh = isReportCacheFresh(cached, Date.now(), lastTurnAt, CACHE_TTL);
      if (fresh && cached) view.setReport(cached.report);
      else void runScan(ctx, view, false);

      return view;
    });
  }

  async function openRpcUsagePanel(ctx: ExtensionContext, initialView?: ViewKey): Promise<void> {
    const view = new UsageView({
      theme: PLAIN_THEME,
      tui: undefined,
      maps,
      home,
      getConfig: () => config,
      onClose: () => undefined,
      onRefresh: () => undefined,
      onConfigure: () => undefined,
    });
    if (initialView) view.setInitialView(initialView);
    let page = 0;

    const updateDashboard = () => {
      const all = view.renderPortable(RPC_RENDER_WIDTH);
      const pageCount = Math.max(1, Math.ceil(all.length / RPC_PAGE_HEIGHT));
      page = Math.min(page, pageCount - 1);
      const start = page * RPC_PAGE_HEIGHT;
      const lines = all.slice(start, start + RPC_PAGE_HEIGHT);
      lines.push(`Page ${page + 1}/${pageCount} · ${all.length} lines · select an action below`);
      ctx.ui.setWidget(RPC_PANEL_KEY, lines);
      return pageCount;
    };

    try {
      view.setScanning(0, 0);
      updateDashboard();
      await Promise.all([runScan(ctx, view, false), runProviderQuota(ctx, view)]);

      for (;;) {
        const pageCount = updateDashboard();
        const actions = rpcActions(view, page, pageCount);
        const selected = await ctx.ui.select(
          `Usage · ${view.activeView} · page ${page + 1}/${pageCount}`,
          actions.map((item) => item.label),
        );
        if (selected === undefined) break;
        const item = actions.find((candidate) => candidate.label === selected);
        if (!item || item.kind === "close") break;
        if (item.kind === "previous") {
          page = Math.max(0, page - 1);
          continue;
        }
        if (item.kind === "next") {
          page = Math.min(pageCount - 1, page + 1);
          continue;
        }
        if (item.kind !== "action") break;
        page = 0;
        if (item.action.type === "refresh") {
          await Promise.all([runScan(ctx, view, true), runProviderQuota(ctx, view)]);
        } else if (item.action.type === "configure") {
          await configureLimits(ctx);
        } else {
          view.applyAction(item.action);
        }
      }
    } finally {
      ctx.ui.setStatus(RPC_STATUS_KEY, undefined);
      ctx.ui.setWidget(RPC_PANEL_KEY, undefined);
    }
  }

  async function runScan(ctx: ExtensionContext, view: UsageView, force: boolean): Promise<void> {
    if (!force && isReportCacheFresh(cache, Date.now(), lastTurnAt, CACHE_TTL) && cache) {
      view.setReport(cache.report);
      return;
    }
    view.setScanning(0, 0);
    let lastStatusAt = 0;
    try {
      if (!scanCache) scanCache = loadScanCache();
      const report = await scanSessions(
        config.maxSessions ?? 1000,
        config.excludeProjects ?? [],
        (loaded, total) => {
          view.setScanning(loaded, total);
          if (ctx.mode !== "rpc") return;
          const now = Date.now();
          if (loaded !== total && now - lastStatusAt < 250) return;
          lastStatusAt = now;
          ctx.ui.setStatus(RPC_STATUS_KEY, `Scanning sessions… ${loaded}/${total}`);
        },
        config.modelPrices ?? {},
        scanCache,
      );
      cache = { report, at: Date.now() };
      saveScanCache(scanCache);
      view.setReport(report);
      refreshWidget();
    } catch (err) {
      const message = `Failed to scan sessions: ${err instanceof Error ? err.message : String(err)}`;
      view.setError(message);
      if (ctx.mode === "rpc") ctx.ui.notify(message, "error");
    } finally {
      if (ctx.mode === "rpc") ctx.ui.setStatus(RPC_STATUS_KEY, undefined);
    }
  }

  /** Fetch the active provider's live quota + merge captured rate-limit headers. */
  async function runProviderQuota(ctx: ExtensionContext, view: UsageView): Promise<void> {
    try {
      // Keep the active provider fresh in case the model changed.
      activeProvider = await detectActiveProvider(ctx.modelRegistry, ctx.model);
      const quota = await fetchProviderQuota(
        ctx.modelRegistry,
        activeProvider,
        capturedRateLimits,
        capturedHeaders,
        ctx.signal,
      );
      view.setProviderQuota(quota);
    } catch (err) {
      view.setProviderQuota({
        active: activeProvider,
        fetchedAt: Date.now(),
        rateLimits: capturedRateLimits,
        source: "none",
        notes: [],
        error: `Failed to fetch provider quota: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ------------------------------------------------------------ /usage-config

  pi.registerCommand("usage-config", {
    description: "Set 5-hour and weekly USD usage budgets",
    handler: async (_args, ctx) => {
      requireUI(ctx, "/usage-config");
      await configureLimits(ctx);
    },
  });

  async function configureLimits(ctx: ExtensionContext): Promise<void> {
    // USD budgets (priced providers).
    const five = await ctx.ui.input(
      "5-hour budget (USD, 0 = no limit)",
      `${config.fiveHourLimit ?? 0}`,
    );
    if (five === undefined) return;
    const weekly = await ctx.ui.input(
      "Weekly budget (USD, 0 = no limit)",
      `${config.weeklyLimit ?? 0}`,
    );
    if (weekly === undefined) return;
    // Token budgets (token-priced providers like zai/GLM).
    const fiveTok = await ctx.ui.input(
      "5-hour token budget (e.g. 2000000, 0 = none)",
      `${config.fiveHourTokenLimit ?? 0}`,
    );
    if (fiveTok === undefined) return;
    const weeklyTok = await ctx.ui.input(
      "Weekly token budget (e.g. 10000000, 0 = none)",
      `${config.weeklyTokenLimit ?? 0}`,
    );
    if (weeklyTok === undefined) return;

    config = {
      ...config,
      fiveHourLimit: parseUsd(five),
      weeklyLimit: parseUsd(weekly),
      fiveHourTokenLimit: parseUsd(fiveTok),
      weeklyTokenLimit: parseUsd(weeklyTok),
    };
    saveConfig(config);
    cache = null; // force re-eval of quota colors next open
    refreshWidget();
    ctx.ui.notify(
      `Budgets set · 5h ${formatCost(config.fiveHourLimit ?? 0)} / ${formatTokens(config.fiveHourTokenLimit ?? 0)} tok`,
      "info",
    );
  }

  // ----------------------------------------------------------- /usage-pricing

  pi.registerCommand("usage-pricing", {
    description: "Set a manual per-model price ($/M tokens) for token-priced models",
    handler: async (args, ctx) => {
      requireUI(ctx, "/usage-pricing");
      await configurePricing(ctx, typeof args === "string" ? args : "");
    },
  });

  async function configurePricing(ctx: ExtensionContext, arg: string): Promise<void> {
    const model =
      arg.trim() ||
      (await ctx.ui.input("Model ID (e.g. glm-5-turbo, or base name claude-opus-4.7)", "")) ||
      "";
    if (!model.trim()) return;
    const key = model.trim();
    const cur = config.modelPrices?.[key] ?? {};
    const inp = await ctx.ui.input(
      `Input price for ${key} (USD per 1M tokens)`,
      `${cur.input ?? 0}`,
    );
    if (inp === undefined) return;
    const out = await ctx.ui.input("Output price (USD per 1M tokens)", `${cur.output ?? 0}`);
    if (out === undefined) return;
    const cr = await ctx.ui.input("Cache-read price (USD per 1M tokens)", `${cur.cacheRead ?? 0}`);
    if (cr === undefined) return;
    const cw = await ctx.ui.input(
      "Cache-write price (USD per 1M tokens)",
      `${cur.cacheWrite ?? 0}`,
    );
    if (cw === undefined) return;

    const price = {
      input: parseUsd(inp),
      output: parseUsd(out),
      cacheRead: parseUsd(cr),
      cacheWrite: parseUsd(cw),
    };
    config = {
      ...config,
      modelPrices: { ...(config.modelPrices ?? {}), [key]: price },
    };
    saveConfig(config);
    cache = null; // force a re-scan so the new price is applied
    ctx.ui.notify(
      `Price set for ${key}: in $${price.input} / out $${price.output} per 1M tokens`,
      "info",
    );
  }

  // ------------------------------------------------------------ /usage-widget

  pi.registerCommand("usage-widget", {
    description: "Toggle the always-on usage summary widget",
    handler: async (_args, ctx) => {
      requireUI(ctx, "/usage-widget");
      latestCtx = ctx;
      config = { ...config, showWidget: !config.showWidget };
      saveConfig(config);
      if (!config.showWidget) ctx.ui.setWidget("usage", undefined);
      refreshWidget();
      ctx.ui.notify(`Usage widget ${config.showWidget ? "on" : "off"}`, "info");
    },
  });

  function refreshWidget(): void {
    if (!config.showWidget || !latestCtx?.hasUI) return;
    const summary = currentSessionWindows();
    // Use tokens when there's no meaningful $ cost in the current session (token-priced providers).
    const useTokens = summary.fiveHourCost <= 0 && summary.weeklyCost <= 0;
    const fmt = (n: number) => (useTokens ? formatTokens(n) : formatCost(n));
    const f5 = useTokens ? summary.fiveHourTokens : summary.fiveHourCost;
    const w7 = useTokens ? summary.weeklyTokens : summary.weeklyCost;
    const lim5 = useTokens ? config.fiveHourTokenLimit : config.fiveHourLimit;
    const lim7 = useTokens ? config.weeklyTokenLimit : config.weeklyLimit;
    const five = `5H ${fmt(f5)}${lim5 && lim5 > 0 ? ` / ${fmt(lim5)}` : ""}${useTokens ? " tok" : ""}`;
    const week = `week ${fmt(w7)}${lim7 && lim7 > 0 ? ` / ${fmt(lim7)}` : ""}${useTokens ? " tok" : ""}`;
    const line = `usage  ${five}   ${week}`;
    if (latestCtx.mode === "rpc") {
      latestCtx.ui.setWidget("usage", [line]);
      return;
    }
    const theme = latestCtx.ui.theme;
    latestCtx.ui.setWidget("usage", [
      `${theme.fg("dim", "usage")}  ${theme.fg("text", five)}   ${theme.fg("text", week)}`,
    ]);
  }

  /** Sum cost + tokens in the current session branch for the 5h and 7d windows. */
  function currentSessionWindows(): {
    fiveHourCost: number;
    weeklyCost: number;
    fiveHourTokens: number;
    weeklyTokens: number;
  } {
    const zero = {
      fiveHourCost: 0,
      weeklyCost: 0,
      fiveHourTokens: 0,
      weeklyTokens: 0,
    };
    const sm = latestCtx?.sessionManager;
    if (!sm) return zero;
    const now = Date.now();
    let fiveHourCost = 0;
    let weeklyCost = 0;
    let fiveHourTokens = 0;
    let weeklyTokens = 0;
    for (const e of sm.getBranch()) {
      if (e.type !== "message") continue;
      const m = e.message as AssistantMessage;
      if (m.role !== "assistant" || !m.usage) continue;
      const u = m.usage;
      const tok = u.input + u.output + u.cacheRead + u.cacheWrite;
      if (m.timestamp >= now - 5 * HOUR) {
        fiveHourCost += u.cost.total;
        fiveHourTokens += tok;
      }
      if (m.timestamp >= now - 7 * DAY) {
        weeklyCost += u.cost.total;
        weeklyTokens += tok;
      }
    }
    return { fiveHourCost, weeklyCost, fiveHourTokens, weeklyTokens };
  }
}

type RpcMenuItem =
  | { label: string; kind: "action"; action: UsageAction }
  | { label: string; kind: "previous" | "next" | "close" };

function rpcActions(view: UsageView, page: number, pageCount: number): RpcMenuItem[] {
  const actions: RpcMenuItem[] = [
    { label: "View: Overview", kind: "action", action: { type: "view", view: "overview" } },
    { label: "View: Models", kind: "action", action: { type: "view", view: "models" } },
    { label: "View: Delegation", kind: "action", action: { type: "view", view: "delegation" } },
    { label: "View: Daily", kind: "action", action: { type: "view", view: "daily" } },
    { label: "View: Stats", kind: "action", action: { type: "view", view: "stats" } },
    { label: "View: Hourly", kind: "action", action: { type: "view", view: "hourly" } },
    { label: "View: Providers", kind: "action", action: { type: "view", view: "providers" } },
    { label: "View: Wrapped AI", kind: "action", action: { type: "view", view: "wrapped" } },
  ];

  if (["overview", "models", "delegation"].includes(view.activeView)) {
    for (const [label, window] of [
      ["Window: 5 hours", "5h"],
      ["Window: 24 hours", "24h"],
      ["Window: 7 days", "7d"],
      ["Window: 30 days", "30d"],
      ["Window: All time", "all"],
    ] as const) {
      actions.push({ label, kind: "action", action: { type: "window", window } });
    }
  }
  if (view.activeView === "models") {
    actions.push(
      { label: "Sort models: Usage", kind: "action", action: { type: "modelSort", sort: "value" } },
      { label: "Sort models: Name", kind: "action", action: { type: "modelSort", sort: "name" } },
    );
  }
  if (view.activeView === "daily") {
    actions.push(
      {
        label: "Sort daily: Tokens (toggle direction)",
        kind: "action",
        action: { type: "dailySort", sort: "tokens" },
      },
      {
        label: "Sort daily: Cost (toggle direction)",
        kind: "action",
        action: { type: "dailySort", sort: "cost" },
      },
      {
        label: "Sort daily: Date (toggle direction)",
        kind: "action",
        action: { type: "dailySort", sort: "date" },
      },
    );
  }
  if (view.activeView === "stats") {
    actions.push(
      {
        label: "Stats range: All time",
        kind: "action",
        action: { type: "statsRange", range: "all" },
      },
      {
        label: "Stats range: 30 days",
        kind: "action",
        action: { type: "statsRange", range: "30d" },
      },
      { label: "Stats range: 7 days", kind: "action", action: { type: "statsRange", range: "7d" } },
    );
  }
  if (view.activeView === "providers") {
    actions.push(
      {
        label: "Sort providers: Usage",
        kind: "action",
        action: { type: "providerSort", sort: "value" },
      },
      {
        label: "Sort providers: Name",
        kind: "action",
        action: { type: "providerSort", sort: "name" },
      },
    );
  }
  if (view.activeView === "wrapped") {
    for (const year of view.wrappedYears) {
      actions.push({
        label: `Wrapped year: ${year}`,
        kind: "action",
        action: { type: "wrappedYear", year },
      });
    }
  }
  if (page > 0) actions.push({ label: "Page: Previous", kind: "previous" });
  if (page + 1 < pageCount) actions.push({ label: "Page: Next", kind: "next" });
  actions.push(
    { label: "Refresh usage and provider quota", kind: "action", action: { type: "refresh" } },
    { label: "Configure usage budgets", kind: "action", action: { type: "configure" } },
    { label: "Close usage dashboard", kind: "close" },
  );
  return actions;
}

function requireUI(ctx: ExtensionContext, command: string): void {
  if (!ctx.hasUI) {
    throw new Error(
      `${command} requires interactive TUI or RPC mode; rerun Pi without print/JSON mode`,
    );
  }
}

/** Parse a user-entered USD string into a number (0 on invalid/empty). */
function parseUsd(input: string | undefined): number {
  if (!input) return 0;
  const n = Number.parseFloat(input.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
