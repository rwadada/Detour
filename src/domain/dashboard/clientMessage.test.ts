import { describe, expect, it } from 'vitest';
import { parseClientMessage } from './clientMessage';

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

const validExchange = {
  id: 'x',
  method: 'GET',
  url: 'http://example.com/',
  host: 'example.com',
  isSSL: false,
  requestHeaders: { accept: '*/*' },
};

describe('parseClientMessage', () => {
  it.each([
    { type: 'login', password: 'pw' },
    { type: 'setIntercept', enabled: false },
    { type: 'setFocus', hosts: ['a.example'] },
    { type: 'setThrottle', state: { enabled: true, downKbps: 1, upKbps: 1, latencyMs: 0, packetLossPct: 0 } },
    { type: 'setBlockHosts', state: { hosts: ['x'], mode: 'reset' } },
    { type: 'breakpointResume', command: { id: 'a', phase: 'request', action: 'abort' } },
    {
      type: 'breakpointResume',
      command: {
        id: 'a',
        phase: 'response',
        action: 'resume',
        edits: { status: 201, headers: { a: 'b' }, body: 'eA==' },
      },
    },
    { type: 'setRules', data: { rules: [] } },
    { type: 'createRuleProfile', name: 'p', template: 'blank' },
    { type: 'saveActiveRulesAsProfile', name: 'p' },
    { type: 'applyRuleProfile', name: 'p' },
    { type: 'replay', exchange: validExchange },
    {
      type: 'replay',
      exchange: validExchange,
      overrides: { method: 'PUT', url: 'https://x.test/', headers: { a: 'b' }, body: 'eA==' },
    },
    { type: 'replay', exchange: validExchange, overrides: {} },
    { type: 'setUserConfig', state: { lanAccess: true } },
    { type: 'setDashboardPassword', password: null },
    { type: 'queryHistory', requestId: 'r', query: { limit: 50, host: 'a', statusMin: 400 } },
    { type: 'startUpdate' },
    { type: 'checkUpdate' },
  ])('accepts a well-formed %j', (message) => {
    expect(parse(message)).toEqual({ ok: true, message });
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '[1]'],
    ['no type', '{}'],
    ['an unknown type', '{"type":"rm -rf"}'],
    ['an inherited property name as type', '{"type":"toString"}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it.each([
    { type: 'login' },
    { type: 'setIntercept', enabled: 'yes' },
    { type: 'setFocus', hosts: 'a' },
    { type: 'setFocus', hosts: [1] },
    { type: 'setThrottle', state: { enabled: true } },
    { type: 'setThrottle', state: { enabled: true, downKbps: '1', upKbps: 1, latencyMs: 0, packetLossPct: 0 } },
    { type: 'setBlockHosts', state: { hosts: [], mode: 'drop' } },
    { type: 'breakpointResume', command: { id: 'a', phase: 'middle', action: 'abort' } },
    {
      type: 'breakpointResume',
      command: { id: 'a', phase: 'request', action: 'resume', edits: { headers: { a: 1 } } },
    },
    { type: 'setRules', data: { rules: 'none' } },
    { type: 'createRuleProfile', name: 'p', template: 'other' },
    { type: 'applyRuleProfile', name: 'x'.repeat(1000) },
    { type: 'replay', exchange: { ...validExchange, url: 5 } },
    { type: 'replay' },
    { type: 'replay', exchange: validExchange, overrides: 'nope' },
    { type: 'replay', exchange: validExchange, overrides: { method: '' } },
    { type: 'replay', exchange: validExchange, overrides: { url: 5 } },
    { type: 'replay', exchange: validExchange, overrides: { headers: { a: 1 } } },
    { type: 'replay', exchange: validExchange, overrides: { body: 5 } },
    { type: 'setDashboardPassword', password: 5 },
    { type: 'queryHistory', requestId: 'r', query: { limit: 'many' } },
    { type: 'queryHistory', query: { limit: 1 } },
  ])('rejects a malformed %j with a reason naming the message type', (message) => {
    const result = parse(message);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith(`${message.type}:`)).toBe(true);
  });
});
