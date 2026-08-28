import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ROSTER_NAME_FLAG, ROSTER_NOOP_TOOL, ROSTER_STATUS_COMMAND } from "./public.ts";

export default function piAgentRoster(pi: ExtensionAPI): void {
  pi.registerFlag(ROSTER_NAME_FLAG, {
    description: "Name this roster instance",
    type: "string",
    default: "default",
  });

  pi.registerTool({
    name: ROSTER_NOOP_TOOL,
    label: "Roster No-op",
    description: "Confirm that the agent roster tool runtime is available without changing state",
    parameters: Type.Object({
      note: Type.Optional(Type.String({ description: "Optional note returned unchanged" })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: params.note ?? "pi-agent-roster is ready" }],
        details: {},
      };
    },
  });

  pi.registerCommand(ROSTER_STATUS_COMMAND, {
    description: "Show whether the agent roster extension is ready",
    handler: async (_args, ctx) => {
      const name = String(pi.getFlag(ROSTER_NAME_FLAG) ?? "default");
      const ready = pi.getAllTools().some((tool) => tool.name === ROSTER_NOOP_TOOL);
      ctx.ui.notify(
        `Roster ${name}: ${ready ? `${ROSTER_NOOP_TOOL} ready` : "tool unavailable"}`,
        ready ? "info" : "error",
      );
    },
  });
}
