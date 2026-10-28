import { recoveryDiagnostic } from "./diagnostics.js";

export type IoOperation = "readiness-firestore" | "readiness-storage" | "deletion-firestore" | "deletion-storage" | "cleanup-firestore"
  | "device-auth-token" | "device-auth-firestore" | "agent-auth-firestore-read" | "agent-auth-firestore-write";
export type DependencyGuard = Pick<IoWatchdog, "run">;
export class DependencyUnavailable extends Error {
  readonly statusCode = 503;
  constructor() { super("Dependency unavailable"); }
}

/** A deadline stops application progress; SDK promises cannot safely be cancelled.
 * Keep the fatal latch until process exit, including when those promises settle late. */
export class IoWatchdog {
  private failed = false;
  private closed = false;
  private readonly pending = new Set<() => void>();
  constructor(private readonly onFatal: (operation: IoOperation) => void = () => {}, private readonly clock = () => performance.now()) {}
  get fatal() { return this.failed; }
  assertActive() { if (this.failed || this.closed) throw new DependencyUnavailable(); }
  async run<T>(operation: IoOperation, call: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    this.assertActive();
    const started = this.clock();
    let cancel!: () => void;
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      cancel = () => { clearTimeout(timer); reject(new DependencyUnavailable()); };
      this.pending.add(cancel);
      timer = setTimeout(() => {
        if (!this.failed && !this.closed) {
          this.failed = true;
          recoveryDiagnostic(operation, "timeout", this.clock() - started, "io-timeout");
          // Callback only requests shutdown; the process boundary owns exit.
          this.onFatal(operation);
        }
        reject(new DependencyUnavailable());
      }, timeoutMs);
      // A hung startup call must keep Node alive until its recovery boundary.
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => { this.assertActive(); return call(); }), deadline]);
      this.assertActive();
      return result;
    } catch (error) {
      if (!this.failed && !this.closed) recoveryDiagnostic(operation, "failed", this.clock() - started, "dependency-error");
      throw error;
    } finally {
      clearTimeout(timer);
      this.pending.delete(cancel);
    }
  }
  close() {
    this.closed = true;
    for (const cancel of this.pending) cancel();
    this.pending.clear();
  }
}
