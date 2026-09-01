/**
 * A fixed-capacity, insertion-ordered buffer keyed by id — the client-side
 * counterpart of `src/ringBuffer.ts` on the backend (duplicated by hand for
 * the same reason as `types.ts`: this package builds standalone).
 *
 * This is what keeps the dashboard smooth under a firehose of traffic:
 * O(1) upsert-by-id (a `request` event is followed later by a `response`
 * event for the same id — that must update the existing row, not append a
 * duplicate), and a hard cap on how many rows the store ever holds, so a
 * session that's been running for hours doesn't grow the tab's memory
 * without bound.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private readonly keyOf: (item: T) => string;
  private readonly slotOfKey = new Map<string, number>();
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(capacity: number, keyOf: (item: T) => string) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer (got: ${capacity})`);
    }
    this.slots = new Array(capacity);
    this.keyOf = keyOf;
  }

  get capacity(): number {
    return this.slots.length;
  }

  get size(): number {
    return this.count;
  }

  upsert(item: T): void {
    const key = this.keyOf(item);
    const existingSlot = this.slotOfKey.get(key);
    if (existingSlot !== undefined) {
      this.slots[existingSlot] = item;
      return;
    }

    if (this.count === this.capacity) {
      const evicted = this.slots[this.head];
      if (evicted !== undefined) this.slotOfKey.delete(this.keyOf(evicted));
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.count -= 1;
    }

    const slot = this.tail;
    this.slots[slot] = item;
    this.slotOfKey.set(key, slot);
    this.tail = (this.tail + 1) % this.capacity;
    this.count += 1;
  }

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
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
