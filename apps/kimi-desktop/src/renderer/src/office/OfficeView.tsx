import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Radio, UsersThree } from '@phosphor-icons/react';

import roomAsset from '#/office/assets/liubu-room.svg';
import officialBlue from '#/office/assets/official-blue.svg?no-inline';
import officialGreen from '#/office/assets/official-green.svg?no-inline';
import officialOrange from '#/office/assets/official-orange.svg?no-inline';
import officialPink from '#/office/assets/official-pink.svg?no-inline';
import officialPurple from '#/office/assets/official-purple.svg?no-inline';
import officialRed from '#/office/assets/official-red.svg?no-inline';
import { MODE_LABEL, STATUS_LABEL } from '#/office/officeModel';
import type { OfficeAgentView, OfficeDashboard } from '#/office/types';
import { useOfficeAgents } from '#/office/useOfficeAgents';
import '#/office/office.css';

const DESK_POSITIONS = [
  { left: 20.8, top: 47.5 },
  { left: 50, top: 47.5 },
  { left: 79.2, top: 47.5 },
  { left: 20.8, top: 71.1 },
  { left: 50, top: 71.1 },
  { left: 79.2, top: 71.1 },
] as const;

const OVERFLOW_POSITIONS = [
  { left: 12, top: 86 },
  { left: 19, top: 88 },
  { left: 72, top: 87 },
  { left: 80, top: 89 },
  { left: 88, top: 86 },
] as const;

function positionFor(index: number): { left: number; top: number } {
  if (index < DESK_POSITIONS.length) return DESK_POSITIONS[index]!;
  const overflowIndex = index - DESK_POSITIONS.length;
  const position = OVERFLOW_POSITIONS[overflowIndex % OVERFLOW_POSITIONS.length]!;
  const row = Math.floor(overflowIndex / OVERFLOW_POSITIONS.length);
  return { left: position.left, top: position.top - row * 10 };
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function kindLabel(agent: OfficeAgentView): string {
  switch (agent.kind) {
    case 'main':
      return '主理';
    case 'expert':
      return '专家会审';
    case 'swarm':
      return `蜂群 #${(agent.swarmIndex ?? 0) + 1}`;
    case 'background':
      return '后台值房';
    case 'subagent':
      return '协办';
  }
}

function Official({ agent }: { agent: OfficeAgentView }) {
  const source =
    {
      '#c8352a': officialRed,
      '#2e9e5b': officialGreen,
      '#2f7fd0': officialBlue,
      '#8b5fc0': officialPurple,
      '#c2507a': officialPink,
      '#cf7a24': officialOrange,
    }[agent.color] ?? officialRed;
  return (
    <img
      src={source}
      alt=""
      aria-hidden="true"
      className="liubu-official"
      draggable={false}
    />
  );
}

export interface OfficeViewProps {
  readonly sessionId: string | null;
  readonly onOpenAgent?: (agentId: string) => void;
  readonly onClose?: () => void;
}

export interface OfficeDashboardViewProps extends OfficeViewProps {
  readonly dashboard: OfficeDashboard;
}

export function OfficeDashboardView({
  sessionId,
  onOpenAgent,
  onClose,
  dashboard,
}: OfficeDashboardViewProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedAgentId(null);
  }, [sessionId]);

  const selectedAgent = useMemo(
    () =>
      dashboard.agents.find((agent) => agent.agentId === selectedAgentId) ??
      null,
    [dashboard.agents, selectedAgentId],
  );
  const doneMilestones = dashboard.milestones.filter(
    (milestone) => milestone.status === 'done',
  ).length;
  const progress =
    dashboard.milestones.length === 0
      ? 0
      : Math.round((doneMilestones / dashboard.milestones.length) * 100);

  const selectAgent = (agentId: string): void => {
    setSelectedAgentId((current) => (current === agentId ? null : agentId));
  };

  return (
    <div className="liubu-office">
      <header className="liubu-topbar">
        <div className="liubu-brand">
          <span className="liubu-brand-badge">实时官署</span>
          <div>
            <h1>AI 三省六部</h1>
            <p>Agent 协作实录 · 会话协议实时投影</p>
          </div>
        </div>
        <div className="liubu-session-seal">
          <span>{MODE_LABEL[dashboard.collaborationMode]}</span>
          <strong>{dashboard.title}</strong>
        </div>
        <div className="liubu-header-actions">
          <span
            className={`liubu-live ${dashboard.connected ? 'is-connected' : ''}`}
          >
            <Radio size={14} weight="fill" />
            {dashboard.connected ? 'LIVE' : '连接中'}
          </span>
          {onClose === undefined ? null : (
            <button type="button" className="liubu-back" onClick={onClose}>
              <ArrowLeft size={15} weight="bold" />
              返回对话
            </button>
          )}
        </div>
        <div className="liubu-agent-chips" aria-label="百官名册">
          {dashboard.agents.map((agent) => (
            <button
              type="button"
              key={agent.agentId}
              className={`liubu-chip ${selectedAgentId === agent.agentId ? 'is-selected' : ''}`}
              aria-pressed={selectedAgentId === agent.agentId}
              onClick={() => selectAgent(agent.agentId)}
            >
              <span
                className="liubu-chip-face"
                style={{ backgroundColor: agent.color }}
              >
                {agent.officialTitle.at(0)}
              </span>
              <span className="liubu-chip-copy">
                <b>{agent.label}</b>
                <small>{kindLabel(agent)}</small>
              </span>
              <i data-state={agent.state} />
            </button>
          ))}
        </div>
      </header>

      <main className="liubu-main">
        <section className="liubu-stage-frame">
          <span className="liubu-stage-corner">皇城实录 · LIVE</span>
          <div className="liubu-stage-scale">
            <img src={roomAsset} className="liubu-room" alt="三省六部官署" />
            {dashboard.agents.map((agent, index) => {
              const position = positionFor(index);
              const overflow = index >= DESK_POSITIONS.length;
              return (
                <button
                  type="button"
                  key={agent.agentId}
                  className={`liubu-agent ${selectedAgentId === agent.agentId ? 'is-selected' : ''} ${overflow ? 'is-overflow' : ''}`}
                  style={{
                    left: `${position.left}%`,
                    top: `${position.top}%`,
                    zIndex: Math.round(position.top * 10),
                  }}
                  aria-label={`查看 ${agent.label} 的行迹`}
                  aria-pressed={selectedAgentId === agent.agentId}
                  onClick={() => selectAgent(agent.agentId)}
                >
                  <span className="liubu-agent-cap">
                    <span className="liubu-agent-cap-title">
                      <i data-state={agent.state} />
                      <b>{agent.label}</b>
                      <em>{STATUS_LABEL[agent.state]}</em>
                    </span>
                    <span className="liubu-agent-task">{agent.task}</span>
                  </span>
                  <span className="liubu-emote" data-state={agent.state}>
                    {agent.state === 'think'
                      ? '…'
                      : agent.state === 'review'
                        ? '？'
                        : agent.state === 'done'
                          ? '★'
                          : agent.state === 'failed'
                            ? '×'
                            : agent.state === 'work'
                              ? '！'
                              : ''}
                  </span>
                  <Official agent={agent} />
                </button>
              );
            })}
            {dashboard.agents.length === 0 ? (
              <div className="liubu-empty-stage">
                <UsersThree size={34} weight="duotone" />
                <b>{sessionId === null ? '请先选择一卷会话' : '正在召集百官'}</b>
                <span>代理开始工作后，将在官署中实时就位。</span>
              </div>
            ) : null}
          </div>
          <div className="liubu-legend">
            {(['think', 'work', 'review', 'done', 'idle'] as const).map(
              (state) => (
                <span key={state}>
                  <i data-state={state} />
                  {STATUS_LABEL[state]}
                </span>
              ),
            )}
            <span className="liubu-legend-hint">点官员可查看个人行迹</span>
          </div>
        </section>

        <aside className="liubu-side">
          <section className="liubu-panel">
            <header>
              政事堂 · 进度榜 <span>敕令</span>
            </header>
            <div className="liubu-board-body">
              <h2>{dashboard.phaseName}</h2>
              <ol className="liubu-milestones">
                {dashboard.milestones.map((milestone, index) => (
                  <li
                    key={`${milestone.title}-${index}`}
                    data-status={milestone.status}
                  >
                    <span>
                      {milestone.status === 'done' ? (
                        <Check size={12} weight="bold" />
                      ) : null}
                    </span>
                    {milestone.title}
                  </li>
                ))}
              </ol>
              <div className="liubu-progress" aria-label={`进度 ${progress}%`}>
                <i style={{ width: `${progress}%` }} />
              </div>
            </div>
          </section>

          <section className="liubu-panel liubu-agent-panel">
            <header>
              百官谱 <span>名册</span>
            </header>
            {selectedAgent === null ? (
              <div className="liubu-agent-empty">
                点击衙署中任意官员
                <br />
                查看状态、归属与行迹流水
              </div>
            ) : (
              <div className="liubu-agent-detail">
                <div className="liubu-agent-detail-head">
                  <span style={{ backgroundColor: selectedAgent.color }}>
                    {selectedAgent.officialTitle.at(0)}
                  </span>
                  <div>
                    <h3>{selectedAgent.label}</h3>
                    <p>
                      {selectedAgent.officialTitle} · {selectedAgent.department}
                    </p>
                  </div>
                </div>
                <div className="liubu-agent-badges">
                  <span>{kindLabel(selectedAgent)}</span>
                  <span>{STATUS_LABEL[selectedAgent.state]}</span>
                  {selectedAgent.parentAgentId === undefined ? null : (
                    <span>
                      上官：
                      {dashboard.agents.find(
                        (agent) => agent.agentId === selectedAgent.parentAgentId,
                      )?.label ?? selectedAgent.parentAgentId}
                    </span>
                  )}
                </div>
                <div className="liubu-agent-stats">
                  <div>
                    <b>{selectedAgent.sent}</b>
                    <span>发文</span>
                  </div>
                  <div>
                    <b>{selectedAgent.received}</b>
                    <span>收文</span>
                  </div>
                  <div>
                    <b>{selectedAgent.activities.length}</b>
                    <span>行迹</span>
                  </div>
                </div>
                <dl className="liubu-agent-meta">
                  <div>
                    <dt>差事</dt>
                    <dd>{selectedAgent.task}</dd>
                  </div>
                  {selectedAgent.model === undefined ? null : (
                    <div>
                      <dt>模型</dt>
                      <dd>{selectedAgent.model}</dd>
                    </div>
                  )}
                </dl>
                <ul className="liubu-activities">
                  {selectedAgent.activities.map((item) => (
                    <li key={item.id} data-tone={item.tone ?? 'normal'}>
                      <time>{formatTime(item.time)}</time>
                      <span>{item.text}</span>
                    </li>
                  ))}
                  {selectedAgent.activities.length === 0 ? (
                    <li>
                      <time>--:--</time>
                      <span>尚无新行迹，正在候令。</span>
                    </li>
                  ) : null}
                </ul>
                {selectedAgent.agentId !== 'main' &&
                onOpenAgent !== undefined ? (
                  <button
                    type="button"
                    className="liubu-open-chat"
                    onClick={() => onOpenAgent(selectedAgent.agentId)}
                  >
                    查看此官对话
                  </button>
                ) : null}
              </div>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}

export function OfficeView(props: OfficeViewProps) {
  const dashboard = useOfficeAgents(props.sessionId);
  return <OfficeDashboardView {...props} dashboard={dashboard} />;
}
