import type { ToolPermission, ToolPermissions } from "../types.ts";

/** Return exact permission keys that are not present in the available tool set. */
export function unknownPermissionToolNames(
  availableToolNames: Iterable<string>,
  permission: ToolPermissions | undefined,
): string[] {
  if (!permission) return [];
  const available = new Set(availableToolNames);
  return Object.keys(permission).filter((name) => name !== "*" && !available.has(name));
}

/** Resolve an ordered available tool set using wildcard defaults and exact overrides. */
export function resolvePermittedToolNames(
  availableToolNames: Iterable<string>,
  permission: ToolPermissions | undefined,
): string[] {
  const available = [...new Set(availableToolNames)];
  const fallback: ToolPermission = permission?.["*"] ?? "allow";
  return available.filter((name) => (permission?.[name] ?? fallback) === "allow");
}
