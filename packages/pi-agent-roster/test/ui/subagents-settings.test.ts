import { describe, expect, it, vi } from "vitest";
import { SubagentsSettingsHandler } from "../../src/ui/subagents-settings.ts";
import { makeMenuUI } from "../helpers/ui-stubs.ts";

function toast(message: string) {
  return { message, level: "info" as const };
}

function makeSettings() {
  return {
    maxConcurrent: 4,
    defaultMaxTurns: undefined as number | undefined,
    graceTurns: undefined as number | undefined,
    consumedSessionRetentionMinutes: 10,
    unconsumedSessionRetentionMinutes: 720,
    abortAllOnInterrupt: true,
    applyMaxConcurrent: vi.fn(() => toast("Max concurrency updated")),
    applyDefaultMaxTurns: vi.fn(() => toast("Default max turns updated")),
    applyGraceTurns: vi.fn(() => toast("Grace turns updated")),
    applyConsumedSessionRetentionMinutes: vi.fn(() => toast("Consumed retention updated")),
    applyUnconsumedSessionRetentionMinutes: vi.fn(() => toast("Unconsumed retention updated")),
    toggleAbortAllOnInterrupt: vi.fn(() => toast("Interrupt policy updated")),
  };
}

function makeHandler(settings = makeSettings()) {
  return { handler: new SubagentsSettingsHandler(settings), settings };
}

describe("SubagentsSettingsHandler", () => {
  it("labels the UI as project-only and shows effective unlimited budgets", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI([undefined]);

    await handler.handle({ ui });

    expect(ui.select).toHaveBeenCalledWith("Project settings (global defaults are read-only)", [
      "Max concurrency (current: 4)",
      "Default max turns (current: unlimited)",
      "Grace turns (current: unlimited)",
      "Consumed-session retention (current: 10 min)",
      "Unconsumed-session retention (current: 720 min)",
      "Abort all subagents on ESC (current: on)",
    ]);
  });

  it("does nothing when the settings list or input is cancelled", async () => {
    const first = makeHandler();
    await first.handler.handle({ ui: makeMenuUI([undefined]) });
    expect(first.settings.applyMaxConcurrent).not.toHaveBeenCalled();

    const second = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input.mockResolvedValue(undefined);
    await second.handler.handle({ ui });
    expect(second.settings.applyMaxConcurrent).not.toHaveBeenCalled();
  });

  it("applies bounded decimal values and reports the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input.mockResolvedValue(" 8 ");

    await handler.handle({ ui });

    expect(settings.applyMaxConcurrent).toHaveBeenCalledWith(8);
    expect(ui.notify).toHaveBeenCalledWith("Max concurrency updated", "info");
  });

  it.each(["4agents", "1e2", "0", "1025", ""])(
    "rejects malformed or out-of-range concurrency input %j",
    async (input) => {
      const { handler, settings } = makeHandler();
      const ui = makeMenuUI(["Max concurrency (current: 4)"]);
      ui.input.mockResolvedValue(input);

      await handler.handle({ ui });

      expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith("Must be an integer from 1 through 1024.", "warning");
    },
  );
});

describe("SubagentsSettingsHandler — optional turn budgets", () => {
  it("explains the max-turn range and allows blank input to clear it", async () => {
    const settings = makeSettings();
    settings.defaultMaxTurns = 20;
    const { handler } = makeHandler(settings);
    const ui = makeMenuUI(["Default max turns (current: 20)"]);
    ui.input.mockResolvedValue("");

    await handler.handle({ ui });

    expect(ui.input).toHaveBeenCalledWith(
      'Default max turns before wrap-up (1–10000; blank or "unlimited" clears)',
      "20",
    );
    expect(settings.applyDefaultMaxTurns).toHaveBeenCalledWith(undefined);
  });

  it("accepts unlimited case-insensitively when clearing grace turns", async () => {
    const settings = makeSettings();
    settings.graceTurns = 3;
    const { handler } = makeHandler(settings);
    const ui = makeMenuUI(["Grace turns (current: 3)"]);
    ui.input.mockResolvedValue(" Unlimited ");

    await handler.handle({ ui });

    expect(ui.input).toHaveBeenCalledWith(
      'Grace turns after wrap-up request (0–1000; blank or "unlimited" clears)',
      "3",
    );
    expect(settings.applyGraceTurns).toHaveBeenCalledWith(undefined);
  });

  it("keeps zero as a finite grace value", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Grace turns (current: unlimited)"]);
    ui.input.mockResolvedValue("0");

    await handler.handle({ ui });

    expect(settings.applyGraceTurns).toHaveBeenCalledWith(0);
  });

  it.each([
    {
      choice: "Default max turns (current: unlimited)",
      input: "0",
      message: 'Must be an integer from 1 through 10000 or "unlimited".',
    },
    {
      choice: "Grace turns (current: unlimited)",
      input: "1001",
      message: 'Must be an integer from 0 through 1000 or "unlimited".',
    },
  ])("rejects invalid finite budget input", async ({ choice, input, message }) => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI([choice]);
    ui.input.mockResolvedValue(input);

    await handler.handle({ ui });

    expect(settings.applyDefaultMaxTurns).not.toHaveBeenCalled();
    expect(settings.applyGraceTurns).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(message, "warning");
  });
});

describe("SubagentsSettingsHandler — existing controls", () => {
  it("preserves retention validation", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Consumed-session retention (current: 10 min)"]);
    ui.input.mockResolvedValue("20161");

    await handler.handle({ ui });

    expect(settings.applyConsumedSessionRetentionMinutes).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be an integer from 1 through 20160.", "warning");
  });

  it("keeps the interrupt policy as a direct toggle", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Abort all subagents on ESC (current: on)"]);

    await handler.handle({ ui });

    expect(settings.toggleAbortAllOnInterrupt).toHaveBeenCalledOnce();
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Interrupt policy updated", "info");
  });
});
