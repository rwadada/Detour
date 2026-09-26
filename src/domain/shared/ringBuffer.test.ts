import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

interface Item {
  id: string;
  value: number;
}

function buffer(capacity: number) {
  return new RingBuffer<Item>(capacity, (item) => item.id);
}

describe('RingBuffer', () => {
  it('returns entries in insertion order, oldest first', () => {
    const b = buffer(10);
    b.upsert({ id: 'a', value: 1 });
    b.upsert({ id: 'b', value: 2 });
    b.upsert({ id: 'c', value: 3 });
    expect(b.toArray().map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('updates an existing key in place without changing its position', () => {
    const b = buffer(10);
    b.upsert({ id: 'a', value: 1 });
    b.upsert({ id: 'b', value: 2 });
    b.upsert({ id: 'a', value: 99 });
    expect(b.toArray()).toEqual([
      { id: 'a', value: 99 },
      { id: 'b', value: 2 },
    ]);
    expect(b.size).toBe(2);
  });

  it('evicts the oldest entry once at capacity', () => {
    const b = buffer(2);
    b.upsert({ id: 'a', value: 1 });
    b.upsert({ id: 'b', value: 2 });
    b.upsert({ id: 'c', value: 3 });
    expect(b.toArray().map((i) => i.id)).toEqual(['b', 'c']);
    expect(b.size).toBe(2);
  });

  it('keeps evicting as more entries arrive past capacity', () => {
    const b = buffer(3);
    for (let i = 0; i < 10; i++) b.upsert({ id: `id-${i}`, value: i });
    expect(b.toArray().map((i) => i.id)).toEqual(['id-7', 'id-8', 'id-9']);
  });

  it('clear() empties the buffer and resets capacity tracking', () => {
    const b = buffer(2);
    b.upsert({ id: 'a', value: 1 });
    b.upsert({ id: 'b', value: 2 });
    b.clear();
    expect(b.toArray()).toEqual([]);
    expect(b.size).toBe(0);
    // Confirms internal slot bookkeeping was actually reset, not just the count.
    b.upsert({ id: 'c', value: 3 });
    b.upsert({ id: 'd', value: 4 });
    b.upsert({ id: 'e', value: 5 });
    expect(b.toArray().map((i) => i.id)).toEqual(['d', 'e']);
  });

  it('rejects a non-positive-integer capacity', () => {
    expect(() => buffer(0)).toThrow(/positive integer/);
    expect(() => buffer(-1)).toThrow(/positive integer/);
    expect(() => new RingBuffer<Item>(1.5, (i) => i.id)).toThrow(/positive integer/);
  });

  describe('byteLimit (issue #165)', () => {
    function byteBuffer(capacity: number, maxTotalBytes: number) {
      return new RingBuffer<Item>(capacity, (item) => item.id, { maxTotalBytes, sizeOf: (item) => item.value });
    }

    it('has no byte cap at all when byteLimit is omitted — totalByteSize stays 0', () => {
      const b = buffer(10);
      b.upsert({ id: 'a', value: 1_000_000 });
      expect(b.totalByteSize).toBe(0);
      expect(b.size).toBe(1);
    });

    it('tracks totalByteSize as entries are inserted', () => {
      const b = byteBuffer(10, 1000);
      b.upsert({ id: 'a', value: 100 });
      b.upsert({ id: 'b', value: 50 });
      expect(b.totalByteSize).toBe(150);
    });

    it('evicts oldest-first once totalByteSize would exceed maxTotalBytes, independent of capacity', () => {
      const b = byteBuffer(10, 250);
      b.upsert({ id: 'a', value: 100 });
      b.upsert({ id: 'b', value: 100 });
      b.upsert({ id: 'c', value: 100 }); // 300 > 250 — evicts 'a'
      expect(b.toArray().map((i) => i.id)).toEqual(['b', 'c']);
      expect(b.totalByteSize).toBe(200);
      expect(b.size).toBe(2); // well under the count capacity of 10
    });

    it('evicts however many entries it takes to get back under budget, not just one', () => {
      const b = byteBuffer(10, 50);
      b.upsert({ id: 'a', value: 10 });
      b.upsert({ id: 'b', value: 10 });
      b.upsert({ id: 'c', value: 10 });
      // Total would be 70 (over the 50 budget) — evicting only 'a' still
      // leaves 60, so 'b' goes too, landing at 50 (<= budget, stops there).
      b.upsert({ id: 'd', value: 40 });
      expect(b.toArray().map((i) => i.id)).toEqual(['c', 'd']);
      expect(b.totalByteSize).toBe(50);
    });

    it('keeps a lone entry that alone exceeds maxTotalBytes, rather than evicting down to zero', () => {
      const b = byteBuffer(10, 50);
      b.upsert({ id: 'a', value: 500 });
      expect(b.toArray().map((i) => i.id)).toEqual(['a']);
      expect(b.totalByteSize).toBe(500);
    });

    it('adjusts totalByteSize by the size delta when an update grows an existing entry (the request→response case)', () => {
      const b = byteBuffer(10, 1000);
      b.upsert({ id: 'a', value: 50 }); // e.g. a 'request' event, headers only
      expect(b.totalByteSize).toBe(50);
      b.upsert({ id: 'a', value: 300 }); // the matching 'response' event, now carrying a body too
      expect(b.totalByteSize).toBe(300);
      expect(b.size).toBe(1);
    });

    // agy code review: the real backend caller (dashboardServer.ts) hands
    // upsert() the *same* CapturedExchange object reference for a `request`
    // event and the `response` event that later mutates it in place (e.g.
    // `exchange.responseBodySize += chunk.length`), unlike this test file's
    // other cases, which always upsert a brand-new object. Re-measuring the
    // slot's *stored* value to get "the old size" would read the object's
    // already-mutated current state instead of what it actually contributed
    // to totalByteSize last time — silently undercounting the update, and
    // then over-subtracting (potentially driving totalByteSize negative)
    // once that entry is eventually evicted.
    it('tracks totalByteSize correctly when the SAME object reference is mutated in place between upserts, not just replaced with a new one', () => {
      const b = byteBuffer(10, 1000);
      const mutable = { id: 'a', value: 50 };
      b.upsert(mutable); // e.g. a 'request' event
      expect(b.totalByteSize).toBe(50);

      // Mutated in place (same reference) rather than upserted as a new
      // object — e.g. a body appended onto the exchange the 'request'
      // event already inserted. A buggy implementation that re-measures
      // the slot's *stored* value to compute "the old size" would read
      // this already-mutated object for both `previous` and `item`,
      // making the delta 0 — totalByteSize would stay 50, not grow to 300.
      mutable.value = 300;
      b.upsert(mutable); // the matching 'response' event, same reference
      expect(b.totalByteSize).toBe(300);
      expect(b.size).toBe(1);
    });

    it('evicting an entry that was previously mutated in place subtracts its cached size, not a re-measurement of its current (possibly further-changed) value', () => {
      const b = byteBuffer(10, 350);
      const mutable = { id: 'a', value: 50 };
      b.upsert(mutable);
      mutable.value = 300; // as above: mutated in place, not re-upserted as a new object
      b.upsert(mutable);
      expect(b.totalByteSize).toBe(300);

      // Pushes the total to 400 (> 350), evicting 'a'. A correct eviction
      // subtracts exactly the 300 totalByteSize already holds for it,
      // landing on 100 — not some other value from re-deriving 'a''s size
      // off its (mutable, and here further-changed) object at eviction time.
      mutable.value = 999_999; // proves eviction doesn't re-measure `mutable` at all
      b.upsert({ id: 'b', value: 100 });
      expect(b.toArray().map((i) => i.id)).toEqual(['b']);
      expect(b.totalByteSize).toBe(100);
    });

    it("evicts oldest-first by position even when the update that tipped the budget was on that same entry — updating never changes an entry's position (matches the class's existing count-cap behavior)", () => {
      const b = byteBuffer(10, 300);
      b.upsert({ id: 'a', value: 50 });
      b.upsert({ id: 'b', value: 50 });
      // a's growth pushes the total to 330 (100 - 50 + 280) — 'a' is still
      // the *oldest* by position despite being the one just updated, so
      // it's what eviction removes first, not 'b'.
      b.upsert({ id: 'a', value: 280 });
      expect(b.toArray().map((i) => i.id)).toEqual(['b']);
      expect(b.totalByteSize).toBe(50);
    });

    it('evicts an older, untouched entry instead when the updated one is not the oldest', () => {
      const b = byteBuffer(10, 300);
      b.upsert({ id: 'a', value: 50 });
      b.upsert({ id: 'b', value: 50 });
      // b's growth pushes the total to 330 — 'a', the oldest entry, is what
      // gets evicted; 'b' (just updated, and not the oldest) survives.
      b.upsert({ id: 'b', value: 280 });
      expect(b.toArray().map((i) => i.id)).toEqual(['b']);
      expect(b.totalByteSize).toBe(280);
    });

    it('the count cap and byte cap both apply — whichever is hit first evicts', () => {
      const b = byteBuffer(3, 1_000_000); // byte budget never binds here
      for (let i = 0; i < 5; i++) b.upsert({ id: `id-${i}`, value: 1 });
      expect(b.toArray().map((i) => i.id)).toEqual(['id-2', 'id-3', 'id-4']);
      expect(b.totalByteSize).toBe(3);
    });

    it('clear() resets totalByteSize back to 0', () => {
      const b = byteBuffer(10, 1000);
      b.upsert({ id: 'a', value: 100 });
      b.clear();
      expect(b.totalByteSize).toBe(0);
    });
  });
});
