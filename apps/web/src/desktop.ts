import { IdSchema, type DesktopBridge, type PendingClipboardShare } from "@mdc/contracts";

export type NativeQueueStore = {
  hasNativeRequest(requestId: ReturnType<typeof IdSchema.parse>): Promise<boolean>;
  storeNativeSnapshot(request: PendingClipboardShare): Promise<void>;
  markNativeAcknowledged(requestId: ReturnType<typeof IdSchema.parse>): Promise<void>;
};

declare global {
  interface Window { contextDesktop?: DesktopBridge }
}

export function inspectDesktopBridge():
  | { kind: "browser" }
  | { kind: "ready"; bridge: DesktopBridge }
  | { kind: "incompatible"; actual: unknown } {
  const candidate = window.contextDesktop;
  if (!candidate) return { kind: "browser" };
  if (candidate.version !== 1) return { kind: "incompatible", actual: candidate.version };
  return { kind: "ready", bridge: candidate };
}

export async function drainNativeClipboardQueue(
  bridge: DesktopBridge,
  store: NativeQueueStore,
): Promise<void> {
  const requests = await bridge.getPendingClipboardShares();
  for (const request of requests) {
    const id = IdSchema.parse(request.id);
    if (!(await store.hasNativeRequest(id))) await store.storeNativeSnapshot(request);
    await bridge.acknowledgeClipboardShare(id);
    await store.markNativeAcknowledged(id);
  }
}
