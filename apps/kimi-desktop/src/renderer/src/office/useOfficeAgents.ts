import { useEffect, useRef, useState } from 'react';
import type {
  AgentPhase,
  AgentStatusUpdatedEvent,
} from '@moonshot-ai/protocol';
import {
  subagentCompletedEventSchema,
  subagentFailedEventSchema,
  subagentSpawnedEventSchema,
  subagentStartedEventSchema,
  subagentSuspendedEventSchema,
  taskStartedEventSchema,
} from '@moonshot-ai/protocol';

import {
  createActivitySocket,
  type ActivitySocket,
  type ServerFrame,
} from '#/lib/ws';
import { useConnection } from '#/lib/connection';
import { AGENT_ROSTER } from '#/office/vendored/scene/layout/officeLayout';
import {
  setAgentPresence,
  setAgentState,
} from '#/office/vendored/scene/officeSceneBridge';
import { submitVisitAction } from '#/office/vendored/services/officeActionDispatcher';
import type { AgentState } from '#/office/vendored/types/agent';
import {
  createRosterAllocator,
  type RosterSlot,
} from '#/office/rosterAllocator';
import { isLiveAgentPhase, mapAgentPhase } from '#/office/phaseMap';

/**
 * Live view of the agents occupying the office, surfaced to the overlay.
 * Coordinates (`x`/`y`) are in the scene's 960×640 logical space and are
 * refreshed every animation frame by the OfficeView via `syncPositions`.
 */
export interface OfficeAgentView {
  rosterNo: number;
  /** Vendored scene agent id (marvis/code-agent/…) used to drive the avatar. */
  sceneAgentId: string;
  /** Real kimi-desktop agent id (main / agent-<N>), null for empty desks. */
  agentId: string | null;
  label: string;
  state: AgentState;
  task: string;
  /** Live scene coordinates (logical 960×640), kept in sync by the view. */
  x: number;
  y: number;
  overflow: boolean;
}

/**
 * Bridge between the kap-server event stream and the vendored office scene.
 *
 * Owns its own `ActivitySocket` (independent of `useGlobalActivitySocket`) and
 * drives the scene purely through the `officeSceneBridge` entry points, so no
 * vendored file is modified. Responsibilities:
 *
 * - Maintain the kimi-agent → roster-slot mapping (`rosterAllocator`).
 * - Seed the scene from `GET /sessions/:id/snapshot` on (re)connect.
 * - Translate `agent.status.updated` phases into scene states + overlay text.
 * - Animate task handoffs: on `subagent.spawned` the caller walks over to the
 *   new subagent's desk (a desk-visit), surfacing the handoff visually.
 *
 * The scene bridge buffers actions until `OfficeScene.init()` finishes, so the
 * hook can fire events before the canvas is mounted without losing them.
 */
export function useOfficeAgents(sessionId: string | null): {
  agents: OfficeAgentView[];
  connected: boolean;
} {
  const { api, baseUrl, token } = useConnection();
  const [agents, setAgents] = useState<OfficeAgentView[]>([]);
  const [connected, setConnected] = useState(false);

  // Allocator lives across renders; reset it on session change.
  const allocatorRef = useRef(createRosterAllocator());
  // Per-agent phase/task, keyed by kimi agent id (drives the overlay).
  const phaseRef = useRef<Map<string, { state: AgentState; task: string }>>(
    new Map(),
  );
  const activeAgentIdsRef = useRef<Set<string>>(new Set());
  // Per-agent live scene coordinates, keyed by scene agent id.
  const coordsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // The roster slot → vendored scene agent id mapping is fixed (AGENT_ROSTER
  // order). Slot 1 = marvis, 2 = code-agent, … 6 = data-agent.
  const sceneAgentIdByRosterNo = (n: number): string => {
    const entry = AGENT_ROSTER[n - 1];
    return entry?.id ?? AGENT_ROSTER[0]!.id;
  };

  // Rebuild the overlay snapshot from the current refs.
  function snapshot(): OfficeAgentView[] {
    const slots: RosterSlot[] = allocatorRef.current.slots();
    return slots
      .filter((slot) => activeAgentIdsRef.current.has(slot.agentId))
      .map((slot) => {
        const sceneAgentId = sceneAgentIdByRosterNo(slot.rosterNo);
        const phase =
          slot.agentId !== null
            ? phaseRef.current.get(slot.agentId)
            : undefined;
        const coords = coordsRef.current.get(sceneAgentId);
        return {
          rosterNo: slot.rosterNo,
          sceneAgentId,
          agentId: slot.agentId,
          label: slot.label,
          state: phase?.state ?? 'idle',
          task: phase?.task ?? '',
          x: coords?.x ?? 0,
          y: coords?.y ?? 0,
          overflow: slot.overflow,
        };
      });
  }

  /** Push an agent's phase into the scene + overlay state. */
  function applyPhase(
    kimiAgentId: string,
    phase: AgentPhase | undefined,
  ): void {
    const mapped = mapAgentPhase(phase);
    const task = mapped.task || phaseRef.current.get(kimiAgentId)?.task || '';
    const state = mapped.state;
    phaseRef.current.set(kimiAgentId, { state, task });
    const active = isLiveAgentPhase(phase);
    let rosterNo = allocatorRef.current.rosterNoOf(kimiAgentId);
    if (active && rosterNo === undefined && kimiAgentId === 'main') {
      rosterNo = allocatorRef.current.allocate('main', 'Lead');
    }
    if (rosterNo !== undefined) {
      const sceneAgentId = sceneAgentIdByRosterNo(rosterNo);
      if (active) {
        activeAgentIdsRef.current.add(kimiAgentId);
        setAgentPresence(
          sceneAgentId,
          true,
          allocatorRef.current.labelOf(kimiAgentId),
        );
      } else {
        activeAgentIdsRef.current.delete(kimiAgentId);
        setAgentPresence(sceneAgentId, false);
      }
      setAgentState(sceneAgentId, state, task || undefined);
    }
    setAgents(snapshot());
  }

  /** Allocate a seat for a freshly spawned subagent and animate the handoff. */
  function spawnSubagent(
    subagentId: string,
    subagentName: string | undefined,
    callerAgentId: string | undefined,
    description: string | undefined,
  ): void {
    const rosterNo = allocatorRef.current.allocate(
      subagentId,
      subagentName ?? subagentId,
    );
    activeAgentIdsRef.current.add(subagentId);
    phaseRef.current.set(subagentId, {
      state: 'idle',
      task: description ?? '',
    });
    setAgentPresence(
      sceneAgentIdByRosterNo(rosterNo),
      true,
      subagentName ?? subagentId,
    );
    // The caller (parent) walks over to the new subagent's desk to hand off.
    const callerRosterNo =
      callerAgentId !== undefined
        ? allocatorRef.current.rosterNoOf(callerAgentId)
        : undefined;
    if (callerRosterNo !== undefined) {
      const hostName = AGENT_ROSTER[rosterNo - 1]?.name ?? `工位 ${rosterNo}`;
      submitVisitAction({
        type: 'desk_visit',
        visitor: callerRosterNo,
        host: rosterNo,
        message: `把任务交给 ${subagentName ?? subagentId}`,
      });
      void hostName; // reserved for future bubble customization
    }
    setAgents(snapshot());
  }

  /** Release a finished/failed subagent's seat. */
  function retireSubagent(subagentId: string): void {
    const rosterNo = allocatorRef.current.rosterNoOf(subagentId);
    if (rosterNo !== undefined) {
      const sceneAgentId = sceneAgentIdByRosterNo(rosterNo);
      activeAgentIdsRef.current.delete(subagentId);
      setAgentPresence(sceneAgentId, false);
      setAgentState(sceneAgentId, 'idle', undefined);
    }
    allocatorRef.current.release(subagentId);
    phaseRef.current.delete(subagentId);
    setAgents(snapshot());
  }

  // Reset everything when the session changes.
  useEffect(() => {
    for (const entry of AGENT_ROSTER) {
      setAgentPresence(entry.id, false);
    }
    allocatorRef.current = createRosterAllocator();
    phaseRef.current.clear();
    activeAgentIdsRef.current.clear();
    coordsRef.current.clear();
    setAgents([]);
    setConnected(false);
    if (sessionId === null) return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Own socket + event handlers, independent of the global activity socket.
  useEffect(() => {
    if (sessionId === null) return;
    let socket: ActivitySocket | null = null;

    const seedFromSnapshot = async (): Promise<void> => {
      try {
        const snap = await api.getSnapshot(sessionId);
        // Seed main agent phase from the in-flight turn, if any.
        if (snap.in_flight_turn !== null) {
          allocatorRef.current.allocate('main', 'Lead');
          activeAgentIdsRef.current.add('main');
          phaseRef.current.set('main', { state: 'working', task: '生成回复' });
          setAgentPresence(sceneAgentIdByRosterNo(1), true, 'Lead');
          setAgentState(sceneAgentIdByRosterNo(1), 'working', '生成回复');
        }
        // Seed already-running subagents.
        for (const sub of snap.subagents ?? []) {
          if (
            sub.status === 'running' ||
            sub.subagent_phase === 'working' ||
            sub.subagent_phase === 'queued'
          ) {
            const rosterNo = allocatorRef.current.allocate(
              sub.id,
              sub.subagent_type ?? sub.id,
            );
            activeAgentIdsRef.current.add(sub.id);
            phaseRef.current.set(sub.id, {
              state: sub.subagent_phase === 'working' ? 'working' : 'idle',
              task: sub.description ?? '',
            });
            setAgentPresence(
              sceneAgentIdByRosterNo(rosterNo),
              true,
              sub.subagent_type ?? sub.id,
            );
            setAgentState(
              sceneAgentIdByRosterNo(rosterNo),
              sub.subagent_phase === 'working' ? 'working' : 'idle',
              sub.description,
            );
          }
        }
        setAgents(snapshot());
      } catch {
        // best-effort; live events will fill in the picture
      }
    };

    socket = createActivitySocket({
      url: baseUrl,
      token,
      followSessionId: sessionId,
      handlers: {
        onWorkChanged: () => {},
        onSessionCreated: () => {},
        onMetaUpdated: () => {},
        onConfigChanged: () => {},
        onStatusUpdated: (_sid, event: AgentStatusUpdatedEvent) => {
          // `agent.status.updated` carries the *main* agent's phase on this
          // socket (subagents report via subagent.* lifecycle events). The
          // payload's agentId field distinguishes them when present.
          const payload = event as AgentStatusUpdatedEvent & {
            agentId?: string;
          };
          const kimiAgentId = payload.agentId ?? 'main';
          applyPhase(kimiAgentId, event.phase);
        },
        onGoalUpdated: () => {},
        onReconnected: () => {
          setConnected(true);
          void seedFromSnapshot();
        },
        onRawFrame: (frame: ServerFrame) => {
          // subagent.* events arrive here (not handled by the typed handlers).
          const payload = frame.payload as Record<string, unknown> | undefined;
          if (payload === undefined) return;
          switch (frame.type) {
            case 'subagent.spawned': {
              const parsed = subagentSpawnedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              if (parsed.data.runInBackground) return;
              spawnSubagent(
                parsed.data.subagentId,
                parsed.data.subagentName,
                parsed.data.callerAgentId ?? parsed.data.parentAgentId,
                parsed.data.description,
              );
              return;
            }
            case 'subagent.started': {
              const parsed = subagentStartedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              applyPhase(parsed.data.subagentId, {
                kind: 'running',
                turnId: 0,
                step: 0,
                stepId: '',
                since: Date.now(),
              });
              return;
            }
            case 'subagent.suspended': {
              const parsed = subagentSuspendedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              applyPhase(parsed.data.subagentId, {
                kind: 'awaiting_approval',
                turnId: 0,
                since: Date.now(),
              });
              return;
            }
            case 'subagent.completed': {
              const parsed = subagentCompletedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              applyPhase(parsed.data.subagentId, {
                kind: 'ended',
                turnId: 0,
                reason: 'completed',
                at: Date.now(),
              });
              retireSubagent(parsed.data.subagentId);
              return;
            }
            case 'subagent.failed': {
              const parsed = subagentFailedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              applyPhase(parsed.data.subagentId, {
                kind: 'ended',
                turnId: 0,
                reason: 'failed',
                at: Date.now(),
              });
              retireSubagent(parsed.data.subagentId);
              return;
            }
            case 'task.started': {
              const parsed = taskStartedEventSchema.safeParse(payload);
              if (!parsed.success) return;
              if (
                parsed.data.info.kind === 'agent' &&
                parsed.data.info.detached === true &&
                parsed.data.info.agentId !== undefined
              ) {
                retireSubagent(parsed.data.info.agentId);
              }
              return;
            }
            default:
              return;
          }
        },
      },
    });
    setConnected(true);
    void seedFromSnapshot();

    return () => {
      socket?.close();
      socket = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, baseUrl, token, api]);

  return { agents, connected };
}
