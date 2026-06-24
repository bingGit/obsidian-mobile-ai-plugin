export interface DebugDetail {
  label: string;
  value: string;
}

export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly debugDetails: DebugDetail[] = []
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

export class RetryableNetworkError extends UserFacingError {
  readonly originalMessage: string;

  constructor(message: string, originalMessage: string, debugDetails: DebugDetail[] = []) {
    super(message, debugDetails);
    this.name = "RetryableNetworkError";
    this.originalMessage = originalMessage;
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof UserFacingError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "未知错误";
}

export function toDebugMessage(error: unknown): string {
  const userMessage = toUserMessage(error);
  const lines = [userMessage.startsWith("请求失败") ? userMessage : `请求失败：${userMessage}`];

  if (error instanceof Error) {
    lines.push("");
    lines.push("调试信息：");
    lines.push(`- 错误类型：${error.name}`);
  }

  if (error instanceof UserFacingError && error.debugDetails.length) {
    for (const detail of error.debugDetails) {
      lines.push(`- ${detail.label}：${detail.value}`);
    }
  } else if (error instanceof Error && error.message) {
    lines.push(`- 原始错误：${error.message}`);
  } else {
    lines.push(`- 原始错误：${String(error)}`);
  }

  lines.push("");
  lines.push("已隐藏 Authorization/API Key 和消息正文。");

  return lines.join("\n");
}

export function appendDebugDetails(error: unknown, details: DebugDetail[]): Error {
  if (error instanceof UserFacingError) {
    return new UserFacingError(error.message, [...error.debugDetails, ...details]);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new UserFacingError(message, details);
}
