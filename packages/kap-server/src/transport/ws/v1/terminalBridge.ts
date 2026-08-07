/**
 * `TerminalBridge` — `/api/v1/ws` control and PTY-frame adapter.
 *
 * The Session-scoped terminal service owns processes, replay buffers, and
 * sinks. This transport bridge only resolves the addressed live session,
 * adapts a WebSocket connection into a sink, and detaches it on disconnect.
 */

import {
  getLiveSessionById,
  ISessionTerminalService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { TerminalFrame } from '@moonshot-ai/agent-core-v2/os/interface/terminal';

export interface TerminalConnection {
  readonly id: string;
  sendTerminalFrame(frame: TerminalFrame): void;
}

interface Attachment {
  readonly sessionId: string;
  readonly terminalId: string;
}

export class TerminalBridge {
  private readonly attachments = new Map<string, Attachment[]>();

  constructor(private readonly core: Scope) {}

  async attach(
    conn: TerminalConnection,
    sessionId: string,
    terminalId: string,
    sinceSeq?: number,
  ): Promise<{ replayed: number }> {
    const terminal = this.resolve(sessionId);
    const result = await terminal.attach(
      terminalId,
      { id: conn.id, send: (frame) => conn.sendTerminalFrame(frame) },
      { sinceSeq },
    );
    const current = this.attachments.get(conn.id) ?? [];
    if (!current.some((entry) => entry.sessionId === sessionId && entry.terminalId === terminalId)) {
      current.push({ sessionId, terminalId });
      this.attachments.set(conn.id, current);
    }
    return result;
  }

  detach(conn: TerminalConnection, sessionId: string, terminalId: string): void {
    this.resolve(sessionId).detach(terminalId, conn.id);
    const next = (this.attachments.get(conn.id) ?? []).filter(
      (entry) => entry.sessionId !== sessionId || entry.terminalId !== terminalId,
    );
    if (next.length === 0) this.attachments.delete(conn.id);
    else this.attachments.set(conn.id, next);
  }

  write(sessionId: string, terminalId: string, data: string): Promise<void> {
    return this.resolve(sessionId).write(terminalId, data);
  }

  resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<void> {
    return this.resolve(sessionId).resize(terminalId, cols, rows);
  }

  close(sessionId: string, terminalId: string): Promise<{ closed: true }> {
    return this.resolve(sessionId).close(terminalId);
  }

  detachConnection(conn: TerminalConnection): void {
    for (const { sessionId, terminalId } of this.attachments.get(conn.id) ?? []) {
      const session = getLiveSessionById(this.core.accessor, sessionId);
      session?.accessor.get(ISessionTerminalService).detach(terminalId, conn.id);
    }
    this.attachments.delete(conn.id);
  }

  private resolve(sessionId: string): ISessionTerminalService {
    const session = getLiveSessionById(this.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} is not live`);
    return session.accessor.get(ISessionTerminalService);
  }
}
