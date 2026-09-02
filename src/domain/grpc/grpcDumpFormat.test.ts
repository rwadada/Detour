import { describe, expect, it } from 'vitest';
import { formatGrpcSection, type GrpcExchangeInfo } from './grpcDumpFormat';

function baseInfo(overrides: Partial<GrpcExchangeInfo> = {}): GrpcExchangeInfo {
  return {
    service: 'helloworld.Greeter',
    method: 'SayHello',
    requestFrames: [],
    requestFramesTruncated: false,
    responseFrames: [],
    responseFramesTruncated: false,
    ...overrides,
  };
}

describe('formatGrpcSection', () => {
  it('includes the service/method line', () => {
    expect(formatGrpcSection(baseInfo())).toContain('gRPC: helloworld.Greeter/SayHello');
  });

  it('shows "(none)" for empty request/response frame lists', () => {
    const dump = formatGrpcSection(baseInfo());
    expect(dump).toContain('Request messages (0):');
    expect(dump).toContain('Response messages (0):');
    expect(dump).toContain('(none)');
  });

  it('pretty-prints a decoded frame under its index', () => {
    const dump = formatGrpcSection(baseInfo({ requestFrames: [{ json: { name: 'world' } }] }));
    expect(dump).toContain('[0]');
    expect(dump).toContain('"name": "world"');
  });

  it('shows a per-frame error inline instead of a JSON body', () => {
    const dump = formatGrpcSection(baseInfo({ responseFrames: [{ error: 'unknown field' }] }));
    expect(dump).toContain('[0] (unknown field)');
  });

  it('marks truncation on the frame count', () => {
    const dump = formatGrpcSection(baseInfo({ requestFrames: [{ json: {} }], requestFramesTruncated: true }));
    expect(dump).toContain('Request messages (1+, truncated):');
  });

  it('shows decodeUnavailableReason in place of the frame lists', () => {
    const dump = formatGrpcSection(baseInfo({ decodeUnavailableReason: 'no --proto configured' }));
    expect(dump).toContain('no --proto configured');
    expect(dump).not.toContain('Request messages');
    expect(dump).not.toContain('Response messages');
  });
});
