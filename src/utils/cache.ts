/** A simple TTL (time-to-live) cache */
export class TTLCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();
  private readonly ttlMs: number;

  /**
   * Create a new TTL cache.
   * @param ttlMs - Time-to-live in milliseconds (default: 5 minutes)
   */
  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Get a value from the cache.
   * @param key - Cache key
   * @returns The cached value, or undefined if expired/missing
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a value in the cache.
   * @param key - Cache key
   * @param value - Value to cache
   */
  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Clear all entries from the cache */
  clear(): void {
    this.cache.clear();
  }
}
