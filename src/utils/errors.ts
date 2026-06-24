export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export class RetryableNetworkError extends UserFacingError {
  readonly originalMessage: string;

  constructor(message: string, originalMessage: string) {
    super(message);
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
