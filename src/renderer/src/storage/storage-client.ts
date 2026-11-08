import type { BrowserErrorCode, BrowserResult } from '../../../shared/storage-browser';

const messages: Partial<Record<BrowserErrorCode, string>> = {
  AuthRequired: '请重新授权这个账号。',
  AccessDenied: '授权已被拒绝。',
  PermissionDenied: '没有权限访问这个位置。',
  AccessBlocked: '此账号或应用的访问受到限制。',
  ApiDisabled: 'Google Drive API 尚未启用。',
  BrowserUnavailable: '无法打开系统浏览器。',
  Busy: '已有授权操作正在进行。',
  Cancelled: '操作已取消。',
  ClientConfigurationInvalid: 'Google Drive OAuth 客户端尚未正确配置。',
  CredentialStoreUnavailable: '无法读取或保存授权凭据。',
  IdentityMismatch: '请使用此连接原有的 Google 账号。',
  InsufficientScope: '请授予所需的 Google Drive 权限。',
  InvalidArgument: '当前请求已失效，请刷新后重试。',
  NetworkError: '暂时无法连接到存储服务，请重试。',
  NotFound: '这个位置已不可用。',
  PersistenceFailed: '保存失败，请重试。',
  RateLimited: '请求过于频繁，请稍后重试。',
  StoreInvalid: '无法读取已保存的账号。',
  Timeout: '授权超时，请重试。',
};

export class StorageBrowserError extends Error {
  constructor(readonly code: BrowserErrorCode) {
    super(messages[code] ?? '无法完成存储操作，请重试。');
  }
}

export async function resultOf<T>(request: Promise<BrowserResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw new StorageBrowserError(result.code);
  return result.value;
}

export function errorText(error: unknown): string {
  return error instanceof StorageBrowserError ? error.message : '无法完成存储操作，请重试。';
}
