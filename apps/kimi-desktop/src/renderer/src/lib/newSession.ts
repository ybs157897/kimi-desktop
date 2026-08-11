import { ErrorCode, type FsHomeResponse } from '@moonshot-ai/protocol';

import { ApiError } from './api';

export function resolveNewSessionCwd(
  fsHome: FsHomeResponse | undefined,
  historicalCwds: readonly (string | null)[],
): string | undefined {
  if (fsHome !== undefined) {
    return fsHome.recent_roots.find((root) => root !== fsHome.home) ?? fsHome.home;
  }
  return historicalCwds.find((cwd): cwd is string => cwd !== null);
}

export function isMissingWorkspaceError(error: unknown): boolean {
  return error instanceof ApiError && error.code === ErrorCode.FS_PATH_NOT_FOUND;
}

export function newSessionErrorMessage(error: unknown): string {
  if (isMissingWorkspaceError(error)) {
    return '工作区目录不存在或已移动，请重新选择。';
  }
  if (error instanceof ApiError && (error.code === -1 || error.httpStatus === 0)) {
    return '无法连接后端，请检查服务状态后重试。';
  }
  return '新会话启动失败，请重试。';
}
