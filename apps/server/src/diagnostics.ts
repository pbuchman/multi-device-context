type Operation = "ai-title" | "cleanup";
type Reason = "pass-failed" | "subscription-failed" | "provider-retry" | "provider-rejected";
/** Only enumerated, low-cardinality fields. Never forward arbitrary error objects or user data. */
export function diagnostic(operation: Operation, reason: Reason, output: (value: string) => unknown = (value: string) => process.stderr.write(value)) {
  output(JSON.stringify({ operation, reason, at: new Date().toISOString() }) + "\n");
}

type RecoveryOperation = import("./io-watchdog.js").IoOperation | "server-shutdown";
type RecoveryOutcome = "failed" | "timeout" | "started" | "completed" | "forced";
type RecoveryReason = "io-timeout" | "dependency-error" | "operator-signal" | "startup-failed";
/** Recovery logs never accept SDK errors, resource names, paths or payloads. */
export function recoveryDiagnostic(operation: RecoveryOperation, outcome: RecoveryOutcome, durationMs: number, reason: RecoveryReason) {
  process.stderr.write(JSON.stringify({ operation, outcome, durationMs: Math.max(0, Math.round(durationMs)), reason }) + "\n");
}
