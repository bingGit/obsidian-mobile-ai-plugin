import { requestUrl } from "obsidian";

import { UserFacingError } from "./errors";

export interface JsonRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface JsonResponse<T> {
  status: number;
  json: T;
  text: string;
}

export async function requestJson<T>(options: JsonRequestOptions): Promise<JsonResponse<T>> {
  let timeoutId: number | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new UserFacingError("请求超时，请检查网络或调大超时时间。")),
      options.timeoutMs
    );
  });

  try {
    const request = requestUrl({
      url: options.url,
      method: options.method ?? "GET",
      headers: getMobileSafeHeaders(options.headers),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      throw: false
    });

    const response = await Promise.race([request, timeout]);

    return {
      status: response.status,
      json: response.json as T,
      text: response.text
    };
  } catch (error) {
    throw normalizeRequestError(error);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export function joinChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");

  if (!trimmed) {
    throw new UserFacingError("请先配置 Base URL。");
  }

  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

function getMobileSafeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    Connection: "close",
    ...headers
  };
}

function normalizeRequestError(error: unknown): Error {
  if (error instanceof UserFacingError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("unexpected end of stream")
    || lower.includes("end of stream")
    || lower.includes("connection reset")
    || lower.includes("socket")
  ) {
    return new UserFacingError(
      `移动端网络连接被提前断开。请确认 Base URL 正确、模型服务关闭流式响应，或换网络后重试。原始错误：${message}`
    );
  }

  return error instanceof Error ? error : new Error(message);
}
