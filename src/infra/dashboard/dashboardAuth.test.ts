/* eslint-disable sonarjs/no-hardcoded-ip -- private-range (RFC 1918) client address fixtures, not real addresses */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../domain/auth/passwordHash';
import { createDashboardAuth, type DashboardAuthDeps } from './dashboardAuth';

const TOKEN = 'secret-token';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });
}

const socketOf = () => new FakeSocket() as unknown as WebSocket & FakeSocket;

function requestFrom(ip: string, url = '/ws', cookie?: string): IncomingMessage {
  return { url, headers: { cookie }, socket: { remoteAddress: ip } } as unknown as IncomingMessage;
}

const login = (password: string) => ({ type: 'login', password }) as const;

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword('correct horse');
});

function setup(overrides: Partial<DashboardAuthDeps> = {}) {
  const sendInitialPayload = vi.fn();
  const auth = createDashboardAuth({
    accessToken: undefined,
    loadPasswordHash: () => null,
    sendInitialPayload,
    sleep: async () => {},
    ...overrides,
  });
  return { auth, sendInitialPayload };
}

describe('dashboard auth (issue #207)', () => {
  describe('admitConnection', () => {
    it('lets everyone in when neither a password nor a token is configured, without calling them verified', () => {
      const { auth } = setup();
      const socket = socketOf();
      expect(auth.admitConnection(socket, requestFrom('10.0.0.1'))).toBe('authenticated');
      expect(auth.isAuthenticated(socket)).toBe(true);
      expect(auth.isVerified(socket)).toBe(false);
    });

    it('admits a request carrying the access token and marks it verified (issue #205)', () => {
      const { auth } = setup({ accessToken: TOKEN });
      const socket = socketOf();
      expect(auth.admitConnection(socket, requestFrom('10.0.0.1', `/ws?token=${TOKEN}`))).toBe('authenticated');
      expect(auth.isVerified(socket)).toBe(true);
    });

    it('asks for a login when the access token is missing or wrong', () => {
      const { auth } = setup({ accessToken: TOKEN });
      for (const url of ['/ws', '/ws?token=nope']) {
        const socket = socketOf();
        expect(auth.admitConnection(socket, requestFrom('10.0.0.1', url))).toBe('needs-login');
        expect(auth.isAuthenticated(socket)).toBe(false);
      }
    });

    it('asks for the password even with a valid token once a password is set', () => {
      const { auth } = setup({ accessToken: TOKEN, loadPasswordHash: () => passwordHash });
      const socket = socketOf();
      expect(auth.admitConnection(socket, requestFrom('10.0.0.1', `/ws?token=${TOKEN}`))).toBe('needs-login');
      expect(auth.authRequiredMessage()).toEqual({ type: 'authRequired', method: 'password' });
    });

    it('tells a token-protected dashboard to ask for the token, not a password', () => {
      const { auth } = setup({ accessToken: TOKEN });
      expect(auth.authRequiredMessage()).toEqual({ type: 'authRequired', method: 'token' });
    });

    it('caps unauthenticated sockets per IP, and frees a slot when one closes (issue #159)', () => {
      const { auth } = setup({ accessToken: TOKEN });
      const open = Array.from({ length: 3 }, () => socketOf());
      for (const socket of open) expect(auth.admitConnection(socket, requestFrom('10.0.0.1'))).toBe('needs-login');

      const fourth = socketOf();
      expect(auth.admitConnection(fourth, requestFrom('10.0.0.1'))).toBe('rejected');
      expect(fourth.close).toHaveBeenCalledWith(1008, 'Too many concurrent unauthenticated connections');
      // Another address is unaffected.
      expect(auth.admitConnection(socketOf(), requestFrom('10.0.0.2'))).toBe('needs-login');

      open[0]!.emit('close');
      expect(auth.admitConnection(socketOf(), requestFrom('10.0.0.1'))).toBe('needs-login');
    });
  });

  describe('handleLogin', () => {
    async function admitted(deps: Partial<DashboardAuthDeps> = {}, ip = '10.0.0.1') {
      const ctx = setup({ loadPasswordHash: () => passwordHash, ...deps });
      const socket = socketOf();
      const req = requestFrom(ip);
      ctx.auth.admitConnection(socket, req);
      return { ...ctx, socket, req };
    }

    it('authenticates with the right password, sends the snapshot, and marks the socket verified', async () => {
      const { auth, socket, sendInitialPayload } = await admitted();
      await auth.handleLogin(socket, login('correct horse'));
      expect(auth.isAuthenticated(socket)).toBe(true);
      expect(auth.isVerified(socket)).toBe(true);
      expect(sendInitialPayload).toHaveBeenCalledWith(socket);
    });

    it('answers a wrong password with authFailed and stays unauthenticated', async () => {
      const { auth, socket, sendInitialPayload } = await admitted();
      await auth.handleLogin(socket, login('wrong'));
      expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({ type: 'authFailed' });
      expect(auth.isAuthenticated(socket)).toBe(false);
      expect(sendInitialPayload).not.toHaveBeenCalled();
    });

    it('never lets a login succeed on a token-protected dashboard with no password (issue #205)', async () => {
      const { auth, socket } = await admitted({ accessToken: TOKEN, loadPasswordHash: () => null });
      await auth.handleLogin(socket, login('anything'));
      expect(auth.isAuthenticated(socket)).toBe(false);
    });

    it('treats a failure to verify as a failed login rather than leaving the client hanging', async () => {
      const { auth, socket } = await admitted({ loadPasswordHash: () => 'not-a-valid-hash' });
      await auth.handleLogin(socket, login('x'));
      expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({ type: 'authFailed' });
    });

    it('drops a second login that arrives while one is still in flight', async () => {
      const { auth, socket, sendInitialPayload } = await admitted();
      await Promise.all([
        auth.handleLogin(socket, login('correct horse')),
        auth.handleLogin(socket, login('correct horse')),
      ]);
      expect(sendInitialPayload).toHaveBeenCalledTimes(1);
    });

    it('closes the socket on the 5th consecutive failure, and refuses that IP even on a fresh connection', async () => {
      const { auth, socket } = await admitted();
      for (let i = 0; i < 5; i++) await auth.handleLogin(socket, login('wrong'));
      expect(socket.close).toHaveBeenCalledWith(1008, 'Too many failed login attempts');

      const reconnect = socketOf();
      expect(auth.admitConnection(reconnect, requestFrom('10.0.0.1'))).toBe('rejected');
      // A different IP still gets its own attempts.
      expect(auth.admitConnection(socketOf(), requestFrom('10.0.0.9'))).toBe('needs-login');
    });

    it('forgives earlier failures once the right password is given', async () => {
      const { auth, socket } = await admitted();
      for (let i = 0; i < 4; i++) await auth.handleLogin(socket, login('wrong'));
      await auth.handleLogin(socket, login('correct horse'));
      // 4 + 4 failures would lock the IP out (limit 5) if the first 4 were still counted.
      const next = socketOf();
      const nextReq = requestFrom('10.0.0.1');
      expect(auth.admitConnection(next, nextReq)).toBe('needs-login');
      for (let i = 0; i < 4; i++) await auth.handleLogin(next, login('wrong'));
      expect(auth.admitConnection(socketOf(), requestFrom('10.0.0.1'))).toBe('needs-login');
    });

    it('ignores a login from a socket that was never admitted to log in', async () => {
      const { auth, sendInitialPayload } = setup({ loadPasswordHash: () => passwordHash });
      const stranger = socketOf();
      await auth.handleLogin(stranger, login('correct horse'));
      expect(auth.isAuthenticated(stranger)).toBe(false);
      expect(stranger.send).not.toHaveBeenCalled();
      expect(sendInitialPayload).not.toHaveBeenCalled();
    });

    it('does not let a login that began under the old password succeed after the password changed', async () => {
      const { auth, socket, sendInitialPayload } = await admitted();
      const attempt = auth.handleLogin(socket, login('correct horse'));
      auth.onPasswordChanged('new-hash');
      await attempt;
      expect(auth.isAuthenticated(socket)).toBe(false);
      expect(auth.isVerified(socket)).toBe(false);
      expect(sendInitialPayload).not.toHaveBeenCalled();
      // The client is told to retry.
      expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({ type: 'authFailed' });
    });

    it('does not charge such a superseded attempt to the IP', async () => {
      const { auth, socket } = await admitted();
      for (let i = 0; i < 3; i++) await auth.handleLogin(socket, login('wrong'));
      const attempt = auth.handleLogin(socket, login('correct horse'));
      auth.onPasswordChanged(passwordHash);
      await attempt;
      await auth.handleLogin(socket, login('wrong'));
      // 3 + 1 failures counted (the superseded one is not): still below the limit of 5.
      expect(auth.admitConnection(socketOf(), requestFrom('10.0.0.1'))).toBe('needs-login');
      await auth.handleLogin(socket, login('wrong'));
      expect(auth.admitConnection(socketOf(), requestFrom('10.0.0.1'))).toBe('rejected');
    });
  });

  describe('password changes', () => {
    it('revokes password proofs when the password changes, but not token proofs', async () => {
      const byPassword = await (async () => {
        const ctx = setup({ loadPasswordHash: () => passwordHash });
        const socket = socketOf();
        const req = requestFrom('10.0.0.1');
        ctx.auth.admitConnection(socket, req);
        await ctx.auth.handleLogin(socket, login('correct horse'));
        return { ...ctx, socket };
      })();
      expect(byPassword.auth.isVerified(byPassword.socket)).toBe(true);
      byPassword.auth.onPasswordChanged('new-hash');
      expect(byPassword.auth.isVerified(byPassword.socket)).toBe(false);
      // Still connected: only the right to run a host-level update is revoked.
      expect(byPassword.auth.isAuthenticated(byPassword.socket)).toBe(true);

      const { auth } = setup({ accessToken: TOKEN });
      const tokenSocket = socketOf();
      auth.admitConnection(tokenSocket, requestFrom('10.0.0.1', `/ws?token=${TOKEN}`));
      auth.onPasswordChanged('new-hash');
      expect(auth.isVerified(tokenSocket)).toBe(true);
    });

    it('keeps honoring the last known password when the config becomes unreadable (fails closed)', () => {
      let broken = false;
      const { auth } = setup({
        loadPasswordHash: () => {
          if (broken) throw new Error('corrupt config');
          return passwordHash;
        },
      });
      expect(auth.currentPasswordHash()).toBe(passwordHash);
      broken = true;
      expect(auth.currentPasswordHash()).toBe(passwordHash);
      expect(auth.admitConnection(socketOf(), requestFrom('10.0.0.1'))).toBe('needs-login');
    });

    it('applies a just-set password at once, even if the config cannot be read right after', () => {
      let broken = false;
      const { auth } = setup({
        loadPasswordHash: () => {
          if (broken) throw new Error('corrupt config');
          return null;
        },
      });
      expect(auth.currentPasswordHash()).toBeNull();
      auth.onPasswordChanged(passwordHash);
      broken = true;
      expect(auth.admitConnection(socketOf(), requestFrom('10.0.0.1'))).toBe('needs-login');
    });
  });
});
