export type OfficeAgentState =
  | 'idle'
  | 'think'
  | 'work'
  | 'review'
  | 'done'
  | 'failed';

export type OfficeAgentKind =
  | 'main'
  | 'expert'
  | 'subagent'
  | 'swarm'
  | 'background';

export interface OfficeActivity {
  readonly id: string;
  readonly time: number;
  readonly text: string;
  readonly tone?: 'normal' | 'success' | 'danger';
}

export interface OfficeAgentView {
  readonly agentId: string;
  readonly label: string;
  readonly officialTitle: string;
  readonly department: string;
  readonly color: string;
  readonly state: OfficeAgentState;
  readonly task: string;
  readonly kind: OfficeAgentKind;
  readonly parentAgentId?: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly sent: number;
  readonly received: number;
  readonly activities: readonly OfficeActivity[];
}

export interface OfficeMilestone {
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'done';
}

export type OfficeCollaborationMode =
  | 'single'
  | 'subagents'
  | 'expert'
  | 'swarm';

export interface OfficeDashboard {
  readonly connected: boolean;
  readonly title: string;
  readonly phaseName: string;
  readonly collaborationMode: OfficeCollaborationMode;
  readonly agents: readonly OfficeAgentView[];
  readonly milestones: readonly OfficeMilestone[];
}
