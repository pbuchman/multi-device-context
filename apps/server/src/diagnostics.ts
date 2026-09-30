type Operation = "ai-title" | "cleanup";
type Reason = "pass-failed" | "subscription-failed" | "provider-retry" | "provider-rejected";
/** Only enumerated, low-cardinality fields. Never forward arbitrary error objects or user data. */
export function diagnostic(operation: Operation, reason: Reason, output: (value: string) => unknown = (value: string) => process.stderr.write(value)) {
  output(JSON.stringify({ operation, reason, at: new Date().toISOString() }) + "\n");
}
