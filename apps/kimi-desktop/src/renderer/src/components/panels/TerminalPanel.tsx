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

import { Plus, X } from '@phosphor-icons/react';
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
  readonly dispose: () => void;
}

interface PendingTerminal {
  readonly term: Terminal;
  readonly container: HTMLDivElement;
  cancelled: boolean;
}

interface TerminalError {
  readonly message: string;
  readonly cwd?: string;
}

const RESIZE_THROTTLE_MS = 150;

/**
 * Key the stateful implementation here rather than relying on every parent to
 * remember to key the panel. A session switch must unmount the old PTY owner
 * before the new session can retain any of its state or callbacks.
 */
export function TerminalPanel({ sessionId }: TerminalPanelProps) {
  return <TerminalPanelSession key={sessionId} sessionId={sessionId} />;
}

function TerminalPanelSession({ sessionId }: TerminalPanelProps) {
  const { api } = useConnection();
  const close = useCloseTerminal(sessionId);
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState<TerminalError | null>(null);
  const [tabs, setTabs] = useState<readonly Tab[]>([]);
  const tabsRef = useRef<readonly Tab[]>([]);
  const pendingRef = useRef<PendingTerminal | null>(null);
  const mountedRef = useRef(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // The active tab's container is appended to the scroller; inactive tabs keep
  // their container detached (xterm stays alive but hidden).
  const activeTab = tabs.find((tab) => tab.terminalId === activeId) ?? null;

  const mountTab = useCallback(
    async (cwd?: string) => {
      if (pendingRef.current !== null) return;
      setCreating(true);
      // Provisionary container + terminal so xterm can determine its initial grid.
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

      const pending: PendingTerminal = { term, container, cancelled: false };
      pendingRef.current = pending;

      let handle: TerminalHandle;
      try {
        handle = await startTerminalSession({
          api,
          sessionId,
          cwd,
          initialCols: term.cols,
          initialRows: term.rows,
          onOutput: (data) => {
            if (!pending.cancelled) term.write(data);
          },
          onExit: (exitCode) => {
            if (pending.cancelled) return;
            term.write(`\r\n\x1b[90m[process exited${exitCode !== null && exitCode !== undefined ? ` code ${exitCode}` : ''}]\x1b[0m\r\n`);
          },
          onReady: () => {
            /* stream live */
          },
        });
      } catch (error) {
        if (!pending.cancelled && mountedRef.current) {
          term.dispose();
          container.remove();
          pendingRef.current = null;
          setCreationError({
            message: error instanceof Error ? error.message : String(error),
            cwd,
          });
          setCreating(false);
        }
        return;
      }

      // The REST create may finish after a session switch. Detach the socket
      // and close the now-unowned PTY against the session that created it.
      if (pending.cancelled || !mountedRef.current) {
        handle.stop();
        void api.closeTerminal(sessionId, handle.terminalId).catch(() => {
          // best-effort cleanup of a terminal that was never presented
        });
        return;
      }

      pendingRef.current = null;
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

      const tab: Tab = {
        terminalId: handle.terminalId,
        handle,
        term,
        fit,
        container,
        dispose: () => {
          pending.cancelled = true;
          inputData.dispose();
          resizeObserver.disconnect();
        },
      };
      const nextTabs = [...tabsRef.current, tab];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(tab.terminalId);
      setCreationError(null);
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
    [api, sessionId],
  );

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
      if (!tabsRef.current.includes(tab)) return;
      tab.dispose();
      tab.handle.stop();
      tab.term.dispose();
      tab.container.remove();
      const nextTabs = tabsRef.current.filter((entry) => entry !== tab);
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      if (activeId === tab.terminalId) {
        setActiveId(nextTabs.at(-1)?.terminalId ?? null);
      }
      void close.mutateAsync(tab.terminalId).catch(() => {
        // best-effort; the socket is already gone
      });
    },
    [close, activeId],
  );

  // Tear down every tab and an in-flight provisional terminal on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pending = pendingRef.current;
      if (pending !== null) {
        pending.cancelled = true;
        pending.term.dispose();
        pending.container.remove();
        pendingRef.current = null;
      }
      for (const tab of tabsRef.current) {
        tab.dispose();
        tab.handle.stop();
        tab.term.dispose();
        tab.container.remove();
        void api.closeTerminal(sessionId, tab.terminalId).catch(() => {
          // best-effort cleanup when the owning session is left
        });
      }
      tabsRef.current = [];
    };
  }, [api, sessionId]);

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

  // Re-skin every live xterm when the app theme flips (`data-theme` on <html>).
  useEffect(() => {
    const applyTheme = (): void => {
      const theme = terminalTheme();
      for (const tab of tabsRef.current) {
        tab.term.options.theme = theme;
      }
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border-light)] px-2.5 text-[var(--color-text-foreground)]">
        {tabs.length === 0 ? (
          <span className="px-1 text-[11px] text-[var(--color-text-tertiary)]">尚未打开终端</span>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.terminalId}
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${
                tab.terminalId === activeId
                  ? 'bg-[var(--color-list-active)] text-[var(--color-text-foreground)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]'
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
                className="rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ))
        )}
        <button
          type="button"
          onClick={() => void mountTab()}
          disabled={creating}
          title="新建终端"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>
      {creationError !== null ? (
        <div
          role="alert"
          className="mx-2 mt-2 flex shrink-0 items-start gap-3 rounded-md border border-[var(--color-border-error)] bg-[color-mix(in_srgb,var(--color-text-danger)_10%,transparent)] px-3 py-2 text-[11px] text-[var(--color-text-danger)]"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">无法创建或连接终端</div>
            <div className="mt-0.5 break-words text-[var(--color-text-secondary)]">{creationError.message}</div>
            <div className="mt-1 text-[var(--color-text-tertiary)]">请检查服务器连接，然后重试。</div>
          </div>
          <button
            type="button"
            onClick={() => void mountTab(creationError.cwd)}
            disabled={creating}
            className="shrink-0 rounded-md border border-[var(--color-border-error)] px-2 py-1 font-medium text-[var(--color-text-danger)] hover:bg-[color-mix(in_srgb,var(--color-text-danger)_10%,transparent)] disabled:opacity-40"
          >
            {creating ? '正在重试…' : '重试'}
          </button>
        </div>
      ) : null}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-hidden px-2 pb-2 pt-1" />
    </div>
  );
}

/**
 * Terminal theme read at runtime from the CSS design tokens so xterm follows
 * the app theme. The terminal shell stays dark in both themes
 * (`--color-terminal-shell` is dark in light mode too), so the foreground and
 * ANSI palette come from theme-stable named-palette tokens; the fallbacks
 * below only kick in if a token is missing.
 */
function terminalTheme(): Record<string, string> {
  const token = (name: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };
  return {
    background: token('--color-terminal-shell', '#171717'),
    foreground: token('--gray-0', '#ffffff'),
    cursor: token('--gray-0', '#ffffff'),
    cursorAccent: token('--color-terminal-shell', '#171717'),
    selectionBackground: 'rgba(255,255,255,0.16)', // no white-alpha token; terminal canvas is dark in both themes
    black: token('--gray-1000', '#000000'),
    red: token('--red-400', '#fa423e'),
    green: token('--green-400', '#04b84c'),
    yellow: token('--orange-400', '#fb6a22'),
    blue: token('--blue-300', '#339cff'),
    magenta: token('--purple-400', '#924ff7'),
    cyan: token('--blue-400', '#0285ff'),
    white: token('--gray-100', '#d0d0d0'),
    brightBlack: token('--gray-500', '#5d5d5d'),
    brightRed: token('--red-400', '#ff6a66'),
    brightGreen: token('--green-400', '#3ed473'),
    brightYellow: token('--orange-400', '#ff8c4d'),
    brightBlue: token('--blue-300', '#5ab2ff'),
    brightMagenta: token('--purple-400', '#b07cff'),
    brightCyan: token('--blue-400', '#4da3ff'),
    brightWhite: token('--gray-0', '#ffffff'),
  };
}
