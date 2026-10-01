export class ForegroundRefresh {
  #generation = 0;
  #scope: string | undefined;
  #pending: Promise<void> | undefined;

  constructor(private readonly deadlineMs = 15_000) {}

  invalidate(): void {
    this.#generation += 1;
    this.#scope = undefined;
    this.#pending = undefined;
  }

  run<T>(scope: string, read: () => Promise<T>, apply: (value: T) => unknown | Promise<unknown>): Promise<void> {
    if (this.#scope === scope && this.#pending) return this.#pending;
    const generation = ++this.#generation;
    this.#scope = scope;
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Refresh timed out")), this.deadlineMs);
    });
    const pending = Promise.race([read(), deadline]).then(async (value) => {
      if (generation === this.#generation && scope === this.#scope) await apply(value);
    }).finally(() => {
      clearTimeout(timeout);
      if (generation === this.#generation) {
        this.#scope = undefined;
        this.#pending = undefined;
      }
    });
    this.#pending = pending;
    return pending;
  }
}

/** One foreground catch-up owns completion, including its deadline and cleanup. */
export class ForegroundCatchup {
  #generation = 0;
  #pending: { scope: string; promise: Promise<void> } | undefined;

  constructor(private readonly deadlineMs = 15_000) {}

  invalidate(): void {
    this.#generation += 1;
    this.#pending = undefined;
  }

  run(scope: string, work: (current: () => boolean) => Promise<void>, settled: (error?: unknown) => void): Promise<void> {
    if (this.#pending?.scope === scope) return this.#pending.promise;
    const generation = ++this.#generation;
    const owns = () => generation === this.#generation;
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error("Refresh timed out"));
      }, this.deadlineMs);
    });
    const operation = Promise.resolve().then(() => work(() => owns() && !expired));
    const promise = Promise.race([operation, deadline]).then(
      () => { if (owns()) settled(); },
      error => { if (owns()) settled(error); },
    ).finally(() => {
      clearTimeout(timer);
      if (owns()) this.#pending = undefined;
    });
    this.#pending = { scope, promise };
    return promise;
  }
}

/** All deletion sources share this barrier; failures survive until retried. */
export class DeletionCleanup {
  #pending = new Map<string, Promise<void>>();
  #failed = new Map<string, unknown>();
  #complete = new Set<string>();

  reconcile(ids: Iterable<string>, remove: (id: string) => Promise<void>): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const id of ids) {
      if (this.#complete.has(id)) continue;
      let removal = this.#pending.get(id);
      if (!removal) {
        let operation: Promise<void>;
        try { operation = remove(id); }
        catch (cause) { operation = Promise.reject(cause); }
        removal = operation.then(() => {
          this.#failed.delete(id);
          this.#complete.add(id);
        }, cause => {
          this.#failed.set(id, cause);
          throw cause;
        }).finally(() => this.#pending.delete(id));
        this.#pending.set(id, removal);
      }
      removals.push(removal);
    }
    return Promise.all(removals).then(() => undefined);
  }

  async finish(current: () => boolean, complete: () => void): Promise<void> {
    while (current()) {
      const pending = [...this.#pending.values()];
      if (pending.length) {
        await Promise.allSettled(pending);
        continue;
      }
      if (this.#failed.size) throw new Error("Could not remove local pending shares");
      // No await between the last barrier check and publishing recovery.
      complete();
      return;
    }
  }
}
