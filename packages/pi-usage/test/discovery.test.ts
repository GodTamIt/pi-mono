import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSelectedSessions, type ParentedSession } from "../src/aggregate.ts";

function writeJsonl(path: string, entries: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

const sessionHeader = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "session",
  version: 3,
  id: "header-id",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/proj",
  ...over,
});

const rootInfo = (path: string, id: string): SessionInfo => ({
  path,
  id,
  cwd: "/proj",
  created: new Date(1000),
  modified: new Date(2000),
  messageCount: 0,
  firstMessage: "",
  allMessagesText: "",
});

/** Fixture layout: `<dir>/parent.jsonl` with children under `<dir>/parent/tasks/`. */
function fixture(): { dir: string; parent: string; child: (name: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-discovery-"));
  const parent = join(dir, "parent.jsonl");
  return { dir, parent, child: (name: string) => join(dir, "parent", "tasks", name) };
}

describe("discoverSelectedSessions", () => {
  it("discovers header-declared children whether parentSession is an id or a path", () => {
    const { parent, child } = fixture();
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);
    writeJsonl(child("by-id.jsonl"), [sessionHeader({ id: "child-id", parentSession: "root-1" })]);
    writeJsonl(child("by-path.jsonl"), [
      sessionHeader({ id: "child-path", parentSession: parent }),
    ]);

    const sessions = discoverSelectedSessions([rootInfo(parent, "root-1")]);
    const children = sessions.filter((s) => s.info.id !== "root-1");
    expect(children.map((c) => c.info.id).sort()).toEqual(["child-id", "child-path"]);
    for (const c of children) {
      expect(c.delegated).toBe(true);
      expect(c.parentSessionId).toBe("root-1");
      expect(c.parentLabel).toBe("root-1");
    }
  });

  it("counts convention-path children as delegated even without parent metadata", () => {
    const { parent, child } = fixture();
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);
    writeJsonl(child("orphan.jsonl"), [sessionHeader({ id: "child-1" })]);

    const sessions = discoverSelectedSessions([rootInfo(parent, "root-1")]);
    const orphan = sessions.find((s) => s.info.id === "child-1");
    expect(orphan).toBeDefined();
    expect(orphan?.delegated).toBe(true);
    expect(orphan?.parentSessionId).toBe("root-1");
  });

  it("discovers deeply nested descendants of the selected root", () => {
    const { dir, parent, child } = fixture();
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);
    const leaf = join(dir, "parent", "tasks", "deep", "subagents", "leaf.jsonl");
    writeJsonl(leaf, [sessionHeader({ id: "leaf" })]);

    const sessions = discoverSelectedSessions([rootInfo(parent, "root-1")]);
    expect(sessions.find((s) => s.info.id === "leaf")).toBeDefined();
  });

  it("attaches direct sibling children and their nested descendants transitively", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-discovery-"));
    const parent = join(dir, "parent.jsonl");
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);
    // Child stored directly beside its parent (so listAll sees it).
    const sibling = join(dir, "sibling.jsonl");
    writeJsonl(sibling, [sessionHeader({ id: "child-1", parentSession: "root-1" })]);
    // Convention descendants are rooted at the transcript's file stem.
    const grandById = join(dir, "sibling", "tasks", "grand-by-id.jsonl");
    writeJsonl(grandById, [sessionHeader({ id: "grand-1", parentSession: "child-1" })]);
    const grandByPath = join(dir, "sibling", "tasks", "grand-by-path.jsonl");
    writeJsonl(grandByPath, [sessionHeader({ id: "grand-2", parentSession: sibling })]);
    // listAll may also report a direct grandchild beside both transcripts.
    const directGrand = join(dir, "direct-grand.jsonl");
    writeJsonl(directGrand, [sessionHeader({ id: "grand-3", parentSession: "child-1" })]);

    const parented: ParentedSession[] = [
      { info: rootInfo(sibling, "child-1"), parentSession: "root-1" },
      { info: rootInfo(directGrand, "grand-3"), parentSession: "child-1" },
    ];
    const sessions = discoverSelectedSessions([rootInfo(parent, "root-1")], parented);
    expect(sessions.map((s) => s.info.id).sort()).toEqual([
      "child-1",
      "grand-1",
      "grand-2",
      "grand-3",
      "root-1",
    ]);
    const siblingSession = sessions.find((s) => s.info.id === "child-1");
    expect(siblingSession?.delegated).toBe(true);
    expect(siblingSession?.parentSessionId).toBe("root-1");
    expect(siblingSession?.parentLabel).toBe("root-1");
    for (const id of ["grand-1", "grand-2", "grand-3"]) {
      const grand = sessions.find((s) => s.info.id === id);
      expect(grand?.delegated).toBe(true);
      expect(grand?.parentSessionId).toBe("child-1");
      expect(grand?.parentLabel).toBe("child-1");
    }
  });

  it("does not attach children whose parent chain misses every selected root", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-usage-discovery-"));
    const parent = join(dir, "parent.jsonl");
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);
    const sibling = join(dir, "sibling.jsonl");
    writeJsonl(sibling, [sessionHeader({ id: "child-1", parentSession: "root-2" })]);

    const parented: ParentedSession[] = [
      { info: rootInfo(sibling, "child-1"), parentSession: "root-2" },
    ];
    const sessions = discoverSelectedSessions([rootInfo(parent, "root-1")], parented);
    expect(sessions.map((s) => s.info.id)).toEqual(["root-1"]);
  });

  it("tolerates malformed child transcripts without dropping the scan", () => {
    const { parent, child } = fixture();
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);
    const broken = child("broken.jsonl");
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, 'not json\n42\n{"broken":\n');

    const sessions = discoverSelectedSessions([rootInfo(parent, "root-1")]);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.delegated).toBe(true);
  });

  it("reports a childless root as a single direct session", () => {
    const { parent } = fixture();
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);

    const sessions = discoverSelectedSessions([rootInfo(parent, "root-1")]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.delegated).toBe(false);
    expect(sessions[0]?.parentSessionId).toBeNull();
  });

  it("does not duplicate repeated roots or children sharing a session id", () => {
    const { parent, child } = fixture();
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);
    writeJsonl(child("a.jsonl"), [sessionHeader({ id: "child-1" })]);
    writeJsonl(child("b.jsonl"), [sessionHeader({ id: "child-1" })]);

    const info = rootInfo(parent, "root-1");
    const sessions = discoverSelectedSessions([info, info]);
    expect(sessions.filter((s) => s.info.id === "root-1")).toHaveLength(1);
    expect(sessions.filter((s) => s.info.id === "child-1")).toHaveLength(1);
  });

  it("rejects convention descendants that duplicate root or direct-child ids", () => {
    const { dir, parent, child } = fixture();
    writeJsonl(parent, [sessionHeader({ id: "root-1" })]);
    const sibling = join(dir, "sibling.jsonl");
    writeJsonl(sibling, [sessionHeader({ id: "child-1", parentSession: "root-1" })]);
    writeJsonl(child("duplicate-root.jsonl"), [sessionHeader({ id: "root-1" })]);
    writeJsonl(child("duplicate-child.jsonl"), [sessionHeader({ id: "child-1" })]);

    const sessions = discoverSelectedSessions(
      [rootInfo(parent, "root-1")],
      [{ info: rootInfo(sibling, "child-1"), parentSession: "root-1" }],
    );
    expect(sessions.map((session) => session.info.id).sort()).toEqual(["child-1", "root-1"]);
  });
});
