import type { Id } from "@mdc/contracts";
import { DurableOutbox, OutboxRunner, PublishFailure, type QueuedShare } from "./outbox.js";
export type DeletionMarkers = { contexts: Id[]; items: { contextId: Id; itemId: Id }[] };
export type OperationCloud = {
  deletionMarkers(): Promise<DeletionMarkers>;
  publish(record: QueuedShare): Promise<void>;
  deleteContext(id: Id): Promise<void>;
  deleteItem(contextId: Id, itemId: Id): Promise<void>;
};
/** All local cancellations commit before HTTP; ID-only intents survive ambiguous responses. */
export class ContextOperations {
  readonly runner: OutboxRunner;
  constructor(readonly outbox: DurableOutbox, readonly cloud: OperationCloud) {
    this.runner = new OutboxRunner(outbox, { prepare: () => this.prepare(), publish: async record => {
      if (!await outbox.isCancelled(record)) await cloud.publish(record);
    } });
  }
  async prepare() {
    try {
      const markers = await this.cloud.deletionMarkers();
      for (const id of markers.contexts) await this.outbox.removeContext(id);
      for (const item of markers.items) await this.outbox.removeItem(item.contextId, item.itemId);
    } catch (error) {
      // Preparation is part of delivering a deletion. Persist its failure too,
      // so a fresh intent is not left looking indefinitely in flight offline.
      for (const deletion of await this.outbox.deletions()) {
        if (deletion.paused || deletion.nextAttemptAt > Date.now()) continue;
        await this.outbox.failDeletion(deletion, error instanceof PublishFailure && !error.retryable, error instanceof PublishFailure ? error.retryAfterMs : 0);
      }
      throw error;
    }
    for (const deletion of await this.outbox.deletions()) {
      if (deletion.paused || deletion.nextAttemptAt > Date.now()) continue;
      try {
        if (deletion.itemId) await this.cloud.deleteItem(deletion.contextId, deletion.itemId);
        else await this.cloud.deleteContext(deletion.contextId);
        await this.outbox.remove(deletion.key);
      } catch (error) {
        await this.outbox.failDeletion(deletion, error instanceof PublishFailure && !error.retryable, error instanceof PublishFailure ? error.retryAfterMs : 0);
      }
    }
  }
  async remove(contextId: Id, itemId?: Id): Promise<boolean> {
    await this.outbox.requestDeletion(contextId, itemId);
    await this.runner.drain().catch(() => {});
    return !(await this.outbox.deletions()).some(d => d.contextId === contextId && d.itemId === itemId);
  }
}
