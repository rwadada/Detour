/** `RingBuffer`'s optional byte-budget half — see the class doc comment. */
export interface RingBufferByteLimit<T> {
  /** Evicts the oldest entries (beyond the newest one) whenever the buffer's total exceeds this, independent of `capacity`. Omit for count-only capping (the original behavior). */
  maxTotalBytes: number;
  /** Estimated size of one entry, in bytes — e.g. its captured bodies' lengths. Called on every insert/update to keep the running total in sync; keep it cheap (a stored/precomputed length, not a fresh serialization). */
  sizeOf: (item: T) => number;
}

/**
 * A fixed-capacity, insertion-ordered buffer keyed by id.
 *
 * Backs both the dashboard server's backlog (recent exchanges replayed to a
 * newly-connected client) and the frontend's log store — in both places we
 * need the same two things a plain array doesn't give us cheaply: O(1)
 * "update this entry in place" (a `request` event is followed later by a
 * `response` event for the same id) and a hard cap on memory use once
 * traffic has been flowing for a while.
 *
 * Once at capacity, pushing a new id evicts the oldest entry. Updating an
 * existing id's value never changes its position.
 *
 * `capacity` alone caps *how many* entries this holds, not how large any of
 * them are — 500 exchanges each carrying a couple of base64'd 256 KB bodies
 * is a very different memory footprint from 500 carrying none at all (issue
 * #165). `byteLimit` (optional — omitted keeps the original count-only
 * behavior) adds a second, independent cap on the *total* size of every
 * entry combined, tracked incrementally rather than resummed on every call:
 * an insert/eviction adjusts a running total by exactly the one entry that
 * changed, and an update (same key, new value — the `request`→`response`
 * case above, where the value usually grows) adjusts it by the size delta.
 * Either cap can trigger eviction independently; both are enforced after
 * every `upsert`. An entry that alone exceeds `maxTotalBytes` is still kept
 * (nothing here second-guesses a per-entry cap some other layer already
 * enforces) — eviction never empties the buffer down to zero just to chase
 * the byte budget.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private readonly keyOf: (item: T) => string;
  private readonly byteLimit?: RingBufferByteLimit<T>;
  private readonly slotOfKey = new Map<string, number>();
  /**
   * `byteLimit.sizeOf`'s result the last time it was actually called for
   * whatever's currently in each slot — parallel to `slots`, indexed the
   * same way. Only meaningful (and only ever written) while `byteLimit` is
   * set.
   *
   * Caching this, rather than calling `sizeOf` again on the slot's stored
   * value whenever a size is needed (on update or eviction), matters
   * because the backend's own caller (`dashboardServer.ts`'s `backlog`)
   * hands this the *same* `CapturedExchange` object reference for a
   * `request` event and the `response` event that later updates it in
   * place (`onRequestData` appends straight onto it) — by the time an
   * update or eviction runs, re-measuring `slots[slot]` would report the
   * object's *current* size, not what it actually contributed to
   * `totalBytes` last time. Re-measuring "the old size" off a since-mutated
   * object is not a delta at all — for an insert immediately followed by an
   * in-place-mutating update, it silently makes `totalBytes` undercount by
   * exactly the mutation, and can drive it negative once that entry is
   * later evicted (the eviction path would subtract the *further-mutated*
   * size, not the smaller one `totalBytes` actually gained). Caught by agy
   * code review before this was ever wired into the real backlog.
   */
  private readonly sizeAtSlot: number[];
  /** Index of the oldest occupied slot (meaningful only while `count > 0`). */
  private head = 0;
  /** Index the next brand-new entry will be written to. */
  private tail = 0;
  private count = 0;
  /** Sum of `sizeAtSlot` over every occupied slot — `0` (and never read) when `byteLimit` isn't set. */
  private totalBytes = 0;

  constructor(capacity: number, keyOf: (item: T) => string, byteLimit?: RingBufferByteLimit<T>) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer (got: ${capacity})`);
    }
    this.slots = new Array(capacity);
    this.keyOf = keyOf;
    this.byteLimit = byteLimit;
    this.sizeAtSlot = byteLimit ? new Array(capacity).fill(0) : [];
  }

  get capacity(): number {
    return this.slots.length;
  }

  get size(): number {
    return this.count;
  }

  /** Current running total from `byteLimit.sizeOf` — `0` when no `byteLimit` was configured. Exposed mainly for tests/observability, not needed for normal use. */
  get totalByteSize(): number {
    return this.totalBytes;
  }

  /** Evicts the oldest occupied slot (the caller has already checked `count > 0`) — shared by the count-cap and byte-cap eviction paths below. */
  private evictOldest(): void {
    const evicted = this.slots[this.head];
    if (evicted !== undefined) {
      this.slotOfKey.delete(this.keyOf(evicted));
      if (this.byteLimit) this.totalBytes -= this.sizeAtSlot[this.head]!;
    }
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
  }

  /** Evicts oldest-first until back under `byteLimit.maxTotalBytes`, stopping at 1 entry left regardless — see the class doc comment on why a lone oversized entry is kept rather than dropped. */
  private evictToByteBudget(): void {
    if (!this.byteLimit) return;
    while (this.count > 1 && this.totalBytes > this.byteLimit.maxTotalBytes) {
      this.evictOldest();
    }
  }

  /** Inserts a new entry, or overwrites an existing one with the same key in place. */
  upsert(item: T): void {
    const key = this.keyOf(item);
    const existingSlot = this.slotOfKey.get(key);
    if (existingSlot !== undefined) {
      if (this.byteLimit) {
        // Never re-measures `slots[existingSlot]` (the *old* value) — see
        // `sizeAtSlot`'s own doc comment for why that would be wrong for a
        // caller that mutates its objects in place.
        const newSize = this.byteLimit.sizeOf(item);
        this.totalBytes += newSize - this.sizeAtSlot[existingSlot]!;
        this.sizeAtSlot[existingSlot] = newSize;
      }
      this.slots[existingSlot] = item;
      this.evictToByteBudget();
      return;
    }

    if (this.count === this.capacity) this.evictOldest();

    const slot = this.tail;
    this.slots[slot] = item;
    this.slotOfKey.set(key, slot);
    this.tail = (this.tail + 1) % this.capacity;
    this.count += 1;
    if (this.byteLimit) {
      const newSize = this.byteLimit.sizeOf(item);
      this.sizeAtSlot[slot] = newSize;
      this.totalBytes += newSize;
    }
    this.evictToByteBudget();
  }

  /** Returns all entries, oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.slots[(this.head + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.slotOfKey.clear();
    if (this.byteLimit) this.sizeAtSlot.fill(0);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.totalBytes = 0;
  }
}
