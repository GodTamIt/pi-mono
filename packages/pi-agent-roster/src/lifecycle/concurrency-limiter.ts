/** FIFO admission state for background child IDs. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly pending: string[] = [];
  private readonly admitted = new Set<string>();
  private readonly settlements = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void }
  >();

  constructor(private readonly getLimit: () => number) {}

  /** Queue an ID. The returned promise settles when the admitted run settles or is dropped. */
  schedule(id: string): Promise<void> {
    if (this.settlements.has(id)) throw new Error(`Child ${id} is already scheduled`);
    const settlement = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid
    this.pending.push(id);
    this.settlements.set(id, settlement);
    return settlement.promise;
  }

  /** Admit queued IDs in FIFO order up to the current dynamic limit. */
  admit(): string[] {
    const admitted: string[] = [];
    while (this.active < this.getLimit()) {
      const id = this.pending.shift();
      if (id === undefined) break;
      this.active++;
      this.admitted.add(id);
      admitted.push(id);
    }
    return admitted;
  }

  /** Settle an admitted ID and release its slot. */
  settle(id: string, error?: unknown): void {
    if (!this.admitted.delete(id)) return;
    const settlement = this.settlements.get(id);
    this.settlements.delete(id);
    this.active--;
    if (error === undefined) settlement?.resolve();
    else settlement?.reject(error);
  }

  /** Remove an unadmitted ID and resolve its queue handle. */
  cancel(id: string): boolean {
    const index = this.pending.indexOf(id);
    if (index === -1) return false;
    this.pending.splice(index, 1);
    const settlement = this.settlements.get(id);
    this.settlements.delete(id);
    settlement?.resolve();
    return true;
  }

  /** Drop all IDs that have not been admitted, resolving their wait handles. */
  clear(): void {
    for (const id of this.pending.splice(0)) {
      const settlement = this.settlements.get(id);
      this.settlements.delete(id);
      settlement?.resolve();
    }
  }
}
