/* eslint-disable sonarjs/no-hardcoded-ip -- address fixtures */
import { describe, expect, it } from 'vitest';
import { clientCertRejectionAlert, createAutoPassthroughHosts } from './clientCertRejection';

describe('clientCertRejectionAlert', () => {
  it.each([
    // What an Android app that doesn't trust user CAs sends (seen on a Pixel, Android 17).
    [
      'C0DE5BF401000000:error:0A000416:SSL routines:ssl3_read_bytes:tls alert certificate unknown:ssl/record/rec_layer_s3.c:923:SSL alert number 46',
      'certificate unknown',
    ],
    // What `openssl s_client -verify_return_error` sends.
    [
      'C0DE5BF401000000:error:0A000418:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:ssl/record/rec_layer_s3.c:923:SSL alert number 48',
      'unknown CA',
    ],
    ['…:sslv3 alert bad certificate:…:SSL alert number 42', 'bad certificate'],
    ['…:SSL alert number 43', 'unsupported certificate'],
    ['…:SSL alert number 44', 'certificate revoked'],
    ['…:SSL alert number 45', 'certificate expired'],
  ])('reads %s as a refusal (%s)', (message, alert) => {
    expect(clientCertRejectionAlert(new Error(message))).toBe(alert);
  });

  it.each([
    // A client hanging up mid-handshake looks the same as a network drop.
    'socket hang up',
    'read ECONNRESET',
    // Alerts that aren't about the certificate.
    '…:tlsv1 alert protocol version:…:SSL alert number 70',
    '…:sslv3 alert handshake failure:…:SSL alert number 40',
    '…:tlsv1 alert decode error:…:SSL alert number 50',
  ])('does not read %s as a refusal', (message) => {
    expect(clientCertRejectionAlert(new Error(message))).toBeUndefined();
  });

  it('tolerates an error without a message', () => {
    expect(clientCertRejectionAlert(undefined)).toBeUndefined();
    expect(clientCertRejectionAlert({})).toBeUndefined();
  });
});

describe('createAutoPassthroughHosts', () => {
  const phone = (host: string, port = 443) => ({ clientAddress: '127.0.0.1', host, port });

  it('records a target once and matches its host case-insensitively', () => {
    const hosts = createAutoPassthroughHosts();
    expect(hosts.has(phone('api.example.com'))).toBe(false);
    expect(hosts.add(phone('API.example.com'))).toBe(true);
    expect(hosts.add(phone('api.example.com'))).toBe(false);
    expect(hosts.has(phone('Api.Example.Com'))).toBe(true);
    expect(hosts.has(phone('other.example.com'))).toBe(false);
  });

  it('keeps one client, and one port, from speaking for another', () => {
    const hosts = createAutoPassthroughHosts();
    hosts.add(phone('api.example.com'));
    expect(hosts.has({ clientAddress: '192.168.1.20', host: 'api.example.com', port: 443 })).toBe(false);
    expect(hosts.has(phone('api.example.com', 8443))).toBe(false);
  });

  it('forgets a target once its time is up, and can record it again', () => {
    let time = 1_000;
    const hosts = createAutoPassthroughHosts({ ttlMs: 100, now: () => time });
    hosts.add(phone('api.example.com'));
    time += 99;
    expect(hosts.has(phone('api.example.com'))).toBe(true);
    time += 1;
    expect(hosts.has(phone('api.example.com'))).toBe(false);
    expect(hosts.add(phone('api.example.com'))).toBe(true);
  });

  it('does not extend a target by using it', () => {
    let time = 0;
    const hosts = createAutoPassthroughHosts({ ttlMs: 100, now: () => time });
    hosts.add(phone('api.example.com'));
    for (time = 10; time < 100; time += 10) expect(hosts.has(phone('api.example.com'))).toBe(true);
    time = 100;
    expect(hosts.has(phone('api.example.com'))).toBe(false);
  });

  it('forgets every target on clear()', () => {
    const hosts = createAutoPassthroughHosts();
    hosts.add(phone('a.example'));
    hosts.add(phone('b.example', 8443));
    hosts.clear();
    expect(hosts.has(phone('a.example'))).toBe(false);
    expect(hosts.has(phone('b.example', 8443))).toBe(false);
    expect(hosts.add(phone('a.example'))).toBe(true);
  });

  it('caps how many targets one client may hold, without starving another client', () => {
    const hosts = createAutoPassthroughHosts({ perClientLimit: 2 });
    const attacker = (host: string) => ({ clientAddress: '192.168.1.66', host, port: 443 });
    expect(hosts.add(attacker('a.invalid'))).toBe(true);
    expect(hosts.add(attacker('b.invalid'))).toBe(true);
    expect(hosts.add(attacker('c.invalid'))).toBe(false);
    expect(hosts.add(phone('api.example.com'))).toBe(true);
  });

  it('stops recording new targets at its limit, making room again as old ones expire', () => {
    let time = 0;
    const hosts = createAutoPassthroughHosts({ limit: 2, ttlMs: 100, now: () => time });
    expect(hosts.add(phone('a.example'))).toBe(true);
    expect(hosts.add(phone('b.example'))).toBe(true);
    expect(hosts.add(phone('c.example'))).toBe(false);
    expect(hosts.has(phone('c.example'))).toBe(false);
    time = 100;
    expect(hosts.add(phone('c.example'))).toBe(true);
  });
});
