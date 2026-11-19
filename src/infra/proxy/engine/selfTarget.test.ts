/* eslint-disable sonarjs/no-hardcoded-ip -- address fixtures */
import dns from 'node:dns';
import { describe, expect, it } from 'vitest';
import { canonicalIp, createSelfTargetGuard, SELF_TARGET_LOOKUP_ERROR } from './selfTarget';

function guardWith(dns: Record<string, string[]> = {}, local: string[] = ['192.168.1.5']) {
  const guard = createSelfTargetGuard(
    async (host) => {
      const answer = dns[host];
      if (!answer) throw new Error('ENOTFOUND');
      return answer;
    },
    () => local,
  );
  guard.protectPort(19080);
  return guard;
}

describe('createSelfTargetGuard', () => {
  it.each(['127.0.0.1', '::1', '[::1]', '0.0.0.0', '::ffff:127.0.0.1', '192.168.1.5'])(
    'treats %s on a protected port as self',
    async (host) => {
      expect(await guardWith().isSelfTarget(host, 19080)).toBe(true);
    },
  );

  it('ignores ports that are not protected, so ordinary localhost dev servers stay reachable', async () => {
    expect(await guardWith().isSelfTarget('127.0.0.1', 3000)).toBe(false);
  });

  it('ignores remote addresses on a protected port', async () => {
    expect(await guardWith().isSelfTarget('203.0.113.9', 19080)).toBe(false);
  });

  it('judges a hostname by what it resolves to (localhost, DNS rebinding)', async () => {
    const guard = guardWith({ localhost: ['::1', '127.0.0.1'], 'rebind.example': ['203.0.113.9', '127.0.0.1'] });
    expect(await guard.isSelfTarget('localhost', 19080)).toBe(true);
    expect(await guard.isSelfTarget('rebind.example', 19080)).toBe(true);
  });

  it('lets a name that resolves elsewhere or not at all through', async () => {
    const guard = guardWith({ 'api.example': ['203.0.113.9'] });
    expect(await guard.isSelfTarget('api.example', 19080)).toBe(false);
    expect(await guard.isSelfTarget('nx.example', 19080)).toBe(false);
  });

  it('protects every port it is told about', async () => {
    const guard = guardWith();
    guard.protectPort(18080);
    expect(await guard.isSelfTarget('127.0.0.1', 18080)).toBe(true);
  });
});

/**
 * A listener's port number is shared by every address family: an IPv4 server
 * on `127.0.0.1:P` and the dashboard on `[::1]:P` are different sockets. Told
 * the address a listener is really bound to, the guard must not take the one
 * for the other (that was a rare 403 on an unrelated dev server).
 */
describe('createSelfTargetGuard — knowing the bound address', () => {
  const PORT = 4040;

  function guardFor(listenerAddress: string, dns: Record<string, string[]> = { localhost: ['::1', '127.0.0.1'] }) {
    const guard = createSelfTargetGuard(
      async (host) => {
        const answer = dns[host];
        if (!answer) throw new Error('ENOTFOUND');
        return answer;
      },
      () => ['192.168.1.5', 'fe80::1'],
    );
    guard.protectPort(PORT, listenerAddress);
    return guard;
  }

  describe('a listener on ::1 (what `localhost` binds to on most machines)', () => {
    it.each(['::1', '[::1]', 'localhost', '::'])('is reached by %s', async (host) => {
      expect(await guardFor('::1').isSelfTarget(host, PORT)).toBe(true);
    });

    it('is not reached by an unrelated IPv4 server on the same port number', async () => {
      const guard = guardFor('::1');
      expect(await guard.isSelfTarget('127.0.0.1', PORT)).toBe(false);
      // `0.0.0.0` connects to IPv4 loopback, not to ::1.
      expect(await guard.isSelfTarget('0.0.0.0', PORT)).toBe(false);
    });
  });

  describe('a listener on 127.0.0.1', () => {
    it.each(['127.0.0.1', '0.0.0.0', '::ffff:127.0.0.1'])('is reached by %s', async (host) => {
      expect(await guardFor('127.0.0.1').isSelfTarget(host, PORT)).toBe(true);
    });

    it('is reached by localhost when it resolves to IPv4 too, but not by ::1 alone', async () => {
      const guard = guardFor('127.0.0.1');
      expect(await guard.isSelfTarget('localhost', PORT)).toBe(true);
      expect(await guard.isSelfTarget('::1', PORT)).toBe(false);
    });

    it('is not reached by another loopback address — it is bound to exactly one', async () => {
      expect(await guardFor('127.0.0.1').isSelfTarget('127.0.0.2', PORT)).toBe(false);
    });
  });

  describe('the IPv4 wildcard 0.0.0.0 (the proxy itself)', () => {
    it.each(['127.0.0.1', '0.0.0.0', '192.168.1.5', 'localhost'])('is reached by %s', async (host) => {
      expect(await guardFor('0.0.0.0').isSelfTarget(host, PORT)).toBe(true);
    });

    it('is IPv4 only: ::1 does not reach it', async () => {
      expect(await guardFor('0.0.0.0').isSelfTarget('::1', PORT)).toBe(false);
    });
  });

  describe('the dual-stack wildcard ::', () => {
    it.each(['::1', '127.0.0.1', '::', '0.0.0.0', '192.168.1.5', 'fe80::1'])('is reached by %s', async (host) => {
      expect(await guardFor('::').isSelfTarget(host, PORT)).toBe(true);
    });
  });

  describe('a listener on one specific interface address', () => {
    it('is reached only by that address', async () => {
      const guard = guardFor('192.168.1.5');
      expect(await guard.isSelfTarget('192.168.1.5', PORT)).toBe(true);
      expect(await guard.isSelfTarget('127.0.0.1', PORT)).toBe(false);
    });
  });

  it('still refuses any remote address, and any port that is not protected, whatever the listener address', async () => {
    const guard = guardFor('::');
    expect(await guard.isSelfTarget('203.0.113.9', PORT)).toBe(false);
    expect(await guard.isSelfTarget('::1', PORT + 1)).toBe(false);
  });

  it('keeps several listeners on one port number apart (one per address family)', async () => {
    const guard = guardFor('::1');
    guard.protectPort(PORT, '192.168.1.5');
    expect(await guard.isSelfTarget('::1', PORT)).toBe(true);
    expect(await guard.isSelfTarget('192.168.1.5', PORT)).toBe(true);
    expect(await guard.isSelfTarget('127.0.0.1', PORT)).toBe(false);
  });
});

/**
 * Every spelling of an address connects to the same socket, so the guard has
 * to recognise all of them — a LAN client writing loopback out longhand
 * (`[0:0:0:0:0:0:0:1]`) or in the hex IPv4-mapped form WHATWG `URL`
 * serializes to (`[::ffff:7f00:1]`) must not be relayed into the dashboard.
 */
describe('createSelfTargetGuard — non-canonical address spellings', () => {
  const PORT = 4040;

  function guardFor(listenerAddress: string | undefined) {
    const guard = createSelfTargetGuard(
      async () => {
        throw new Error('ENOTFOUND');
      },
      () => ['192.168.1.5', 'fe80::1'],
    );
    guard.protectPort(PORT, listenerAddress);
    return guard;
  }

  it.each(['0:0:0:0:0:0:0:1', '[0:0:0:0:0:0:0:1]', '0::1', '0000:0000::0001', '::0001', '[0::1]'])(
    'treats %s as ::1',
    async (host) => {
      expect(await guardFor('::1').isSelfTarget(host, PORT)).toBe(true);
      expect(await guardFor(undefined).isSelfTarget(host, PORT)).toBe(true);
    },
  );

  it.each([
    '::ffff:7f00:1',
    '[::ffff:7f00:1]',
    '0:0:0:0:0:ffff:7f00:1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::FFFF:127.0.0.1',
    '::ffff:7f00:0001',
  ])('treats the IPv4-mapped spelling %s as 127.0.0.1', async (host) => {
    expect(await guardFor('127.0.0.1').isSelfTarget(host, PORT)).toBe(true);
    expect(await guardFor('0.0.0.0').isSelfTarget(host, PORT)).toBe(true);
  });

  it.each(['0:0:0:0:0:0:0:0', '0::0', '0000::'])('treats the unspecified spelling %s as ::', async (host) => {
    expect(await guardFor('::1').isSelfTarget(host, PORT)).toBe(true);
  });

  it('recognises a longhand interface address', async () => {
    expect(await guardFor(undefined).isSelfTarget('fe80:0:0:0:0:0:0:1', PORT)).toBe(true);
  });

  // macOS delivers `fe80::1%<anything>` — an unknown name, a numeric alias of
  // lo0's scope ID, the RFC 6874 `%25` form — to lo0's fe80::1, so no list of
  // this machine's zone spellings can be complete. The zone is ignored, which
  // fails closed: the same address on another interface is refused too.
  it.each([
    'fe80::1%lo0',
    'fe80::1%1',
    'fe80::1%01',
    'fe80::1%0x1',
    'fe80::1%lo0x',
    'fe80::1%999',
    '[fe80::1%25lo0]',
    'fe80::1%en0',
  ])('ignores the zone on the link-local address %s', async (host) => {
    expect(await guardFor(undefined).isSelfTarget(host, PORT)).toBe(true);
    expect(await guardFor('fe80::1').isSelfTarget(host, PORT)).toBe(true);
  });

  // The stack ignores a zone ID on anything but a link-local address, so
  // `[::1%lo0]` still connects to ::1 — the zone must not hide it.
  it.each(['::1%lo0', '[::1%1]', '0::1%en0', '::%lo0'])('ignores the zone on non-link-local %s', async (host) => {
    expect(await guardFor('::1').isSelfTarget(host, PORT)).toBe(true);
    expect(await guardFor(undefined).isSelfTarget(host, PORT)).toBe(true);
  });

  it('matches a zoned target against a listener bound to that address', async () => {
    expect(await guardFor('fe80::1').isSelfTarget('fe80::1%lo0', PORT)).toBe(true);
    expect(await guardFor('192.168.1.5').isSelfTarget('::ffff:c0a8:105%en0', PORT)).toBe(true);
  });

  it.each(['::127.0.0.1', '[::7f00:1]'])('treats the IPv4-compatible spelling %s as 127.0.0.1', async (host) => {
    expect(await guardFor('127.0.0.1').isSelfTarget(host, PORT)).toBe(true);
  });

  it.each(['0.0.0.1', '0.1.2.3', '::ffff:0:1'])('treats %s in 0.0.0.0/8 like 0.0.0.0', async (host) => {
    expect(await guardFor('127.0.0.1').isSelfTarget(host, PORT)).toBe(true);
    expect(await guardFor('0.0.0.0').isSelfTarget(host, PORT)).toBe(true);
    expect(await guardFor('::1').isSelfTarget(host, PORT)).toBe(false);
  });

  it('normalises a listener address given in a non-canonical spelling too', async () => {
    expect(await guardFor('0:0:0:0:0:0:0:1').isSelfTarget('::1', PORT)).toBe(true);
    expect(await guardFor('::ffff:7f00:1').isSelfTarget('127.0.0.1', PORT)).toBe(true);
  });

  it('still keeps other addresses apart however they are written', async () => {
    expect(await guardFor('::1').isSelfTarget('0:0:0:0:0:0:0:2', PORT)).toBe(false);
    expect(await guardFor('127.0.0.1').isSelfTarget('::ffff:7f00:2', PORT)).toBe(false);
    expect(await guardFor(undefined).isSelfTarget('2001:db8:0:0:0:0:0:1', PORT)).toBe(false);
  });
});

describe('canonicalIp', () => {
  it.each([
    ['0:0:0:0:0:0:0:1', '::1'],
    ['[0000::0001]', '::1'],
    ['0:0:0:0:0:0:0:0', '::'],
    ['::ffff:7f00:1', '127.0.0.1'],
    ['::FFFF:127.0.0.1', '127.0.0.1'],
    ['fe80::1%en0', 'fe80::1'],
    ['[FE80:0::0001%EN0]', 'fe80::1'],
    ['::ffff:7f00:1%en0', '127.0.0.1'],
    ['::1%lo0', '::1'],
    ['2001:db8::5%en0', '2001:db8::5'],
    ['::127.0.0.1', '127.0.0.1'],
    // An IPv4-compatible address never had a first octet of 0: these are plain IPv6.
    ['::1:2', '::1:2'],
    ['::ab:cd', '::ab:cd'],
    ['::1', '::1'],
    ['::', '::'],
    ['2001:DB8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['127.0.0.1', '127.0.0.1'],
    ['Example.COM', 'example.com'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalIp(input)).toBe(expected);
  });
});

/**
 * The connection's own lookup is the guard: checking a name up front and
 * letting the connection resolve it again would let a DNS-rebinding name
 * (TTL 0) answer a public address to the check and loopback to the connection.
 */
describe('createSelfTargetGuard — lookupFor', () => {
  const PORT = 4040;

  function lookupWith(answers: string[][]) {
    let call = 0;
    const guard = createSelfTargetGuard(
      async () => answers[Math.min(call++, answers.length - 1)]!,
      () => ['192.168.1.5'],
    );
    guard.protectPort(PORT, '127.0.0.1');
    return guard;
  }

  function lookup(
    guard: ReturnType<typeof createSelfTargetGuard>,
    port: number,
    options: { all?: boolean; family?: number } = {},
  ) {
    return new Promise<{ err: NodeJS.ErrnoException | null; result: unknown }>((resolve) =>
      guard.lookupFor(port)('rebind.example', options, (err, address, family) =>
        resolve({ err, result: options.all ? address : { address, family } }),
      ),
    );
  }

  it('refuses a name resolving to a protected listener, with a recognisable code', async () => {
    const { err } = await lookup(lookupWith([['127.0.0.1']]), PORT);
    expect(err?.code).toBe(SELF_TARGET_LOOKUP_ERROR);
  });

  it('hands back the very answer it judged when it is safe', async () => {
    expect(await lookup(lookupWith([['203.0.113.10']]), PORT)).toEqual({
      err: null,
      result: { address: '203.0.113.10', family: 4 },
    });
    expect((await lookup(lookupWith([['203.0.113.10', '2001:db8::1']]), PORT, { all: true })).result).toEqual([
      { address: '203.0.113.10', family: 4 },
      { address: '2001:db8::1', family: 6 },
    ]);
  });

  it('judges each connection on its own answer, so a rebinding name is caught when it turns to loopback', async () => {
    const guard = lookupWith([['203.0.113.10'], ['127.0.0.1']]);
    expect(await guard.isSelfTarget('rebind.example', PORT)).toBe(false);
    expect((await lookup(guard, PORT)).err?.code).toBe(SELF_TARGET_LOOKUP_ERROR);
  });

  it('leaves other ports to Node’s own lookup and honours the requested family', async () => {
    expect(lookupWith([['127.0.0.1']]).lookupFor(PORT + 1)).toBe(dns.lookup);
    expect((await lookup(lookupWith([['2001:db8::1']]), PORT, { family: 4 })).err?.code).toBe('ENOTFOUND');
  });
});
