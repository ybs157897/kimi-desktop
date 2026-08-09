/**
 * Maps kimi-desktop agent ids (the session's `main` agent plus runtime-spawned
 * subagents like `agent-1`, `agent-2`, …) onto the office's 1‑based roster
 * numbers (1–6), which in turn correspond to the six fixed desks.
 *
 * Roster slot 1 is permanently held by the `main` agent; subagents are handed
 * slots 2–6 in arrival order. When a subagent finishes its work its slot is
 * released back to the free pool so later subagents can reuse it.
 *
 * The vendored office scene reads agent identities by roster number, so the
 * allocator is the single source of truth for "which agent sits where".
 */

/** The main agent always occupies roster slot 1. */
export const MAIN_AGENT_ID = 'main'
export const MAIN_ROSTER_NO = 1

/** Total number of desks in the office (matches the vendored layout). */
export const MAX_ROSTER_NO = 6

/**
 * First roster slot available to subagents (main holds slot 1).
 * More than `MAX_ROSTER_NO - 1` concurrent subagents overflow onto slot
 * `MAX_ROSTER_NO`; the overlay marks those as "overflow".
 */
const FIRST_SUBAGENT_SLOT = MAIN_ROSTER_NO + 1

export interface RosterSlot {
  rosterNo: number
  agentId: string
  /** Human-friendly label for the overlay (subagent type / profile name). */
  label: string
  /** True when this slot was reused past capacity (shared with another agent). */
  overflow: boolean
}

export interface RosterAllocator {
  /** Ensure an agent is seated, returning its roster number. Reentrant. */
  allocate: (agentId: string, label?: string) => number
  /** Release a subagent's seat (no-op for the main agent). */
  release: (agentId: string) => void
  /** Current roster number for an agent, or `undefined` if not seated. */
  rosterNoOf: (agentId: string) => number | undefined
  /** Current label for an agent, or `undefined`. */
  labelOf: (agentId: string) => string | undefined
  /** Snapshot of all occupied slots (main first, then by roster number). */
  slots: () => RosterSlot[]
  /** Forget every subagent (used on session switch / re-seed). */
  reset: () => void
}

export function createRosterAllocator(): RosterAllocator {
  /** rosterNo → slot. Slot 1 is always the main agent. */
  const byRosterNo = new Map<number, RosterSlot>([
    [MAIN_ROSTER_NO, { rosterNo: MAIN_ROSTER_NO, agentId: MAIN_AGENT_ID, label: 'Lead', overflow: false }],
  ])
  /** agentId → rosterNo, kept in sync with `byRosterNo`. */
  const byAgentId = new Map<string, number>([[MAIN_AGENT_ID, MAIN_ROSTER_NO]])

  function freeSlots(): number[] {
    const taken = new Set(byRosterNo.keys())
    const free: number[] = []
    for (let n = FIRST_SUBAGENT_SLOT; n <= MAX_ROSTER_NO; n += 1) {
      if (!taken.has(n)) free.push(n)
    }
    return free
  }

  function allocate(agentId: string, label?: string): number {
    if (agentId === MAIN_AGENT_ID) return MAIN_ROSTER_NO
    const existing = byAgentId.get(agentId)
    if (existing !== undefined) {
      if (label !== undefined) {
        const slot = byRosterNo.get(existing)
        if (slot !== undefined) byRosterNo.set(existing, { ...slot, label })
      }
      return existing
    }
    let rosterNo = freeSlots()[0]
    if (rosterNo === undefined) {
      // Past capacity: pile onto the last slot and mark it as overflow.
      rosterNo = MAX_ROSTER_NO
      const slot = byRosterNo.get(rosterNo)
      byRosterNo.set(rosterNo, {
        rosterNo,
        agentId,
        label: label ?? agentId,
        overflow: true,
      })
      // Keep both agent ids pointing at the shared slot; only the most recent
      // is surfaced by `slots()`, but rosterNoOf still resolves for both.
      byAgentId.set(agentId, rosterNo)
      return rosterNo
    }
    byRosterNo.set(rosterNo, { rosterNo, agentId, label: label ?? agentId, overflow: false })
    byAgentId.set(agentId, rosterNo)
    return rosterNo
  }

  function release(agentId: string): void {
    if (agentId === MAIN_AGENT_ID) return
    const rosterNo = byAgentId.get(agentId)
    if (rosterNo === undefined) return
    byAgentId.delete(agentId)
    const slot = byRosterNo.get(rosterNo)
    // Overflow slot may have been superseded by a later agent; only clear it
    // when this agent still owns it.
    if (slot !== undefined && slot.agentId === agentId) {
      byRosterNo.delete(rosterNo)
    }
  }

  function rosterNoOf(agentId: string): number | undefined {
    return byAgentId.get(agentId)
  }

  function labelOf(agentId: string): string | undefined {
    const rosterNo = byAgentId.get(agentId)
    if (rosterNo === undefined) return undefined
    return byRosterNo.get(rosterNo)?.label
  }

  function slots(): RosterSlot[] {
    return [...byRosterNo.values()].sort((a, b) => a.rosterNo - b.rosterNo)
  }

  function reset(): void {
    byRosterNo.clear()
    byAgentId.clear()
    byRosterNo.set(MAIN_ROSTER_NO, {
      rosterNo: MAIN_ROSTER_NO,
      agentId: MAIN_AGENT_ID,
      label: 'Lead',
      overflow: false,
    })
    byAgentId.set(MAIN_AGENT_ID, MAIN_ROSTER_NO)
  }

  return { allocate, release, rosterNoOf, labelOf, slots, reset }
}
