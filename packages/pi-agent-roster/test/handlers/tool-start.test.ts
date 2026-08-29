import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolStartWidget } from "../../src/handlers/tool-start.ts";
import { ToolStartHandler } from "../../src/handlers/tool-start.ts";

describe("ToolStartHandler", () => {
  let widget: ToolStartWidget;
  let mockSetUICtx: ReturnType<typeof vi.fn<ToolStartWidget["setUICtx"]>>;
  let handler: ToolStartHandler;

  beforeEach(() => {
    mockSetUICtx = vi.fn();
    widget = { setUICtx: mockSetUICtx };
    handler = new ToolStartHandler(widget);
  });

  describe("handleToolExecutionStart", () => {
    it("calls setUICtx with the context's ui", () => {
      const ui = { setStatus: vi.fn(), setWidget: vi.fn() };

      handler.handleToolExecutionStart({}, { ui });

      expect(widget.setUICtx).toHaveBeenCalledWith(ui);
    });
  });
});
