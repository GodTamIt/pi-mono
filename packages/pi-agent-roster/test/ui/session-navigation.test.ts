import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types.ts";
import type { AgentSessionEvent, SessionMessage } from "../../src/types.ts";
import {
  fileSnapshotSource,
  listNavigableAgents,
  liveSource,
  type NavigableSubagent,
  type TranscriptSource,
} from "../../src/ui/session-navigation.ts";
import { makeNavigable } from "../helpers/make-navigable.ts";

const registry = new AgentTypeRegistry(() => new Map());

describe("listNavigableAgents", () => {
  it("returns an empty list for no agents", () => {
    expect(listNavigableAgents([], registry)).toEqual([]);
  });

  it("makes a session-ready record a live entry", () => {
    const ready = makeNavigable({ id: "ready", isSessionReady: () => true });
    const entries = listNavigableAgents([ready], registry);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.kind).toBe("live");
    expect(entry.kind === "live" && entry.record).toBe(ready);
  });

  it("makes a released record (no live session, has outputFile) a snapshot entry", () => {
    const released = makeNavigable({
      id: "released",
      isSessionReady: () => false,
      outputFile: "/tasks/released-1.jsonl",
      description: "Investigate the bug",
      toolUses: 3,
    });
    const entry = listNavigableAgents([released], registry)[0]!;
    expect(entry.kind).toBe("snapshot");
    expect(entry.kind === "snapshot" && entry.outputFile).toBe("/tasks/released-1.jsonl");
    expect(entry).toMatchObject({
      key: "snapshot:released",
      id: "released",
      name: "Agent",
      description: "Investigate the bug",
      status: "completed",
      duration: "3.0s",
      toolUses: 3,
      sourceLabel: "released snapshot",
    });
  });

  it("drops a record with neither a live session nor an outputFile", () => {
    const gone = makeNavigable({ id: "gone", isSessionReady: () => false, outputFile: undefined });
    expect(listNavigableAgents([gone], registry)).toEqual([]);
  });

  it("builds picker metadata separately from its stable identity", () => {
    const record = makeNavigable({
      id: "child-7",
      type: "general-purpose",
      description: "Investigate the bug",
      toolUses: 3,
      status: "completed",
      startedAt: 1000,
      completedAt: 4000,
    });
    const entry = listNavigableAgents([record], registry)[0]!;
    expect(entry).toMatchObject({
      key: "live:child-7",
      id: "child-7",
      name: "Agent",
      description: "Investigate the bug",
      status: "completed",
      duration: "3.0s",
      toolUses: 3,
      sourceLabel: "live session",
    });
  });

  it("keeps duplicate rendered metadata unambiguous through stable keys", () => {
    const entries = listNavigableAgents(
      [makeNavigable({ id: "one" }), makeNavigable({ id: "two" })],
      registry,
    );
    expect(entries.map((entry) => entry.name)).toEqual(["Agent", "Agent"]);
    expect(entries.map((entry) => entry.key)).toEqual(["live:one", "live:two"]);
  });

  it("orders live entries before snapshot ones", () => {
    const live = makeNavigable({ id: "live-1", isSessionReady: () => true });
    const released = makeNavigable({
      id: "released-1",
      isSessionReady: () => false,
      outputFile: "/tasks/x.jsonl",
    });
    const kinds = listNavigableAgents([live, released], registry).map((e) => e.kind);
    expect(kinds).toEqual(["live", "snapshot"]);
  });
});

describe("liveSource", () => {
  it("getMessages returns the record's agentMessages", () => {
    const messages = [{ role: "user", content: "hi" }] as unknown as SessionMessage[];
    const record = makeNavigable({ agentMessages: messages });
    expect(liveSource(record).getMessages()).toBe(messages);
  });

  it("subscribe delegates to subscribeToUpdates and forwards change notifications", () => {
    let captured: ((event: unknown) => void) | undefined;
    const unsub = vi.fn();
    const record = makeNavigable({
      subscribeToUpdates: vi.fn((fn: (event: unknown) => void) => {
        captured = fn;
        return unsub;
      }) as NavigableSubagent["subscribeToUpdates"],
    });
    const onChange = vi.fn();
    const returned = liveSource(record).subscribe(onChange);
    expect(record.subscribeToUpdates).toHaveBeenCalledOnce();
    const event = { type: "turn_end" } as AgentSessionEvent;
    captured?.(event);
    // The event is forwarded, not merely counted: the consumer routes on its
    // type to decide whether a streaming delta or a settled message arrived.
    expect(onChange).toHaveBeenCalledWith(event);
    expect(returned).toBe(unsub);
  });

  it("streaming returns activity state only while running", () => {
    const activeTools = new Map([["k", "read"]]);
    const running = makeNavigable({ status: "running", activeTools, responseText: "working" });
    expect(liveSource(running).streaming()).toEqual({ activeTools, responseText: "working" });

    const completed = makeNavigable({ status: "completed" });
    expect(liveSource(completed).streaming()).toBeUndefined();
  });

  it("getToolDefinition delegates to the record's getToolDefinition", () => {
    const def = { name: "read" } as unknown as ReturnType<TranscriptSource["getToolDefinition"]>;
    const record = makeNavigable({ getToolDefinition: vi.fn(() => def) });
    expect(liveSource(record).getToolDefinition("read")).toBe(def);
    expect(record.getToolDefinition).toHaveBeenCalledWith("read");
  });
});

describe("fileSnapshotSource", () => {
  const SESSION_JSONL = [
    { type: "session", version: 3, id: "s1", timestamp: "2026-06-23T00:00:00Z", cwd: "/proj" },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-06-23T00:00:01Z",
      message: { role: "user", content: "do the thing" },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-06-23T00:00:02Z",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  it("reads the file, drops the session header, and returns the parsed messages", () => {
    const readFile = vi.fn(() => SESSION_JSONL);
    const source = fileSnapshotSource("/tasks/agent.jsonl", readFile);
    expect(readFile).toHaveBeenCalledWith("/tasks/agent.jsonl");
    expect(source.getMessages()).toEqual([
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  it("is a static snapshot: no subscription, no streaming, no tool definitions", () => {
    const source = fileSnapshotSource("/tasks/agent.jsonl", () => SESSION_JSONL);
    expect(source.subscribe(() => {})).toBeUndefined();
    expect(source.streaming()).toBeUndefined();
    expect(source.getToolDefinition("read")).toBeUndefined();
  });

  it("returns an empty transcript for a header-only file", () => {
    const headerOnly = JSON.stringify({
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "2026-06-23T00:00:00Z",
      cwd: "/proj",
    });
    const source = fileSnapshotSource("/tasks/empty.jsonl", () => headerOnly);
    expect(source.getMessages()).toEqual([]);
  });

  it("skips malformed lines and schema-invalid values without hiding valid messages", () => {
    const validFirst = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-06-23T00:00:01Z",
      message: { role: "user", content: "still visible" },
    };
    const validSecond = {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-06-23T00:00:02Z",
      message: { role: "assistant", content: [{ type: "text", text: "also visible" }] },
    };
    const jsonl = [
      "{not json",
      JSON.stringify(validFirst),
      "null",
      JSON.stringify({ type: "message", id: "bad", parentId: "m1", message: null }),
      JSON.stringify({ type: "mystery", id: "unknown", parentId: "m1" }),
      JSON.stringify(validSecond),
    ].join("\n");

    expect(
      fileSnapshotSource("/tasks/damaged.jsonl", () => jsonl).getMessages(),
    ).toMatchInlineSnapshot(`
        [
          {
            "content": "still visible",
            "role": "user",
          },
          {
            "content": [
              {
                "text": "also visible",
                "type": "text",
              },
            ],
            "role": "assistant",
          },
        ]
      `);
  });
});
