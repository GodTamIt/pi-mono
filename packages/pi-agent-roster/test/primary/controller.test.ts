import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types.ts";
import {
  MANAGED_SUBAGENT_TOOLS,
  PRIMARY_AGENT_FLAG,
  PRIMARY_STACK_FLAG,
  PrimaryController,
} from "../../src/primary/controller.ts";
import { AgentStackOverrides } from "../../src/stacks/stack-resolver.ts";
import type { AgentConfig } from "../../src/types.ts";
import { makeModel } from "../helpers/make-model.ts";

const baseModel = makeModel({ id: "base" });
const primaryModel = makeModel({ id: "primary", reasoning: true });

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "lead",
    name: "Lead",
    description: "Lead",
    mode: "primary",
    systemPrompt: "Lead the work.",
    promptMode: "append",
    model: "anthropic/primary",
    thinking: "high",
    permission: { bash: "deny" },
    ...overrides,
  };
}

function harness(
  agent = config(),
  flags: Record<string, string | undefined> = {},
  initialTools = ["read", "bash", ...MANAGED_SUBAGENT_TOOLS],
) {
  const child = config({
    id: "worker",
    name: "Worker",
    mode: "subagent",
    model: "anthropic/base",
    permission: { "*": "deny", read: "allow" },
  });
  const registry = new AgentTypeRegistry(
    () =>
      new Map([
        [agent.name, agent],
        [child.name, child],
      ]),
  );
  let active = [...initialTools];
  let thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> = "medium";
  let model = baseModel;
  const calls: string[] = [];
  const notify = vi.fn();
  const setStatus = vi.fn();
  const custom = vi.fn<(...args: any[]) => Promise<string | undefined>>(async () => undefined);
  const pi = {
    getFlag: vi.fn((name: string) => flags[name]),
    getThinkingLevel: vi.fn(() => thinking),
    setThinkingLevel: vi.fn((value) => {
      calls.push(`thinking:${value}`);
      thinking = value;
    }),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((value: string[]) => {
      calls.push(`tools:${value.join(",")}`);
      active = [...value];
    }),
    getAllTools: vi.fn(() => ["read", "bash", ...MANAGED_SUBAGENT_TOOLS].map((name) => ({ name }))),
    setModel: vi.fn(async (value) => {
      calls.push(`model:${value.id}`);
      model = value;
      return true;
    }),
  } as unknown as ExtensionAPI;
  const ctx = {
    get model() {
      return model;
    },
    modelRegistry: {
      find: (_provider: string, id: string) =>
        [baseModel, primaryModel].find((item) => item.id === id),
      getAll: () => [baseModel, primaryModel],
      getAvailable: () => [baseModel, primaryModel],
    },
    getSystemPrompt: () => "Baseline prompt",
    ui: { notify, setStatus, custom },
  } as unknown as ExtensionContext;
  const overrides = new AgentStackOverrides();
  const controller = new PrimaryController({ pi, registry, stackOverrides: overrides });
  return {
    controller,
    ctx,
    pi,
    registry,
    overrides,
    calls,
    notify,
    setStatus,
    custom,
    getActive: () => active,
  };
}

function renderPickerFactory(factory: unknown, width = 80): string[] {
  let component: { render(width: number): string[] } | undefined;
  const create = factory as (
    tui: { requestRender(): void },
    theme: { fg(_color: string, text: string): string; bold(text: string): string },
    keybindings: object,
    done: (value: string | undefined) => void,
  ) => { render(width: number): string[] };
  component = create(
    { requestRender: () => undefined },
    { fg: (_color, text) => text, bold: (text) => text },
    {},
    () => undefined,
  );
  return component.render(width);
}

describe("PrimaryController", () => {
  it("captures the baseline and applies startup state in model, thinking, tools order", async () => {
    const h = harness(config(), { [PRIMARY_AGENT_FLAG]: "lead" });

    await h.controller.handleSessionStart(h.ctx);

    expect(h.calls.slice(0, 3)).toEqual([
      "model:primary",
      "thinking:high",
      `tools:read,${MANAGED_SUBAGENT_TOOLS.join(",")}`,
    ]);
    expect(h.controller.beforeAgentStart({ systemPrompt: "Turn prompt" } as never)).toEqual({
      systemPrompt: "Baseline prompt\n\nLead the work.",
    });
    expect(h.setStatus).toHaveBeenLastCalledWith(
      "primary-agent",
      "Primary: Lead · stack: default",
    );
    expect(h.controller.authorizeTarget("WORKER")).toBeUndefined();
  });

  it("clears the primary status at session start and disposal", async () => {
    const h = harness(config(), { [PRIMARY_AGENT_FLAG]: "lead" });

    await h.controller.handleSessionStart(h.ctx);

    expect(h.setStatus).toHaveBeenNthCalledWith(1, "primary-agent", undefined);
    expect(h.setStatus).toHaveBeenLastCalledWith(
      "primary-agent",
      "Primary: Lead · stack: default",
    );

    h.controller.dispose();

    expect(h.setStatus).toHaveBeenLastCalledWith("primary-agent", undefined);
  });

  it("does not re-enable managed tools denied by primary permissions", async () => {
    const h = harness(config({ permission: { "*": "deny", read: "allow" } }), {
      [PRIMARY_AGENT_FLAG]: "lead",
    });
    await h.controller.handleSessionStart(h.ctx);
    expect(h.getActive()).toEqual(["read"]);
  });

  it("warns and applies primary selection with an unknown exact permission key", async () => {
    const h = harness(config({ permission: { missing_tool: "deny" } }), {
      [PRIMARY_AGENT_FLAG]: "lead",
    });
    await h.controller.handleSessionStart(h.ctx);
    expect(h.pi.setModel).toHaveBeenCalledWith(primaryModel);
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("unknown tools: missing_tool"),
      "warning",
    );
  });

  it("requires --stack to accompany an enabled non-default primary without mutating startup state", async () => {
    const h = harness(config(), { [PRIMARY_STACK_FLAG]: "deep" });

    await h.controller.handleSessionStart(h.ctx);

    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("requires --agent"), "error");

    const defaultAgent = harness(config(), {
      [PRIMARY_AGENT_FLAG]: "default",
      [PRIMARY_STACK_FLAG]: "deep",
    });
    await defaultAgent.controller.handleSessionStart(defaultAgent.ctx);
    expect(defaultAgent.pi.setModel).not.toHaveBeenCalled();
    expect(defaultAgent.notify).toHaveBeenCalledWith(
      expect.stringContaining("requires an enabled primary"),
      "error",
    );
  });

  it("activates managed tools for the default state when an eligible child exists", async () => {
    const h = harness(config(), {}, ["read", "bash"]);

    await h.controller.handleSessionStart(h.ctx);

    expect(h.getActive()).toEqual(["read", "bash", ...MANAGED_SUBAGENT_TOOLS]);
  });

  it("enforces allowed agents and hides only managed tools when none are authorized", async () => {
    const h = harness(config({ allowedAgents: [] }), { [PRIMARY_AGENT_FLAG]: "lead" });

    await h.controller.handleSessionStart(h.ctx);

    expect(h.controller.authorizeTarget("worker")).toContain("not authorized");
    expect(h.getActive()).toEqual(["read"]);
  });

  it("waits for idle and restores the captured default without switching sessions", async () => {
    const h = harness(config(), { [PRIMARY_AGENT_FLAG]: "lead" });
    await h.controller.handleSessionStart(h.ctx);
    const waitForIdle = vi.fn(async () => undefined);

    await h.controller.handleAgentCommand("default", {
      ...h.ctx,
      waitForIdle,
    } as unknown as ExtensionCommandContext);

    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(h.calls.slice(-3)).toEqual([
      "model:base",
      "thinking:medium",
      `tools:read,bash,${MANAGED_SUBAGENT_TOOLS.join(",")}`,
    ]);
    expect(h.controller.beforeAgentStart({ systemPrompt: "mutated prompt" } as never)).toEqual({
      systemPrompt: "Baseline prompt",
    });
    expect(h.setStatus).toHaveBeenLastCalledWith("primary-agent", undefined);
  });

  it("uses an empty replacement body instead of the captured baseline", async () => {
    const h = harness(config({ promptMode: "replace", systemPrompt: "" }), {
      [PRIMARY_AGENT_FLAG]: "lead",
    });
    await h.controller.handleSessionStart(h.ctx);
    expect(h.controller.beforeAgentStart({ systemPrompt: "ignored" } as never)).toEqual({
      systemPrompt: "",
    });
  });

  it("always derives selected prompts from the captured startup baseline", async () => {
    const lead = config();
    const h = harness(lead);
    await h.controller.handleSessionStart(h.ctx);
    const commandCtx = {
      ...h.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext;

    await h.controller.handleAgentCommand("lead", commandCtx);
    expect(h.controller.beforeAgentStart({ systemPrompt: "ambient mutation" } as never)).toEqual({
      systemPrompt: "Baseline prompt\n\nLead the work.",
    });

    lead.promptMode = "replace";
    lead.systemPrompt = "Fresh replacement.";
    await h.controller.handleAgentCommand("lead", commandCtx);
    expect(h.controller.beforeAgentStart({ systemPrompt: "another mutation" } as never)).toEqual({
      systemPrompt: "Fresh replacement.",
    });
  });

  it("sets and clears session-local stacks, reapplying the selected primary", async () => {
    const lead = config({
      stacks: new Map([["light", { model: "anthropic/base", thinking: "low" }]]),
    });
    const h = harness(lead, { [PRIMARY_AGENT_FLAG]: "lead" });
    await h.controller.handleSessionStart(h.ctx);
    const commandCtx = {
      ...h.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext;

    await h.controller.handleStackCommand("lead light", commandCtx);

    expect(h.overrides.get(lead)).toBe("light");
    expect(h.controller.getPropagatedStack()).toEqual({
      stack: "light",
      fallbackModel: baseModel,
      fallbackThinking: undefined,
    });
    expect(h.calls.slice(-3)).toEqual([
      "model:base",
      "thinking:off",
      `tools:read,${MANAGED_SUBAGENT_TOOLS.join(",")}`,
    ]);
    expect(h.setStatus).toHaveBeenLastCalledWith(
      "primary-agent",
      "Primary: Lead · stack: light",
    );

    await h.controller.handleStackCommand("lead auto", commandCtx);
    expect(h.overrides.get(lead)).toBeUndefined();
    expect(h.controller.getPropagatedStack()).toEqual({
      stack: "default",
      fallbackModel: primaryModel,
      fallbackThinking: "high",
    });
  });

  it("rejects subagent stack overrides while a primary stack is active", async () => {
    const h = harness(config(), { [PRIMARY_AGENT_FLAG]: "lead" });
    await h.controller.handleSessionStart(h.ctx);
    const commandCtx = {
      ...h.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext;

    await h.controller.handleStackCommand("worker default", commandCtx);

    expect(h.notify).toHaveBeenLastCalledWith(
      'Subagent "Worker" cannot override active primary "Lead" stack "default".',
      "error",
    );
    expect(h.controller.getStackArgumentCompletions("")?.map((item) => item.label)).toEqual([
      "Lead",
    ]);
    expect(h.controller.getStackArgumentCompletions("worker ")).toBeNull();
  });

  it("refreshes command discovery before resolving an agent or stack", async () => {
    const lead = config({
      stacks: new Map([["light", { model: "anthropic/base" }]]),
    });
    const h = harness(lead);
    await h.controller.handleSessionStart(h.ctx);
    const commandCtx = {
      ...h.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext;
    const reload = vi.spyOn(h.registry, "reload");

    await h.controller.handleAgentCommand("lead", commandCtx);
    await h.controller.handleStackCommand("lead light", commandCtx);

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("rebases authorization from fresh primary config before delegation", async () => {
    const lead = config();
    const h = harness(lead, { [PRIMARY_AGENT_FLAG]: "lead" });
    await h.controller.handleSessionStart(h.ctx);

    lead.allowedAgents = [];
    h.controller.reconcileBeforeDelegation();

    expect(h.controller.authorizeTarget("worker")).toContain("not authorized");
    expect(h.getActive()).toEqual(["read"]);
  });

  it("reapplies refreshed primary permissions before delegation", async () => {
    const lead = config({ permission: undefined });
    const h = harness(lead, { [PRIMARY_AGENT_FLAG]: "lead" });
    await h.controller.handleSessionStart(h.ctx);

    lead.permission = { "*": "deny", read: "allow" };
    h.controller.reconcileBeforeDelegation();

    expect(h.getActive()).toEqual(["read"]);
  });

  it("denies delegation when the selected primary becomes ineligible until reload restores default", async () => {
    const lead = config();
    const h = harness(lead, { [PRIMARY_AGENT_FLAG]: "lead" });
    await h.controller.handleSessionStart(h.ctx);

    lead.enabled = false;
    h.controller.reconcileBeforeDelegation();

    expect(h.controller.authorizeTarget("worker")).toContain("no longer eligible");
    expect(h.getActive()).toEqual(["read"]);

    await h.controller.reload({
      ...h.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext);
    expect(h.calls.slice(-3)).toEqual([
      "model:base",
      "thinking:medium",
      `tools:read,bash,${MANAGED_SUBAGENT_TOOLS.join(",")}`,
    ]);
    expect(h.controller.authorizeTarget("worker")).toBeUndefined();
  });

  it("opens the primary picker without waiting and cancels without mutation", async () => {
    const h = harness();
    await h.controller.handleSessionStart(h.ctx);
    h.calls.length = 0;
    const waitForIdle = vi.fn(async () => undefined);

    await h.controller.handleAgentCommand("", {
      ...h.ctx,
      waitForIdle,
    } as unknown as ExtensionCommandContext);

    expect(h.custom).toHaveBeenCalledOnce();
    const lines = renderPickerFactory(h.custom.mock.calls[0]![0], 60).join("\n");
    expect(lines).toContain("Select primary agent");
    expect(lines).toContain("Pi default · Default · Current");
    expect(lines).toContain("stack: default");
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it("marks the selected primary current while retaining the synthetic default row", async () => {
    const h = harness();
    await h.controller.handleSessionStart(h.ctx);
    const commandCtx = {
      ...h.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext;
    await h.controller.handleAgentCommand("lead", commandCtx);

    await h.controller.handleAgentCommand("", commandCtx);

    const lines = renderPickerFactory(h.custom.mock.calls[0]![0], 120).join("\n");
    expect(lines).toContain("Pi default · Default");
    expect(lines).toContain("Lead · Current");
    expect(lines).toContain("stack: default · model: anthropic/primary · thinking: high");
  });

  it("completes stack command agents and their available stacks", () => {
    const lead = config({
      stacks: new Map([
        ["default", { model: "anthropic/primary", thinking: "high" }],
        ["light", { model: "anthropic/base", thinking: "low" }],
      ]),
    });
    const h = harness(lead);

    expect(h.controller.getStackArgumentCompletions("l")).toEqual([
      { value: "Lead ", label: "Lead", description: "Lead" },
    ]);
    expect(h.controller.getStackArgumentCompletions("lead ")?.map((item) => item.label)).toEqual([
      "auto",
      "default",
      "light",
    ]);
    expect(h.controller.getStackArgumentCompletions("lead d")).toEqual([
      {
        value: "Lead default",
        label: "default",
        description: "Use the named default stack, or the synthetic fallback.",
      },
    ]);
    expect(h.controller.getStackArgumentCompletions("missing ")).toBeNull();
  });

  it("opens the active primary stack picker directly and waits only after selection", async () => {
    const lead = config({
      stacks: new Map([["light", { model: "anthropic/base", thinking: "low" }]]),
    });
    const h = harness(lead, { [PRIMARY_AGENT_FLAG]: "lead" });
    await h.controller.handleSessionStart(h.ctx);
    h.custom.mockResolvedValueOnce("light");
    const waitForIdle = vi.fn(async () => undefined);

    await h.controller.handleStackCommand("", {
      ...h.ctx,
      waitForIdle,
    } as unknown as ExtensionCommandContext);

    expect(h.custom).toHaveBeenCalledOnce();
    const lines = renderPickerFactory(h.custom.mock.calls[0]![0], 120).join("\n");
    expect(lines).toContain("Select stack for Lead");
    expect(lines).not.toContain("Select agent");
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(h.overrides.get(lead)).toBe("light");
  });

  it("requires a roster primary before opening the no-argument stack picker", async () => {
    const h = harness();
    await h.controller.handleSessionStart(h.ctx);
    const waitForIdle = vi.fn(async () => undefined);

    await h.controller.handleStackCommand("", {
      ...h.ctx,
      waitForIdle,
    } as unknown as ExtensionCommandContext);

    expect(h.custom).not.toHaveBeenCalled();
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenLastCalledWith(
      "No roster primary is active. Select one with /agent first.",
      "warning",
    );
  });

  it("cancels the active primary stack picker without waiting or changing the override", async () => {
    const lead = config({ stacks: new Map([["light", { model: "anthropic/base" }]]) });
    const h = harness(lead, { [PRIMARY_AGENT_FLAG]: "lead" });
    await h.controller.handleSessionStart(h.ctx);
    h.custom.mockResolvedValueOnce(undefined);
    const waitForIdle = vi.fn(async () => undefined);

    await h.controller.handleStackCommand("", {
      ...h.ctx,
      waitForIdle,
    } as unknown as ExtensionCommandContext);

    expect(h.custom).toHaveBeenCalledOnce();
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(h.overrides.get(lead)).toBeUndefined();
  });

  it("shows auto, synthetic default, frontmatter stacks, and the current override", async () => {
    const lead = config({
      stacks: new Map([
        ["light", { model: "anthropic/base", thinking: "low" }],
        ["deep", { model: "anthropic/primary", thinking: "high" }],
      ]),
    });
    const h = harness(lead);
    await h.controller.handleSessionStart(h.ctx);
    const commandCtx = {
      ...h.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext;
    await h.controller.handleStackCommand("lead light", commandCtx);

    await h.controller.handleStackCommand("lead", commandCtx);

    const lines = renderPickerFactory(h.custom.mock.calls[0]![0], 120).join("\n");
    expect(lines).toContain("auto");
    expect(lines).toContain("default · Default");
    expect(lines).toContain("light · Current override");
    expect(lines).toContain("deep");
    expect(lines).toContain("model: anthropic/base · thinking: off");
  });

  it("routes direct and picked primary values through the same validation", async () => {
    const direct = harness();
    await direct.controller.handleSessionStart(direct.ctx);
    await direct.controller.handleAgentCommand("missing", {
      ...direct.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext);

    const picked = harness();
    await picked.controller.handleSessionStart(picked.ctx);
    picked.custom.mockResolvedValueOnce("missing");
    await picked.controller.handleAgentCommand("", {
      ...picked.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext);

    expect(picked.notify.mock.calls.at(-1)).toEqual(direct.notify.mock.calls.at(-1));
  });

  it("routes direct and picked stack values through the same validation", async () => {
    const lead = config({ stacks: new Map([["light", { model: "anthropic/base" }]]) });
    const direct = harness(lead);
    await direct.controller.handleSessionStart(direct.ctx);
    await direct.controller.handleStackCommand("lead missing", {
      ...direct.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext);

    const picked = harness(lead);
    await picked.controller.handleSessionStart(picked.ctx);
    picked.custom.mockResolvedValueOnce("missing");
    await picked.controller.handleStackCommand("lead", {
      ...picked.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext);

    expect(picked.notify.mock.calls.at(-1)).toEqual(direct.notify.mock.calls.at(-1));
    expect(picked.overrides.get(lead)).toBeUndefined();
  });

  it("rolls model back when a later mutation fails", async () => {
    const h = harness(config());
    await h.controller.handleSessionStart(h.ctx);
    h.setStatus.mockClear();
    vi.mocked(h.pi.setThinkingLevel).mockImplementationOnce(() => {
      throw new Error("thinking failed");
    });
    const commandCtx = {
      ...h.ctx,
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ExtensionCommandContext;

    await h.controller.handleAgentCommand("lead", commandCtx);

    expect(h.calls.filter((call) => call.startsWith("model:"))).toEqual([
      "model:primary",
      "model:base",
    ]);
    expect(h.notify).toHaveBeenCalledWith("thinking failed", "error");
    expect(h.setStatus).not.toHaveBeenCalled();
  });
});
