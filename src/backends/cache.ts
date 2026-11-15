/**
 * A small TTL + LRU cache that also shares in-flight loads, so two clients paging through the same
 * query at the same time cause one upstream fetch. Failed loads are not cached.
 */
export class ResultCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  private readonly loading = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to mark it most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Runs `load` once per key at a time; callers arriving while it runs wait for the same promise.
   * The load runs under the first caller's signal, so when that caller gives up (timeout, disconnect),
   * a waiting caller whose own signal is still fine starts the load again instead of failing with it.
   */
  async shared<T>(key: string, load: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const running = this.loading.get(key) as Promise<T> | undefined;
    if (running === undefined) {
      const promise = load().finally(() => this.loading.delete(key));
      this.loading.set(key, promise);
      return promise;
    }
    try {
      return await running;
    } catch (error) {
      if (!signal.aborted && isAbort(error)) return this.shared(key, load, signal);
      throw error;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
