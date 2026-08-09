/** Shared expert-team contract for Electron main, preload and renderer. */

export const EXPERT_TEAM_LIST_CHANNEL = 'kimi-desktop:expert-teams:list';
export const EXPERT_TEAM_STATUS_CHANNEL = 'kimi-desktop:expert-teams:status';
export const EXPERT_TEAM_SAVE_CHANNEL = 'kimi-desktop:expert-teams:save';
export const EXPERT_TEAM_SET_ENABLED_CHANNEL =
  'kimi-desktop:expert-teams:set-enabled';
export const EXPERT_TEAM_REMOVE_CHANNEL = 'kimi-desktop:expert-teams:remove';

export const EXPERT_TEAM_COLORS = [
  'amber',
  'coral',
  'orange',
  'mint',
  'cyan',
  'blue',
  'violet',
  'pink',
] as const;

export type ExpertTeamColor = (typeof EXPERT_TEAM_COLORS)[number];
export type ExpertToolPreset = 'full' | 'read-only';

export interface ExpertTeamRole {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly prompt: string;
  readonly toolPreset: ExpertToolPreset;
}

export interface ExpertTeamDraft {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly color: ExpertTeamColor;
  readonly lead: ExpertTeamRole;
  readonly members: readonly ExpertTeamRole[];
  readonly quickPrompts: readonly string[];
}

export interface ExpertTeamRecord extends ExpertTeamDraft {
  readonly pluginId: string;
  readonly command: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly runtimeAvailable: boolean;
  readonly error?: string;
}

export interface ExpertTeamSetEnabledInput {
  readonly id: string;
  readonly enabled: boolean;
}

export interface ExpertTeamStatus {
  readonly runtimeAvailable: boolean;
}

export interface KimiDesktopExpertTeamBridge {
  status(): Promise<ExpertTeamStatus>;
  list(): Promise<readonly ExpertTeamRecord[]>;
  save(draft: ExpertTeamDraft): Promise<ExpertTeamRecord>;
  setEnabled(input: ExpertTeamSetEnabledInput): Promise<void>;
  remove(id: string): Promise<void>;
}
