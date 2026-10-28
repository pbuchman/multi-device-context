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
  private checkedAt?: number;
  private healthy = false;
  private running = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private finishStartup: (() => void) | undefined;
  constructor(private check: () => Promise<void>, private clock = () => performance.now(), private fatal = () => false, private unavailable = () => false) {}
  async start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, 30_000); this.timer.unref();
    // HTTP startup stays bounded even when a guarded dependency is still pending.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.refresh(), new Promise<void>(resolve => {
        this.finishStartup = resolve;
        timer = setTimeout(resolve, 5000); timer.unref();
      })]);
    } finally { clearTimeout(timer); this.finishStartup = undefined; }
  }
  async refresh() {
    if (this.running || this.closed || this.fatal()) return;
    this.running = true;
    try { await this.check(); this.healthy = !this.closed && !this.fatal() && !this.unavailable(); }
    catch { this.healthy = false; }
    finally { this.checkedAt = this.clock(); if (!this.fatal()) this.running = false; }
  }
  ok() { return !this.closed && !this.fatal() && !this.unavailable() && this.checkedAt !== undefined && this.healthy && this.clock() - this.checkedAt <= 45_000; }
  close() { this.closed = true; clearInterval(this.timer); this.finishStartup?.(); }
}
