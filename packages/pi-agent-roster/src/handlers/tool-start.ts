/**
 * tool_execution_start event handler.
 *
 * Extracted from index.ts so the handler can be tested in isolation
 * with a mocked narrow runtime interface.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Narrow widget interface — only the methods the handler calls. */
export interface ToolStartWidget {
  setUICtx(ctx: unknown, mode: ExtensionContext["mode"], hasUI: boolean): void;
}

/** Minimal context shape for tool_execution_start — only the fields the handler reads. */
interface ToolStartCtx {
  ui: unknown;
  mode: ExtensionContext["mode"];
  hasUI: boolean;
}

/**
 * Handles tool_execution_start events.
 *
 * Grabs UI context from the first tool execution of each turn.
 */
export class ToolStartHandler {
  constructor(private readonly widget: ToolStartWidget) {}

  handleToolExecutionStart(_event: unknown, ctx: ToolStartCtx): void {
    this.widget.setUICtx(ctx.ui, ctx.mode, ctx.hasUI);
  }
}
