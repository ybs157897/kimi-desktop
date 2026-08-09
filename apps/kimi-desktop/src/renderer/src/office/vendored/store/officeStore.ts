import type { Agent } from '#/office/vendored/types/agent'
import { INITIAL_AGENTS } from '#/office/vendored/scene/layout/officeLayout'

let agents: Agent[] = INITIAL_AGENTS.map((a) => ({ ...a }))

export function getOfficeAgents(): Agent[] {
  return agents
}

export function setOfficeAgents(nextAgents: Agent[]) {
  agents = nextAgents
}
