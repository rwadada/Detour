import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { ProtoRegistry } from '../grpc/protoRegistry';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

const PROTO_SOURCE = `
syntax = "proto3";
package helloworld;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
}

message HelloRequest {
  string name = 1;
}

message HelloReply {
  string message = 1;
}
`;

function writeProtoFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-proto-test-'));
  const file = path.join(dir, 'helloworld.proto');
  fs.writeFileSync(file, PROTO_SOURCE, 'utf8');
  return file;
}

/**
 * Covers `protoSchema` (issue #18's dashboard follow-up): the dashboard
 * server sends the loaded `--proto` schema's JSON descriptor to every
 * connecting client, once, so the browser can reconstruct it client-side
 * (via `protobufjs/light`) and decode a gRPC exchange's message frames
 * itself — see `web/src/entities/grpc` for the browser-side half. This only
 * covers that the descriptor is relayed correctly (or `null` is, absent a
 * `--proto`); the CLI's own `--proto` loading is `ProtoRegistry.load`'s
 * concern (see `infra/grpc/protoRegistry.test.ts`), and decoding the
 * descriptor back into a usable schema is covered there too (`toJSON()`'s
 * own round-trip test).
 */
describe('startDashboardServer — protoSchema (issue #18)', () => {
  let handle: DashboardServerHandle | undefined;
  // Initialized here (not just per-`it`) so `afterEach` can safely iterate
  // it even if a test throws before reaching its own `sockets = []` — an
  // unset array there would mask the real failure behind a `TypeError` in
  // cleanup instead (a Copilot review on PR #127 caught this).
  let sockets: WebSocket[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await handle?.stop();
    handle = undefined;
    for (const file of dirs.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  function connect(): WebSocket {
    const socket = new WebSocket(`ws://localhost:${handle?.port}/ws`);
    sockets.push(socket);
    return socket;
  }

  function waitForMessage(
    socket: WebSocket,
    predicate: (message: DashboardServerMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<DashboardServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a matching message')), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as DashboardServerMessage;
        if (predicate(message)) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(message);
        }
      };
      socket.on('message', onMessage);
      socket.on('error', reject);
    });
  }

  it('sends schema: null when no protoRegistry is configured for this session', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'protoSchema');
    expect(message).toEqual({ type: 'protoSchema', schema: null });
  });

  it('sends the loaded schema as a JSON descriptor right after connecting', async () => {
    const file = writeProtoFile();
    dirs.push(file);
    const protoRegistry = await ProtoRegistry.load([file]);
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, protoRegistry }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'protoSchema');
    expect(message).toEqual({ type: 'protoSchema', schema: protoRegistry.toJSON() });
  });

  it('sends the same schema to a second connecting client (computed once, not per-connection)', async () => {
    const file = writeProtoFile();
    dirs.push(file);
    const protoRegistry = await ProtoRegistry.load([file]);
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, protoRegistry }, eventBus);
    sockets = [];

    const first = await waitForMessage(connect(), (m) => m.type === 'protoSchema');
    const second = await waitForMessage(connect(), (m) => m.type === 'protoSchema');
    expect(second).toEqual(first);
  });
});
