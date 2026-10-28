import { recoveryDiagnostic } from "./diagnostics.js";

export const RECOVERY_EXIT_CODE = 75;
type ShutdownReason = "io-timeout" | "operator-signal" | "startup-failed";
type ServerHandle = { close(): Promise<unknown>; forceClose(): void };
type LifecycleOptions = {
  exit?: (code: number) => void;
  clock?: () => number;
  gracefulMs?: number;
  forcedMs?: number;
};
/** This process boundary alone owns exit; libraries request recovery by callback. */
export class RecoveryLifecycle {
  private server: ServerHandle | undefined;
  private reason: ShutdownReason | undefined;
  private startedAt = 0;
  private closeStarted = false;
  private gracefulElapsed = false;
  private exited = false;
  private gracefulTimer: ReturnType<typeof setTimeout> | undefined;
  private forcedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly exit: (code: number) => void;
  private readonly clock: () => number;
  constructor(private readonly options: LifecycleOptions = {}) {
    this.exit = options.exit ?? (code => process.exit(code));
    this.clock = options.clock ?? (() => performance.now());
  }
  get stopping() { return this.reason !== undefined; }
  attach(server: ServerHandle) {
    this.server = server;
    if (this.stopping) this.close();
  }
  request(reason: ShutdownReason) {
    if (this.stopping) return;
    this.reason = reason;
    this.startedAt = this.clock();
    recoveryDiagnostic("server-shutdown", "started", 0, reason);
    // Keep these timers referenced, including fatal startup before a server exists.
    this.gracefulTimer = setTimeout(() => {
      this.gracefulElapsed = true;
      this.forceClose();
    }, this.options.gracefulMs ?? 10_000);
    this.forcedTimer = setTimeout(() => this.finish(true), this.options.forcedMs ?? 15_000);
    this.close();
  }
  private close() {
    if (!this.server || this.closeStarted || this.exited) return;
    this.closeStarted = true;
    if (this.gracefulElapsed) this.forceClose();
    // Invoke immediately so attaching a late startup server cannot escape shutdown.
    try { void this.server.close().then(() => this.finish(false), () => this.finish(false, true)); }
    catch { this.finish(false, true); }
  }
  private forceClose() {
    try { this.server?.forceClose(); }
    catch {
      // Socket disposal failure cannot disarm the already scheduled hard exit.
      if (this.reason) recoveryDiagnostic("server-shutdown", "failed", this.clock() - this.startedAt, this.reason);
    }
  }
  private finish(forced: boolean, failed = false) {
    if (this.exited || !this.reason) return;
    this.exited = true;
    clearTimeout(this.gracefulTimer);
    clearTimeout(this.forcedTimer);
    recoveryDiagnostic("server-shutdown", forced ? "forced" : failed ? "failed" : "completed", this.clock() - this.startedAt, this.reason);
    this.exit(this.reason === "io-timeout" ? RECOVERY_EXIT_CODE : failed || this.reason === "startup-failed" ? 1 : 0);
  }
}
