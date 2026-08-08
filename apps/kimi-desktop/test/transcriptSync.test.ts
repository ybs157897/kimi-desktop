import { describe, expect, it, vi } from 'vitest';

import type { ApiClient, TranscriptPage } from '../src/renderer/src/lib/api';
import { TranscriptChatStore } from '../src/renderer/src/lib/transcript/chatStore';
import { TranscriptSync } from '../src/renderer/src/lib/transcriptSync';

class SilentWebSocket {
  static readonly OPEN = 1;

  readonly readyState = SilentWebSocket.OPEN;

  addEventListener(): void {}
  close(): void {}
  send(): void {}
}

function page(activity: 'turn' | 'idle', seq: number): TranscriptPage {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    meta: { activity },
    pendingInteractions: [],
    hasMoreOlder: false,
    seq,
  };
}

describe('TranscriptSync lifecycle', () => {
  it('refreshes a cached channel when restarted after a session switch', async () => {
    const transcriptPage = vi
      .fn<ApiClient['transcriptPage']>()
      .mockResolvedValueOnce(page('turn', 1))
      .mockResolvedValueOnce(page('idle', 2));
    const api = {
      baseUrl: 'http://127.0.0.1:1234',
      token: undefined,
      transcriptPage,
    } as unknown as ApiClient;
    const store = new TranscriptChatStore();
    const sync = new TranscriptSync({
      api,
      sessionId: 'session-example',
      agentId: 'main',
      store,
      WebSocketImpl: SilentWebSocket as unknown as typeof WebSocket,
    });

    sync.start();
    await vi.waitFor(() => expect(store.getState().meta.activity).toBe('turn'));
    sync.stop();

    sync.start();
    await vi.waitFor(() => expect(store.getState().meta.activity).toBe('idle'));
    expect(transcriptPage).toHaveBeenCalledTimes(2);

    sync.stop();
  });
});
