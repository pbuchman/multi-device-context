/** Fixed windows with bounded cardinality. Saturation fails closed, never evicts live limits. */
export class WindowLimit {
  private readonly entries = new Map<string, { count: number; until: number }>();
  constructor(private maximum: number, private interval = 60_000, private capacity = 10_000, private clock = Date.now) {}
  take(key: string): number {
    const now = this.clock();
    for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.capacity) return Math.ceil(this.interval / 1000);
      entry = { count: 0, until: now + this.interval }; this.entries.set(key, entry);
    }
    if (entry.count >= this.maximum) return Math.max(1, Math.ceil((entry.until - now) / 1000));
    entry.count++; return 0;
  }
}

/** Requests never trigger GCP calls; one background check can be in flight. */
export class Readiness {
  private checkedAt = 0;
  private healthy = false;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private check: () => Promise<void>, private clock = Date.now) {}
  async start() {
    this.timer = setInterval(() => { void this.refresh(); }, 30_000); this.timer.unref();
    // Do not prevent the HTTP server from starting when a dependency is hung.
    await Promise.race([this.refresh(), new Promise<void>(resolve => { const t = setTimeout(resolve, 5000); t.unref(); })]);
  }
  async refresh() {
    if (this.running) return;
    this.running = true;
    try { await this.check(); this.healthy = true; }
    catch { this.healthy = false; }
    finally { this.checkedAt = this.clock(); this.running = false; }
  }
  ok() { return this.checkedAt > 0 && this.healthy && this.clock() - this.checkedAt <= 45_000; }
  close() { clearInterval(this.timer); }
}
