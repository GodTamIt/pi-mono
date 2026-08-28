// ---- Narrow interfaces ----

/** The toast a settings mutation returns for the UI to display. */
export interface SettingsToast {
  message: string;
  level: "info" | "warning";
}

/** Narrow settings interface required by the subagents:settings command. */
export interface SubagentsSettingsManager {
  readonly maxConcurrent: number;
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number | undefined;
  readonly consumedSessionRetentionMinutes: number;
  readonly unconsumedSessionRetentionMinutes: number;
  readonly abortAllOnInterrupt: boolean;
  applyMaxConcurrent(n: number): SettingsToast;
  applyDefaultMaxTurns(n: number | undefined): SettingsToast;
  applyGraceTurns(n: number | undefined): SettingsToast;
  applyConsumedSessionRetentionMinutes(n: number): SettingsToast;
  applyUnconsumedSessionRetentionMinutes(n: number): SettingsToast;
  toggleAbortAllOnInterrupt(): SettingsToast;
}

/** Narrow UI interface — only the ctx.ui methods the settings handler calls. */
export interface SubagentsSettingsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, defaultValue?: string): Promise<string | undefined> | undefined;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

// ---- Descriptor table ----

/** Fields every setting needs to render its line in the select list. */
interface SettingDescriptorBase {
  /** Prefix used both to build the select option and to match the user's choice. */
  label: string;
  /** Current value rendered in the select option (e.g. "unlimited" for an unset default). */
  currentDisplay: (settings: SubagentsSettingsManager) => string | number;
}

/** Describes one numeric setting's prompt, validation, and apply behavior. */
interface NumericSettingDescriptorBase extends SettingDescriptorBase {
  kind: "numeric";
  /** Title shown on the input prompt. */
  inputTitle: string;
  /** Value pre-filled into the input box. */
  inputDefault: (settings: SubagentsSettingsManager) => string;
  /** Accepted integer range, inclusive. */
  minimum: number;
  maximum: number;
  validationMessage: string;
  apply: (settings: SubagentsSettingsManager, n: number) => SettingsToast;
}

interface RequiredNumericSettingDescriptor extends NumericSettingDescriptorBase {
  allowUnlimited?: false | undefined;
}

interface OptionalNumericSettingDescriptor extends NumericSettingDescriptorBase {
  /** Blank or "unlimited" clears the project override. */
  allowUnlimited: true;
  clear: (settings: SubagentsSettingsManager) => SettingsToast;
}

type NumericSettingDescriptor = RequiredNumericSettingDescriptor | OptionalNumericSettingDescriptor;

/** Describes one boolean setting, flipped directly from the select list. */
interface ToggleSettingDescriptor extends SettingDescriptorBase {
  kind: "toggle";
  /** Flips the setting and returns the toast to display. */
  toggle: (settings: SubagentsSettingsManager) => SettingsToast;
}

type SettingDescriptor = NumericSettingDescriptor | ToggleSettingDescriptor;

const SETTINGS: readonly SettingDescriptor[] = [
  {
    kind: "numeric",
    label: "Max concurrency",
    currentDisplay: (settings) => settings.maxConcurrent,
    inputTitle: "Max concurrent background agents",
    inputDefault: (settings) => String(settings.maxConcurrent),
    minimum: 1,
    maximum: 1024,
    validationMessage: "Must be an integer from 1 through 1024.",
    apply: (settings, n) => settings.applyMaxConcurrent(n),
  },
  {
    kind: "numeric",
    label: "Default max turns",
    currentDisplay: (settings) => settings.defaultMaxTurns ?? "unlimited",
    inputTitle: 'Default max turns before wrap-up (1–10000; blank or "unlimited" clears)',
    inputDefault: (settings) => String(settings.defaultMaxTurns ?? "unlimited"),
    minimum: 1,
    maximum: 10000,
    allowUnlimited: true,
    validationMessage: 'Must be an integer from 1 through 10000 or "unlimited".',
    apply: (settings, n) => settings.applyDefaultMaxTurns(n),
    clear: (settings) => settings.applyDefaultMaxTurns(undefined),
  },
  {
    kind: "numeric",
    label: "Grace turns",
    currentDisplay: (settings) => settings.graceTurns ?? "unlimited",
    inputTitle: 'Grace turns after wrap-up request (0–1000; blank or "unlimited" clears)',
    inputDefault: (settings) => String(settings.graceTurns ?? "unlimited"),
    minimum: 0,
    maximum: 1000,
    allowUnlimited: true,
    validationMessage: 'Must be an integer from 0 through 1000 or "unlimited".',
    apply: (settings, n) => settings.applyGraceTurns(n),
    clear: (settings) => settings.applyGraceTurns(undefined),
  },
  {
    kind: "numeric",
    label: "Consumed-session retention",
    currentDisplay: (settings) => `${settings.consumedSessionRetentionMinutes} min`,
    inputTitle: "Minutes to retain a consumed agent's session",
    inputDefault: (settings) => String(settings.consumedSessionRetentionMinutes),
    minimum: 1,
    maximum: 20160,
    validationMessage: "Must be an integer from 1 through 20160.",
    apply: (settings, n) => settings.applyConsumedSessionRetentionMinutes(n),
  },
  {
    kind: "numeric",
    label: "Unconsumed-session retention",
    currentDisplay: (settings) => `${settings.unconsumedSessionRetentionMinutes} min`,
    inputTitle: "Minutes to retain an unconsumed agent's session (safety cap)",
    inputDefault: (settings) => String(settings.unconsumedSessionRetentionMinutes),
    minimum: 1,
    maximum: 20160,
    validationMessage: "Must be an integer from 1 through 20160.",
    apply: (settings, n) => settings.applyUnconsumedSessionRetentionMinutes(n),
  },
  {
    kind: "toggle",
    label: "Abort all subagents on ESC",
    currentDisplay: (settings) => (settings.abortAllOnInterrupt ? "on" : "off"),
    toggle: (settings) => settings.toggleAbortAllOnInterrupt(),
  },
];

// ---- Class ----

/**
 * Handler for the `/subagents:settings` slash command.
 *
 * Call `handle({ ui })` from the Pi command registration to open the interactive
 * settings list. Lifted from `AgentsMenuHandler.showSettings`.
 */
export class SubagentsSettingsHandler {
  constructor(private readonly settings: SubagentsSettingsManager) {}

  async handle({ ui }: { ui: SubagentsSettingsUI }): Promise<void> {
    const options = SETTINGS.map((d) => `${d.label} (current: ${d.currentDisplay(this.settings)})`);
    const choice = await ui.select("Project settings (global defaults are read-only)", options);
    if (!choice) return;

    const descriptor = SETTINGS.find((d) => choice.startsWith(d.label));
    if (!descriptor) return;

    if (descriptor.kind === "toggle") {
      const toast = descriptor.toggle(this.settings);
      ui.notify(toast.message, toast.level);
      return;
    }

    await this.promptNumeric(ui, descriptor);
  }

  /** Ask for a number, validate it against the descriptor, apply it, and notify. */
  private async promptNumeric(
    ui: SubagentsSettingsUI,
    descriptor: NumericSettingDescriptor,
  ): Promise<void> {
    const val = await ui.input(descriptor.inputTitle, descriptor.inputDefault(this.settings));
    if (val === undefined) return;

    const input = val.trim();
    if (descriptor.allowUnlimited && (input === "" || input.toLowerCase() === "unlimited")) {
      const toast = descriptor.clear(this.settings);
      ui.notify(toast.message, toast.level);
      return;
    }
    const n = Number(input);
    if (
      /^\d+$/.test(input) &&
      Number.isInteger(n) &&
      n >= descriptor.minimum &&
      n <= descriptor.maximum
    ) {
      const toast = descriptor.apply(this.settings, n);
      ui.notify(toast.message, toast.level);
    } else {
      ui.notify(descriptor.validationMessage, "warning");
    }
  }
}
