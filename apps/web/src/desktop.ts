import { IdSchema, type DesktopBridge, type PendingClipboardShare } from "@mdc/contracts";

export type NativeClipboardBatch = PendingClipboardShare | (Pick<PendingClipboardShare, "id" | "capturedAt"> & {
  readSnapshot(): Promise<PendingClipboardShare["snapshot"]>;
});
export type NativeQueueBridge = Pick<DesktopBridge, "acknowledgeClipboardShare"> & {
  getPendingClipboardShares(): Promise<NativeClipboardBatch[]>;
};

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
  bridge: NativeQueueBridge,
  store: NativeQueueStore,
  current: () => boolean = () => true,
): Promise<void> {
  if (!current()) return;
  const requests = await bridge.getPendingClipboardShares();
  let failure: { cause: unknown } | undefined;
  for (const request of requests) {
    if (!current()) return;
    try {
      const id = IdSchema.parse(request.id);
      const stored = await store.hasNativeRequest(id);
      if (!current()) return;
      if (!stored) {
        const snapshot = "readSnapshot" in request ? await request.readSnapshot() : request.snapshot;
        if (!current()) return;
        await store.storeNativeSnapshot({ id, capturedAt: request.capturedAt, snapshot });
      }
      if (!current()) return;
      await bridge.acknowledgeClipboardShare(id);
      if (!current()) return;
      await store.markNativeAcknowledged(id);
    } catch (cause) {
      failure ??= { cause };
    }
  }
  if (current() && failure) throw failure.cause;
}
