import { useEffect, useRef, useState } from 'react';
// Pixi v8's WebGL renderer compiles shaders via `new Function(...)`, which the
// desktop CSP (`script-src 'self'`) forbids. This polyfill replaces those calls
// with a `Function`-free path so the renderer initialises under strict CSP.
import 'pixi.js/unsafe-eval';
import { OfficeScene } from '#/office/vendored/scene/OfficeScene';
import { getOfficeAgents } from '#/office/vendored/store/officeStore';
import { AgentOverlay } from '#/office/AgentOverlay';
import { useOfficeAgents } from '#/office/useOfficeAgents';

/**
 * The "AI office" view: a Pixi/Spine office scene that visualises the active
 * session's multi-agent collaboration in real time. The main agent occupies
 * desk 1; spawned subagents take desks 2–6 in arrival order, and task
 * handoffs play out as the caller walking over to the subagent's desk.
 *
 * The vendored scene is driven entirely through `officeSceneBridge` from
 * `useOfficeAgents`; this component only owns the canvas lifecycle and keeps
 * the HTML overlay's coordinates in sync with the scene.
 */
export function OfficeView({ sessionId }: { sessionId: string | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const { agents, connected } = useOfficeAgents(sessionId);
  // Local copy of agent positions, refreshed each animation frame.
  const [positions, setPositions] = useState(agents);

  // Mount the scene once per container. StrictMode mounts effects twice in
  // dev, so abort stale async initialization before it can attach a canvas.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    const controller = new AbortController();
    const scene = new OfficeScene();

    setError(null);
    setReady(false);

    void (async () => {
      try {
        await scene.init(
          container,
          container.clientWidth,
          container.clientHeight,
          controller.signal,
        );
      } catch (error) {
        scene.destroy();
        if (cancelled) return;
        setError(
          error instanceof Error
            ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
            : String(error),
        );
        return;
      }
      if (cancelled) {
        scene.destroy();
        return;
      }
      sceneRef.current = scene;
      setSize({ width: container.clientWidth, height: container.clientHeight });
      setReady(true);
    })();

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
      sceneRef.current?.resize(width, height);
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      controller.abort();
      resizeObserver.disconnect();
      if (sceneRef.current === scene) sceneRef.current = null;
      scene.destroy();
    };
  }, []);

  // Sync agent positions from the scene every frame for the overlay. We poll
  // the vendored store (the scene updates it each tick) at ~30fps to avoid a
  // per-frame React state churn.
  useEffect(() => {
    if (!ready || sceneRef.current === null) return;
    const interval = window.setInterval(() => {
      const live = getOfficeAgents();
      setPositions((prev) => {
        const byId = new Map(live.map((a) => [a.id, a]));
        let changed = false;
        const next = agents.map((agent) => {
          const src = byId.get(agent.sceneAgentId);
          if (src === undefined) return agent;
          if (
            src.x === agent.x &&
            src.y === agent.y &&
            src.state === agent.state
          )
            return agent;
          changed = true;
          return { ...agent, x: src.x, y: src.y, state: src.state };
        });
        return changed ? next : prev;
      });
    }, 100);
    return () => window.clearInterval(interval);
  }, [agents, ready]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[var(--color-background-surface)]">
      <div ref={containerRef} className="absolute inset-0" />
      {ready && sessionId !== null ? (
        <AgentOverlay
          agents={positions}
          containerWidth={size.width}
          containerHeight={size.height}
        />
      ) : null}
      {error !== null ? (
        <pre className="relative z-20 max-w-[680px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border-danger)] bg-[var(--color-background-panel)] p-4 text-xs text-[var(--color-text-danger)] shadow-[var(--shadow-lg)]">
          {'Office scene init failed:'}
          {'\n'}
          {error}
        </pre>
      ) : !ready ? (
        <div className="relative z-20 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-background-panel)]/90 px-4 py-3 text-sm text-[var(--color-text-secondary)] shadow-[var(--shadow-md)] backdrop-blur-sm">
          正在加载 AI 办公室…
        </div>
      ) : sessionId === null ? (
        <div className="relative z-20 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-background-panel)]/90 px-6 py-4 text-center text-sm text-[var(--color-text-secondary)] shadow-[var(--shadow-md)] backdrop-blur-sm">
          <p className="mb-1 text-base font-medium text-[var(--color-text-foreground,#eee)]">
            AI 办公室
          </p>
          <p>选择一个会话，实时查看多智能体协作动态。</p>
        </div>
      ) : !connected ? (
        <div className="absolute right-3 top-3 z-20 rounded-md bg-[var(--color-background-panel)]/80 px-2 py-1 text-[10px] text-[var(--color-text-tertiary)] backdrop-blur-sm">
          正在连接…
        </div>
      ) : null}
    </div>
  );
}
