import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../../src/lifecycle/concurrency-limiter.ts";

describe("ConcurrencyLimiter", () => {
  it("admits child IDs FIFO up to the dynamic limit", () => {
    let limit = 1;
    const limiter = new ConcurrencyLimiter(() => limit);
    void limiter.schedule("first");
    void limiter.schedule("second");
    void limiter.schedule("third");

    expect(limiter.admit()).toEqual(["first"]);
    expect(limiter.admit()).toEqual([]);
    limit = 2;
    expect(limiter.admit()).toEqual(["second"]);
    limiter.settle("first");
    expect(limiter.admit()).toEqual(["third"]);
  });

  it("settles the queue handle when an admitted child settles", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const completed = limiter.schedule("child");
    expect(limiter.admit()).toEqual(["child"]);
    limiter.settle("child");
    await expect(completed).resolves.toBeUndefined();
  });

  it("rejects a queue handle when the manager reports an admission failure", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const completed = limiter.schedule("child");
    limiter.admit();
    limiter.settle("child", new Error("boom"));
    await expect(completed).rejects.toThrow("boom");
  });

  it("does not free a running slot when a pending ID is settled", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const active = limiter.schedule("active");
    const pending = limiter.schedule("pending");
    expect(limiter.admit()).toEqual(["active"]);

    limiter.settle("pending");
    expect(limiter.admit()).toEqual([]);

    limiter.settle("active");
    await expect(active).resolves.toBeUndefined();
    expect(limiter.admit()).toEqual(["pending"]);
    limiter.settle("pending");
    await expect(pending).resolves.toBeUndefined();
  });

  it("cancels a pending ID without consuming an admission slot", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const active = limiter.schedule("active");
    const canceled = limiter.schedule("canceled");
    const next = limiter.schedule("next");
    expect(limiter.admit()).toEqual(["active"]);

    expect(limiter.cancel("canceled")).toBe(true);
    await expect(canceled).resolves.toBeUndefined();
    expect(limiter.cancel("canceled")).toBe(false);

    limiter.settle("active");
    await expect(active).resolves.toBeUndefined();
    expect(limiter.admit()).toEqual(["next"]);
    limiter.settle("next");
    await expect(next).resolves.toBeUndefined();
  });

  it("clear drops only pending IDs and resolves their handles", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const active = limiter.schedule("active");
    const pending = limiter.schedule("pending");
    expect(limiter.admit()).toEqual(["active"]);

    limiter.clear();
    await expect(pending).resolves.toBeUndefined();
    limiter.settle("active");
    await expect(active).resolves.toBeUndefined();
    expect(limiter.admit()).toEqual([]);
  });

  it("rejects duplicate IDs rather than conflating settlement state", () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    void limiter.schedule("child");
    expect(() => limiter.schedule("child")).toThrow(/already scheduled/);
  });
});
