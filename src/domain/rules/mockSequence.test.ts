import { describe, expect, it } from 'vitest';
import { pickMockAction } from './mockSequence';
import type { MockAction } from './types';

describe('pickMockAction', () => {
  it('returns the action unchanged when responses is absent', () => {
    const action: MockAction = { type: 'mock', status: 200, body: { items: [] } };
    expect(pickMockAction(action, 0)).toBe(action);
    expect(pickMockAction(action, 5)).toBe(action);
  });

  it('returns the action unchanged when responses is an empty array', () => {
    const action: MockAction = { type: 'mock', status: 200, responses: [] };
    expect(pickMockAction(action, 0)).toBe(action);
  });

  it('picks responses[callIndex] for the 1st/2nd/3rd match', () => {
    const action: MockAction = {
      type: 'mock',
      responses: [{ body: { items: ['A'] } }, { body: { items: ['A', 'B'] } }, { body: { items: ['A', 'B', 'C'] } }],
    };
    expect(pickMockAction(action, 0).body).toEqual({ items: ['A'] });
    expect(pickMockAction(action, 1).body).toEqual({ items: ['A', 'B'] });
    expect(pickMockAction(action, 2).body).toEqual({ items: ['A', 'B', 'C'] });
  });

  it('keeps reusing the last entry once the sequence is exhausted', () => {
    const action: MockAction = {
      type: 'mock',
      responses: [{ status: 200 }, { status: 404 }],
    };
    expect(pickMockAction(action, 2).status).toBe(404);
    expect(pickMockAction(action, 99).status).toBe(404);
  });

  it('clamps a negative callIndex to the first entry', () => {
    const action: MockAction = { type: 'mock', responses: [{ status: 201 }, { status: 202 }] };
    expect(pickMockAction(action, -1).status).toBe(201);
  });

  it("falls back to the base action's own fields for anything a step omits", () => {
    const action: MockAction = {
      type: 'mock',
      status: 200,
      headers: { 'X-Base': '1' },
      responses: [{ status: 201 }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.status).toBe(201);
    expect(picked.headers).toEqual({ 'X-Base': '1' });
  });

  it("a step's own body wins over the base action's bodyFile, clearing it", () => {
    const action: MockAction = {
      type: 'mock',
      bodyFile: 'base.json',
      responses: [{ body: { from: 'step' } }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.body).toEqual({ from: 'step' });
    expect(picked.bodyFile).toBeUndefined();
  });

  it("a step's own bodyFile wins over the base action's inline body, clearing it", () => {
    const action: MockAction = {
      type: 'mock',
      body: { from: 'base' },
      responses: [{ bodyFile: 'step.json' }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.bodyFile).toBe('step.json');
    expect(picked.body).toBeUndefined();
  });

  it("a step that sets neither body nor bodyFile inherits the base action's body untouched", () => {
    const action: MockAction = {
      type: 'mock',
      body: { from: 'base' },
      responses: [{ status: 201 }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.body).toEqual({ from: 'base' });
    expect(picked.bodyFile).toBeUndefined();
  });

  // agy code review (issue #181 PR): a step overriding only body/bodyFile
  // left the base action's `simulate` sitting on the merged result, which
  // requestHandler.ts's "simulate wins over body" check would then honor
  // instead of the step's body — silently defeating the very override the
  // step was written for.
  it("a step's own body wins over the base action's simulate, clearing it", () => {
    const action: MockAction = {
      type: 'mock',
      simulate: 'timeout',
      responses: [{ body: { from: 'step' } }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.body).toEqual({ from: 'step' });
    expect(picked.simulate).toBeUndefined();
  });

  it("a step's own bodyFile wins over the base action's simulate, clearing it", () => {
    const action: MockAction = {
      type: 'mock',
      simulate: 'close',
      responses: [{ bodyFile: 'step.json' }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.bodyFile).toBe('step.json');
    expect(picked.simulate).toBeUndefined();
  });

  it("a step's own simulate wins over the base action's body, clearing body/bodyFile", () => {
    const action: MockAction = {
      type: 'mock',
      body: { from: 'base' },
      responses: [{ simulate: 'close' }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.simulate).toBe('close');
    expect(picked.body).toBeUndefined();
    expect(picked.bodyFile).toBeUndefined();
  });

  it("a step's own simulate wins over the base action's bodyFile, clearing body/bodyFile", () => {
    const action: MockAction = {
      type: 'mock',
      bodyFile: 'base.json',
      responses: [{ simulate: 'timeout' }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.simulate).toBe('timeout');
    expect(picked.body).toBeUndefined();
    expect(picked.bodyFile).toBeUndefined();
  });

  // agy code review, second pass: the same silent-defeat bug applied to
  // status/statusMessage/headers too, not just body/bodyFile — a step
  // setting any response-describing field must clear an inherited
  // `simulate`, or that `simulate` keeps winning downstream regardless of
  // what the step asked for.
  it("a step's own status wins over the base action's simulate, clearing it", () => {
    const action: MockAction = {
      type: 'mock',
      simulate: 'timeout',
      responses: [{ status: 500 }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.status).toBe(500);
    expect(picked.simulate).toBeUndefined();
  });

  it("a step's own headers win over the base action's simulate, clearing it", () => {
    const action: MockAction = {
      type: 'mock',
      simulate: 'close',
      responses: [{ headers: { 'X-Step': '1' } }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.headers).toEqual({ 'X-Step': '1' });
    expect(picked.simulate).toBeUndefined();
  });

  it("a step's own simulate clears an inherited status/headers, not just body", () => {
    const action: MockAction = {
      type: 'mock',
      status: 200,
      headers: { 'X-Base': '1' },
      responses: [{ simulate: 'close' }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.simulate).toBe('close');
    expect(picked.status).toBeUndefined();
    expect(picked.headers).toBeUndefined();
  });

  it('a step that sets only delayMs leaves both an inherited simulate and inherited response fields untouched', () => {
    const action: MockAction = {
      type: 'mock',
      simulate: 'timeout',
      responses: [{ delayMs: 500 }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.delayMs).toBe(500);
    expect(picked.simulate).toBe('timeout');
  });
});
