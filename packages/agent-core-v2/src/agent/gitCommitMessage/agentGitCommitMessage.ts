/**
 * `gitCommitMessage` domain — AI-assisted Git commit-message generation.
 *
 * Defines the Agent-scoped service that produces a commit message from the
 * current workspace changes without mutating Git state or conversation history.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type {
  FsGitGenerateCommitMessageRequest,
  FsGitGenerateCommitMessageResponse,
} from '#/app/git/git';

export interface IAgentGitCommitMessageService {
  readonly _serviceBrand: undefined;

  generate(
    request: FsGitGenerateCommitMessageRequest,
  ): Promise<FsGitGenerateCommitMessageResponse>;
}

export const IAgentGitCommitMessageService: ServiceIdentifier<IAgentGitCommitMessageService> =
  createDecorator<IAgentGitCommitMessageService>('agentGitCommitMessageService');
