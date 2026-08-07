/**
 * TerminalPanel — the bottom-dock PTY host (xterm.js over the terminal WS).
 *
 * One tab per PTY: the "+" button creates a terminal (REST `POST .../terminals`
 * at the session workspace root, default shell), each tab attaches a
 * {@link startTerminalSession} that owns its WS socket. xterm forwards input
 * via `onData`, output writes to the terminal, and a FitAddon + resize throttle
 * keeps the PTY grid in sync with the element size. Closing a tab stops the
 * socket and POSTs `:close`.
 *
 * The CSS (`@xterm/xterm/css/xterm.css`) is imported once at module load;
 * colors follow the design tokens via the terminal theme option.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useConnection } from '#/lib/connection';
import { useCloseTerminal } from '#/lib/queries';
import { startTerminalSession, type TerminalHandle } from '#/lib/terminal/terminalSession';

export interface TerminalPanelProps {
  readonly sessionId: string;
}

interface Tab {
  readonly terminalId: string;
  readonly handle: TerminalHandle;
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly container: HTMLDivElement;
}

const RESIZE_THROTTLE_MS = 150;

export function TerminalPanel({ sessionId }: TerminalPanelProps) {
  const { api } = useConnection();
  const close = useCloseTerminal(sessionId);
  const [creating, setCreating] = useState(false);
  const [tabs, setTabs] = useState<readonly Tab[]>([]);
  const tabsRef = useRef<readonly Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // The active tab's container is appended to the scroller; inactive tabs keep
  // their container detached (xterm stays alive but hidden).
  const activeTab = tabs.find((tab) => tab.terminalId === activeId) ?? null;

  const mountTab = useCallback(
    async (cwd?: string) => {
      if (creating) return;
      setCreating(true);
      // Provisionary container + terminal so the tab exists before REST resolves.
      const container = document.createElement('div');
      container.style.height = '100%';
      container.style.width = '100%';
      const term = new Terminal({
        fontFamily:
          "ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas, monospace",
        fontSize: 12.5,
        cursorBlink: true,
        allowProposedApi: true,
        theme: terminalTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      try {
        fit.fit();
      } catch {
        // fit before paint can throw on a 0-size container — safe to ignore.
      }

      let handle: TerminalHandle;
      try {
        handle = await startTerminalSession({
          api,
          sessionId,
          cwd,
          initialCols: term.cols,
          initialRows: term.rows,
          onOutput: (data) => term.write(data),
          onExit: (exitCode) => {
            term.write(`\r\n\x1b[90m[process exited${exitCode !== null && exitCode !== undefined ? ` code ${exitCode}` : ''}]\x1b[0m\r\n`);
          },
          onReady: () => {
            /* stream live */
          },
        });
      } catch (error) {
        term.write(`\x1b[31m无法创建终端：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
        term.dispose();
        container.remove();
        setCreating(false);
        return;
      }
      // Forward keyboard input; resize is throttled below.
      const inputData = term.onData((data) => handle.sendInput(data));
      const resizeObserver = new ResizeObserver(() => {
        const last = container.dataset['lastResize'] ?? '0';
        if (Date.now() - Number(last) < RESIZE_THROTTLE_MS) return;
        container.dataset['lastResize'] = String(Date.now());
        try {
          fit.fit();
          handle.sendResize(term.cols, term.rows);
        } catch {
          // ignore fit failures during teardown
        }
      });
      resizeObserver.observe(container);

      const tab: Tab = { terminalId: handle.terminalId, handle, term, fit, container };
      // Tear-down wiring kept on the handle so closeTab can find everything.
      (tab as Tab & { dispose?: () => void }).dispose = () => {
        inputData.dispose();
        resizeObserver.disconnect();
      };
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.terminalId);
      // Append once state settles (effect below moves containers).
      scrollerRef.current?.appendChild(container);
      requestAnimationFrame(() => {
        try {
          fit.fit();
          handle.sendResize(term.cols, term.rows);
        } catch {
          // ignore
        }
      });
      setCreating(false);
    },
    [api, sessionId, creating],
  );

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Keep only the active tab's container attached; detach the rest.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    for (const tab of tabs) {
      if (tab.container.parentElement === scroller && tab.terminalId !== activeId) {
        scroller.removeChild(tab.container);
      } else if (tab.terminalId === activeId && tab.container.parentElement !== scroller) {
        scroller.appendChild(tab.container);
      }
    }
  }, [tabs, activeId]);

  const closeTab = useCallback(
    (tab: Tab) => {
      (tab as Tab & { dispose?: () => void }).dispose?.();
      tab.handle.stop();
      tab.term.dispose();
      tab.container.remove();
      setTabs((prev) => {
        const next = prev.filter((entry) => entry.terminalId !== tab.terminalId);
        if (activeId === tab.terminalId) {
          setActiveId(next.at(-1)?.terminalId ?? null);
        }
        return next;
      });
      void close.mutateAsync(tab.terminalId).catch(() => {
        // best-effort; the socket is already gone
      });
    },
    [close, activeId],
  );

  // Tear down every tab on unmount.
  useEffect(() => {
    return () => {
      for (const tab of tabsRef.current) {
        (tab as Tab & { dispose?: () => void }).dispose?.();
        tab.handle.stop();
        tab.term.dispose();
        tab.container.remove();
      }
    };
  }, []);

  // Refit the active tab when it becomes visible.
  useEffect(() => {
    if (activeTab === null) return;
    const timer = window.setTimeout(() => {
      try {
        activeTab.fit.fit();
        activeTab.handle.sendResize(activeTab.term.cols, activeTab.term.rows);
      } catch {
        // ignore
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTab]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/8 px-2.5 text-white">
        {tabs.length === 0 ? (
          <span className="px-1 text-[11px] text-white/40">尚未打开终端</span>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.terminalId}
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${
                tab.terminalId === activeId
                  ? 'bg-white/10 text-white'
                  : 'text-white/55 hover:bg-white/8'
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveId(tab.terminalId)}
                className="font-mono"
              >
                {tab.terminalId.slice(0, 8)}
              </button>
              <button
                type="button"
                aria-label="关闭终端"
                title="关闭终端"
                onClick={() => closeTab(tab)}
                className="rounded p-0.5 text-white/35 hover:bg-white/8 hover:text-white"
              >
                ✕
              </button>
            </div>
          ))
        )}
        <button
          type="button"
          onClick={() => void mountTab()}
          disabled={creating}
          title="新建终端"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[13px] text-white/55 hover:bg-white/8 hover:text-white disabled:opacity-40"
        >
          ＋
        </button>
      </div>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-hidden px-2 pb-2 pt-1" />
    </div>
  );
}

/** Dark-on-dark terminal theme aligned with the design tokens. */
function terminalTheme(): Record<string, string> {
  return {
    background: '#171717',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#171717',
    selectionBackground: 'rgba(255,255,255,0.16)',
    black: '#000000',
    red: '#fa423e',
    green: '#04b84c',
    yellow: '#fb6a22',
    blue: '#339cff',
    magenta: '#924ff7',
    cyan: '#0285ff',
    white: '#d0d0d0',
    brightBlack: '#5d5d5d',
    brightRed: '#ff6a66',
    brightGreen: '#3ed473',
    brightYellow: '#ff8c4d',
    brightBlue: '#5ab2ff',
    brightMagenta: '#b07cff',
    brightCyan: '#4da3ff',
    brightWhite: '#ffffff',
  };
}
