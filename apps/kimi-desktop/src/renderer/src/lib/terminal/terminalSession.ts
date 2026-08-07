/**
 * TerminalSession — the lifecycle coordinator for one PTY: REST creates the
 * terminal record, the WS socket attaches and carries I/O.
 *
 * Flow:
 *  1. `start()` POSTs `.../terminals` to create the PTY (cwd relative to the
 *     session workspace), then opens a {@link TerminalSocket} carrying the
 *     owner's seq watermark so reconnects replay missed output.
 *  2. The owner (xterm.js) subscribes to output via the `onOutput` callback and
 *     forwards input/resize through `sendInput` / `sendResize`.
 *  3. `stop()` detaches and closes the socket; closing the PTY record is the
 *     owner's job (it owns the close button + react-query mutation).
 *
 * The session is transport-only: it never imports xterm. That keeps the I/O
 * logic unit-testable with a stub WebSocket.
 */

import type { ApiClient } from '../api';
import { createTerminalSocket, type TerminalSocket } from '../ws';

export interface TerminalSessionOptions {
  readonly api: ApiClient;
  readonly sessionId: string;
  /** PTY working directory, relative to the session workspace. */
  readonly cwd?: string;
  /** Optional shell override (resolved by the server when omitted). */
  readonly shell?: string;
  readonly initialCols?: number;
  readonly initialRows?: number;
  readonly onOutput: (data: string) => void;
  readonly onExit?: (exitCode: number | null | undefined) => void;
  readonly onReady?: () => void;
  /** WebSocket implementation override (tests). */
  readonly WebSocketImpl?: typeof WebSocket;
}

export interface TerminalHandle {
  readonly terminalId: string;
  /** Forward keyboard input to the PTY. No-op before the socket attaches. */
  sendInput: (data: string) => void;
  /** Resize the PTY (the owner should throttle). */
  sendResize: (cols: number, rows: number) => void;
  /** Tear the socket down permanently (does not close the PTY record). */
  stop: () => void;
}

/**
 * Create and attach one PTY. Resolves with a {@link TerminalHandle} once the
 * REST record exists (the socket attaches in the background and fires
 * `onReady`). Rejects on a create failure.
 */
export async function startTerminalSession(
  options: TerminalSessionOptions,
): Promise<TerminalHandle> {
  const terminal = await options.api.createTerminal(options.sessionId, {
    cwd: options.cwd,
    shell: options.shell,
    cols: options.initialCols,
    rows: options.initialRows,
  });
  let lastSeq: number | undefined;
  let socket: TerminalSocket | undefined = createTerminalSocket({
    url: options.api.baseUrl,
    token: options.api.token,
    sessionId: options.sessionId,
    terminalId: terminal.id,
    WebSocketImpl: options.WebSocketImpl,
    getSince: () => lastSeq,
    handlers: {
      onOutput: (data, seq) => {
        // The server sends strictly increasing seqs; track the watermark so a
        // reconnect replays from here. Legacy servers (no seq) keep undefined.
        if (seq > 0) lastSeq = seq;
        options.onOutput(data);
      },
      onExit: (exitCode) => options.onExit?.(exitCode),
      onAttached: () => {
        /* replay count informational only */
      },
      onReconnected: () => options.onReady?.(),
    },
  });

  return {
    terminalId: terminal.id,
    sendInput: (data) => socket?.sendInput(data),
    sendResize: (cols, rows) => socket?.sendResize(cols, rows),
    stop: () => {
      socket?.close();
      socket = undefined;
    },
  };
}
