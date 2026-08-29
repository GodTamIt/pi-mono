import { describe, expect, it } from "vitest";
import {
  resolvePermittedToolNames,
  unknownPermissionToolNames,
} from "../../src/config/tool-permissions.ts";

describe("tool permissions", () => {
  const available = ["read", "bash", "edit", "extension_tool"];

  it("allows every available tool when permission is absent or has no wildcard", () => {
    expect(resolvePermittedToolNames(available, undefined)).toEqual(available);
    expect(resolvePermittedToolNames(available, { bash: "deny" })).toEqual([
      "read",
      "edit",
      "extension_tool",
    ]);
  });

  it("applies wildcard deny with exact allows independent of mapping order", () => {
    expect(
      resolvePermittedToolNames(available, {
        read: "allow",
        "*": "deny",
        extension_tool: "allow",
      }),
    ).toEqual(["read", "extension_tool"]);
  });

  it("lets exact entries override wildcard allow", () => {
    expect(resolvePermittedToolNames(available, { bash: "deny", "*": "allow" })).toEqual([
      "read",
      "edit",
      "extension_tool",
    ]);
  });

  it("reports unknown exact keys but never the wildcard", () => {
    expect(unknownPermissionToolNames(available, { "*": "deny", missing: "allow" })).toEqual([
      "missing",
    ]);
  });
});
