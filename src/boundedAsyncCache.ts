export type CacheDisposition = "hit" | "joined" | "miss";

export interface CacheResult<T> {
  value: T;
  disposition: CacheDisposition;
  stored: boolean;
}

interface CacheEntry<T> {
  value: T;
  bytes: number;
}

export class BoundedAsyncCache<T> {
  private readonly completed = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, Promise<{ value: T; stored: boolean }>>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error("BoundedAsyncCache limits must be positive integers.");
    }
  }

  private clone(value: T): T {
    return structuredClone(value);
  }

  private put(key: string, value: T): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > this.maxBytes) return false;
    const prior = this.completed.get(key);
    if (prior) this.totalBytes -= prior.bytes;
    this.completed.delete(key);
    this.completed.set(key, { value: this.clone(value), bytes });
    this.totalBytes += bytes;
    while (this.completed.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.completed.entries().next().value as [string, CacheEntry<T>] | undefined;
      if (!oldest) break;
      this.completed.delete(oldest[0]);
      this.totalBytes -= oldest[1].bytes;
    }
    return this.completed.has(key);
  }

  async getOrCompute(key: string, compute: () => Promise<T>): Promise<CacheResult<T>> {
    const cached = this.completed.get(key);
    if (cached) {
      this.completed.delete(key);
      this.completed.set(key, cached);
      return { value: this.clone(cached.value), disposition: "hit", stored: true };
    }

    const existing = this.pending.get(key);
    if (existing) {
      const joined = await existing;
      return { value: this.clone(joined.value), disposition: "joined", stored: joined.stored };
    }

    const work = (async () => {
      const value = await compute();
      return { value, stored: this.put(key, value) };
    })();
    this.pending.set(key, work);
    try {
      const created = await work;
      return { value: this.clone(created.value), disposition: "miss", stored: created.stored };
    } finally {
      if (this.pending.get(key) === work) this.pending.delete(key);
    }
  }
}
