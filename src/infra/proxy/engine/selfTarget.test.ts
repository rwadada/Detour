/* eslint-disable sonarjs/no-hardcoded-ip -- address fixtures */
import { describe, expect, it } from 'vitest';
import { canonicalIp, createSelfTargetGuard } from './selfTarget';

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

  it('recognises a longhand interface address and one carrying a zone ID', async () => {
    expect(await guardFor(undefined).isSelfTarget('fe80:0:0:0:0:0:0:1', PORT)).toBe(true);
    expect(await guardFor(undefined).isSelfTarget('fe80::1%en0', PORT)).toBe(true);
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
    ['2001:DB8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['127.0.0.1', '127.0.0.1'],
    ['Example.COM', 'example.com'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalIp(input)).toBe(expected);
  });
});
