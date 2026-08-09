/**
 * `workspaceAgentProfileLoader` domain — user agent-file management contract.
 *
 * Defines the App-scoped store that lists and safely mutates user-level agent
 * Markdown files. The Workspace-scoped loaders remain the runtime projection;
 * this store owns only the user-file persistence surface used by local hosts.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface UserAgentProfileInput {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly color?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly prompt: string;
  readonly enabled: boolean;
}

export interface UserAgentProfileUpdate {
  readonly description: string;
  readonly whenToUse?: string;
  readonly color?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly prompt: string;
}

export interface UserAgentProfileRecord extends UserAgentProfileInput {
  readonly path: string;
  readonly editable: boolean;
}

export interface IUserAgentProfileStore {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly UserAgentProfileRecord[]>;
  create(input: UserAgentProfileInput): Promise<UserAgentProfileRecord>;
  replace(name: string, input: UserAgentProfileUpdate): Promise<UserAgentProfileRecord>;
  setEnabled(name: string, enabled: boolean): Promise<UserAgentProfileRecord>;
  remove(name: string): Promise<void>;
}

export const IUserAgentProfileStore: ServiceIdentifier<IUserAgentProfileStore> =
  createDecorator<IUserAgentProfileStore>('userAgentProfileStore');
