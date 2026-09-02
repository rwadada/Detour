import { create } from 'zustand';
import type {
  BreakpointPayload,
  BreakpointRequestEdits,
  BreakpointResponseEdits,
  DashboardConnection,
} from '@/shared/api';

export interface BreakpointResumeState {
  /** Exchanges currently paused by a `breakpoint` rule, keyed by exchange id — awaiting resume/abort from this (or any other connected) dashboard tab. */
  pausedBreakpoints: Record<string, BreakpointPayload>;
  /** Resumes a paused request, optionally with edits. Omit `edits` to forward it unchanged. */
  resumeBreakpointRequest: (id: string, edits?: BreakpointRequestEdits) => void;
  /** Resumes a paused response, optionally with edits. Omit `edits` to return it unchanged. */
  resumeBreakpointResponse: (id: string, edits?: BreakpointResponseEdits) => void;
  /** Aborts a paused exchange instead of letting it continue. */
  abortBreakpoint: (id: string, phase: 'request' | 'response') => void;
}

/**
 * Builds the breakpoint-resume feature's store: exchanges currently paused
 * by a `breakpoint` rule, and the commands to resume (optionally edited) or
 * abort them.
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `features/breakpoint-resume/index.ts`, which wires the app's real
 * singleton.
 */
export function createBreakpointResumeStore(connection: DashboardConnection) {
  return create<BreakpointResumeState>((set) => {
    connection.onMessage((message) => {
      switch (message.type) {
        case 'breakpoint':
          set((state) => ({
            pausedBreakpoints: { ...state.pausedBreakpoints, [message.payload.id]: message.payload },
          }));
          return;
        case 'request':
        case 'response':
          // A request/response update for a paused id means it just resumed
          // (or was aborted) — from this tab or another.
          set((state) => {
            if (!(message.exchange.id in state.pausedBreakpoints)) return state;
            const pausedBreakpoints = { ...state.pausedBreakpoints };
            delete pausedBreakpoints[message.exchange.id];
            return { pausedBreakpoints };
          });
          return;
        default:
          return;
      }
    });

    return {
      pausedBreakpoints: {},
      resumeBreakpointRequest: (id, edits) =>
        connection.send({ type: 'breakpointResume', command: { id, phase: 'request', action: 'resume', edits } }),
      resumeBreakpointResponse: (id, edits) =>
        connection.send({ type: 'breakpointResume', command: { id, phase: 'response', action: 'resume', edits } }),
      abortBreakpoint: (id, phase) =>
        connection.send({ type: 'breakpointResume', command: { id, phase, action: 'abort' } }),
    };
  });
}
