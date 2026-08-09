import { useEffect, useState } from 'react';
import type {
  AgentPhase,
  AgentStatusUpdatedEvent,
  SnapshotSubagent,
} from '@moonshot-ai/protocol';
import {
  subagentCompletedEventSchema,
  subagentFailedEventSchema,
  subagentSpawnedEventSchema,
  subagentStartedEventSchema,
  subagentSuspendedEventSchema,
} from '@moonshot-ai/protocol';
import type { AgentDescriptor, TodoItem } from '@moonshot-ai/transcript';

import { useConnection } from '#/lib/connection';
import {
  createActivitySocket,
  type ActivitySocket,
  type ServerFrame,
} from '#/lib/ws';
import {
  classifyAgent,
  collaborationMode,
  mapOfficePhase,
  officialIdentity,
} from '#/office/officeModel';
import type {
  OfficeActivity,
  OfficeAgentState,
  OfficeAgentView,
  OfficeDashboard,
  OfficeMilestone,
} from '#/office/types';

const EMPTY_DASHBOARD: OfficeDashboard = {
  connected: false,
  title: '选择会话以升堂议事',
  phaseName: '待升堂',
  collaborationMode: 'single',
  agents: [],
  milestones: [],
};

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type MutableOfficeAgent = Omit<Mutable<OfficeAgentView>, 'activities'> & {
  activities: OfficeActivity[];
};

function activity(text: string, tone?: OfficeActivity['tone']): OfficeActivity {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: Date.now(),
    text,
    tone,
  };
}

function labelForDescriptor(descriptor: AgentDescriptor): string {
  if (descriptor.agentId === 'main') return '主理官';
  return descriptor.label ?? descriptor.agentId;
}

function phaseFromSnapshot(subagent: SnapshotSubagent): {
  state: OfficeAgentState;
  task: string;
} {
  switch (subagent.subagent_phase) {
    case 'working':
      return { state: 'work', task: subagent.description || '正在办事' };
    case 'queued':
      return { state: 'think', task: subagent.description || '候命筹谋' };
    case 'suspended':
      return { state: 'review', task: subagent.suspended_reason ?? '候旨批复' };
    case 'completed':
      return { state: 'done', task: subagent.description || '交旨完毕' };
    case 'failed':
      return { state: 'failed', task: subagent.description || '办事未成' };
    default:
      return subagent.status === 'running'
        ? { state: 'work', task: subagent.description || '正在办事' }
        : { state: 'idle', task: subagent.description || '候令' };
  }
}

function projectMilestones(items: readonly TodoItem[]): OfficeMilestone[] {
  return items.slice(0, 7).map((item) => ({
    title: item.title,
    status: item.status,
  }));
}

export function useOfficeAgents(sessionId: string | null): OfficeDashboard {
  const { api, baseUrl, token } = useConnection();
  const [dashboard, setDashboard] = useState<OfficeDashboard>(EMPTY_DASHBOARD);

  useEffect(() => {
    if (sessionId === null) {
      setDashboard(EMPTY_DASHBOARD);
      return;
    }

    let disposed = false;
    let socket: ActivitySocket | null = null;
    let connected = false;
    let title = '未题名会话';
    let goalObjective = '';
    let swarmMode = false;
    let todos: TodoItem[] = [];
    const agents = new Map<string, MutableOfficeAgent>();

    const ensureAgent = (options: {
      agentId: string;
      label?: string;
      parentAgentId?: string;
      swarmIndex?: number;
      runInBackground?: boolean;
      model?: string;
      thinkingEffort?: string;
      startedAt?: number;
    }): MutableOfficeAgent => {
      const current = agents.get(options.agentId);
      const label = options.label ?? current?.label ?? options.agentId;
      const parentAgentId = options.parentAgentId ?? current?.parentAgentId;
      const swarmIndex = options.swarmIndex ?? current?.swarmIndex;
      const runInBackground =
        options.runInBackground ?? current?.runInBackground ?? false;
      const kind = classifyAgent({
        agentId: options.agentId,
        label,
        parentAgentId,
        swarmIndex,
        runInBackground,
      });
      const identity = officialIdentity(options.agentId, kind, swarmIndex);
      const next: MutableOfficeAgent = {
        agentId: options.agentId,
        label,
        officialTitle: identity.title,
        department: identity.department,
        color: identity.color,
        state: current?.state ?? 'idle',
        task: current?.task ?? '候令',
        kind,
        parentAgentId,
        swarmIndex,
        runInBackground,
        model: options.model ?? current?.model,
        thinkingEffort: options.thinkingEffort ?? current?.thinkingEffort,
        startedAt: options.startedAt ?? current?.startedAt,
        completedAt: current?.completedAt,
        sent: current?.sent ?? 0,
        received: current?.received ?? 0,
        activities: current?.activities ?? [],
      };
      agents.set(options.agentId, next);
      return next;
    };

    const addActivity = (
      agent: MutableOfficeAgent,
      text: string,
      tone?: OfficeActivity['tone'],
    ): void => {
      agent.activities = [activity(text, tone), ...agent.activities].slice(0, 30);
    };

    const emit = (): void => {
      if (disposed) return;
      const projected = [...agents.values()].sort((left, right) => {
        if (left.agentId === 'main') return -1;
        if (right.agentId === 'main') return 1;
        const leftDone = left.state === 'done' || left.state === 'failed';
        const rightDone = right.state === 'done' || right.state === 'failed';
        if (leftDone !== rightDone) return leftDone ? 1 : -1;
        return (left.startedAt ?? 0) - (right.startedAt ?? 0);
      });
      const active = projected.filter(
        (agent) => agent.state !== 'done' && agent.state !== 'failed',
      );
      const fallbackMilestones: OfficeMilestone[] = [
        { title: '主理官领旨', status: 'done' },
        {
          title: '分派诸司协办',
          status: projected.length > 1 ? 'done' : 'pending',
        },
        {
          title: '各司并行办差',
          status: active.some((agent) => agent.state === 'work')
            ? 'in_progress'
            : projected.some((agent) => agent.state === 'done')
              ? 'done'
              : 'pending',
        },
        {
          title: '门下复核交旨',
          status:
            projected.length > 0 &&
            projected.every(
              (agent) => agent.state === 'done' || agent.state === 'idle',
            )
              ? 'done'
              : projected.some((agent) => agent.state === 'review')
                ? 'in_progress'
                : 'pending',
        },
      ];
      const milestones = projectMilestones(todos);
      setDashboard({
        connected,
        title: goalObjective || title,
        phaseName:
          active.some((agent) => agent.state === 'review')
            ? '门下封驳复核'
            : active.some((agent) => agent.state === 'work')
              ? '诸司并行办差'
              : active.some((agent) => agent.state === 'think')
                ? '中书筹谋分派'
                : projected.some((agent) => agent.state === 'done')
                  ? '交旨归档'
                  : '待升堂',
        collaborationMode: collaborationMode(projected, swarmMode),
        agents: projected,
        milestones: milestones.length > 0 ? milestones : fallbackMilestones,
      });
    };

    const applyPhase = (agentId: string, phase: AgentPhase | undefined): void => {
      const agent = ensureAgent({ agentId });
      const mapped = mapOfficePhase(phase);
      agent.state = mapped.state;
      if (mapped.task !== '候令' || agent.task === '') agent.task = mapped.task;
      addActivity(agent, `${mapped.task}`, mapped.state === 'failed' ? 'danger' : undefined);
      if (mapped.state === 'done' || mapped.state === 'failed') {
        agent.completedAt = Date.now();
      }
      emit();
    };

    const seed = async (): Promise<void> => {
      const [snapshotResult, transcriptResult, goalResult, statusResult] =
        await Promise.allSettled([
          api.getSnapshot(sessionId),
          api.transcriptPage(sessionId, 'main', { pageSize: 1 }),
          api.getGoal(sessionId),
          api.getSessionStatus(sessionId),
        ]);
      if (disposed) return;

      const main = ensureAgent({ agentId: 'main', label: '主理官' });
      if (snapshotResult.status === 'fulfilled') {
        const snapshot = snapshotResult.value;
        title = snapshot.session.title || title;
        main.state = snapshot.in_flight_turn === null ? 'idle' : 'work';
        main.task = snapshot.in_flight_turn === null ? '候令' : '生成回复';
        for (const subagent of snapshot.subagents ?? []) {
          const agent = ensureAgent({
            agentId: subagent.id,
            label: subagent.subagent_type,
            swarmIndex: subagent.swarm_index,
            runInBackground: subagent.run_in_background,
            model: subagent.model,
            thinkingEffort: subagent.thinking_effort,
            startedAt: Date.parse(subagent.started_at ?? subagent.created_at),
          });
          Object.assign(agent, phaseFromSnapshot(subagent));
        }
      }

      if (transcriptResult.status === 'fulfilled') {
        const transcript = transcriptResult.value;
        todos = transcript.todos.flatMap((todo) => todo.items);
        swarmMode = transcript.meta.modes?.swarm !== undefined;
        for (const descriptor of transcript.agents) {
          ensureAgent({
            agentId: descriptor.agentId,
            label: labelForDescriptor(descriptor),
            parentAgentId: descriptor.parentAgentId,
            startedAt:
              descriptor.createdAt === undefined
                ? undefined
                : Date.parse(descriptor.createdAt),
          });
        }
      }
      if (goalResult.status === 'fulfilled' && goalResult.value !== null) {
        goalObjective = goalResult.value.objective;
      }
      if (statusResult.status === 'fulfilled') {
        swarmMode ||= statusResult.value.swarm_mode;
        main.model = statusResult.value.model;
        main.thinkingEffort = statusResult.value.thinking_level;
        if (statusResult.value.busy && main.state === 'idle') {
          main.state = 'work';
          main.task = '统筹诸司';
        }
      }
      connected = true;
      emit();
    };

    socket = createActivitySocket({
      url: baseUrl,
      token,
      followSessionId: sessionId,
      handlers: {
        onWorkChanged: () => {},
        onSessionCreated: () => {},
        onMetaUpdated: () => {
          void seed();
        },
        onConfigChanged: () => {},
        onStatusUpdated: (_sid, event: AgentStatusUpdatedEvent) => {
          const payload = event as AgentStatusUpdatedEvent & { agentId?: string };
          swarmMode = event.swarmMode ?? swarmMode;
          const agent = ensureAgent({
            agentId: payload.agentId ?? 'main',
            model: event.model,
            thinkingEffort: event.thinkingEffort,
          });
          void agent;
          applyPhase(payload.agentId ?? 'main', event.phase);
        },
        onGoalUpdated: (_sid, snapshot) => {
          goalObjective = snapshot?.objective ?? '';
          emit();
        },
        onReconnected: () => {
          connected = true;
          void seed();
        },
        onRawFrame: (frame: ServerFrame) => {
          const payload = frame.payload as Record<string, unknown> | undefined;
          if (payload === undefined) return;
          switch (frame.type) {
            case 'subagent.spawned': {
              const parsed = subagentSpawnedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              const data = parsed.data;
              const parentAgentId = data.callerAgentId ?? data.parentAgentId ?? 'main';
              const agent = ensureAgent({
                agentId: data.subagentId,
                label: data.subagentName,
                parentAgentId,
                swarmIndex: data.swarmIndex,
                runInBackground: data.runInBackground,
                model: data.model,
                thinkingEffort: data.thinkingEffort,
                startedAt: Date.now(),
              });
              agent.state = 'think';
              agent.task = data.description ?? '领受差事';
              addActivity(agent, `受命：${agent.task}`);
              const parent = agents.get(parentAgentId);
              if (parent !== undefined) {
                parent.sent += 1;
                addActivity(parent, `行文给 ${agent.label}：${agent.task}`);
                agent.received += 1;
              }
              emit();
              return;
            }
            case 'subagent.started': {
              const parsed = subagentStartedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              const agent = ensureAgent({ agentId: parsed.data.subagentId });
              agent.state = 'work';
              if (agent.task === '候令') agent.task = '开始办差';
              addActivity(agent, '开衙办差');
              emit();
              return;
            }
            case 'subagent.suspended': {
              const parsed = subagentSuspendedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              const agent = ensureAgent({ agentId: parsed.data.subagentId });
              agent.state = 'review';
              agent.task = parsed.data.reason || '候旨批复';
              addActivity(agent, `暂驻复核：${agent.task}`);
              emit();
              return;
            }
            case 'subagent.completed': {
              const parsed = subagentCompletedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              const agent = ensureAgent({ agentId: parsed.data.subagentId });
              agent.state = 'done';
              agent.task = parsed.data.resultSummary || '交旨完毕';
              agent.completedAt = Date.now();
              addActivity(agent, `交旨：${agent.task}`, 'success');
              const parent = agents.get(agent.parentAgentId ?? 'main');
              if (parent !== undefined) {
                parent.received += 1;
                addActivity(parent, `收到 ${agent.label} 回文`);
                agent.sent += 1;
              }
              emit();
              return;
            }
            case 'subagent.failed': {
              const parsed = subagentFailedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              const agent = ensureAgent({ agentId: parsed.data.subagentId });
              agent.state = 'failed';
              agent.task = parsed.data.error;
              agent.completedAt = Date.now();
              addActivity(agent, `驳回：${parsed.data.error}`, 'danger');
              emit();
              return;
            }
            default:
              return;
          }
        },
      },
    });
    void seed();

    return () => {
      disposed = true;
      socket?.close();
      socket = null;
    };
  }, [api, baseUrl, sessionId, token]);

  return dashboard;
}
