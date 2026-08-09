import { memo } from 'react';
import type { OfficeAgentView } from '#/office/useOfficeAgents';

/**
 * HTML overlay layer that floats above the Pixi canvas, showing each seated
 * agent's real identity (kimi agent id / subagent type) and live status —
 * things the vendored Spine avatars can't render themselves.
 *
 * Positioning mirrors the scene's `fitStage`: the 960×640 logical space is
 * scaled by `min(containerW/960, containerH/640)` and centered, so the same
 * transform reproduces each agent's on-screen position from its logical x/y.
 */
export interface AgentOverlayProps {
  agents: OfficeAgentView[];
  containerWidth: number;
  containerHeight: number;
}

const STATE_COLOR: Record<string, string> = {
  idle: 'var(--color-text-foreground-muted, #888)',
  working: 'var(--color-accent, #4a90d9)',
  thinking: 'var(--color-warning, #f5c542)',
  talking: 'var(--color-success, #4ecdc4)',
  walking: 'var(--color-text-foreground-muted, #888)',
};

const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  working: '工作中',
  thinking: '思考中',
  talking: '交流中',
  walking: '移动中',
};

function AgentTagImpl({
  agent,
  left,
  top,
}: {
  agent: OfficeAgentView;
  left: number;
  top: number;
}) {
  const color = STATE_COLOR[agent.state] ?? STATE_COLOR['idle'];
  return (
    <div
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-full"
      style={{ left, top: top - 12 }}
    >
      <div className="flex flex-col items-center gap-0.5">
        {agent.agentId !== null && (
          <div
            className="max-w-[140px] truncate rounded-md border border-[var(--color-border-light,#333)] bg-[var(--color-background-panel,#1e1e1e)]/90 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-foreground,#eee)] shadow-sm backdrop-blur-sm"
            title={agent.agentId}
          >
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="truncate">{agent.label}</span>
              {agent.overflow && (
                <span className="text-[9px] opacity-60">+</span>
              )}
            </span>
            {agent.task && (
              <div className="mt-0.5 truncate text-[9px] opacity-70">
                {agent.task}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const AgentTag = memo(AgentTagImpl);

export function AgentOverlay({
  agents,
  containerWidth,
  containerHeight,
}: AgentOverlayProps) {
  // Mirror the scene's fitStage transform (960×640 logical → container).
  const scale = Math.min(containerWidth / 960, containerHeight / 640);
  const offsetX = (containerWidth - 960 * scale) / 2;
  const offsetY = (containerHeight - 640 * scale) / 2;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {agents.map((agent) => {
        const left = offsetX + agent.x * scale;
        const top = offsetY + agent.y * scale;
        return (
          <AgentTag key={agent.rosterNo} agent={agent} left={left} top={top} />
        );
      })}
      {agents.length > 0 ? (
        <div className="absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-foreground-muted,#888)]">
          {(['working', 'thinking', 'talking', 'idle'] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: STATE_COLOR[s] }}
              />
              {STATE_LABEL[s]}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
