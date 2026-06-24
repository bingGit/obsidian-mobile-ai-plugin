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
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(() => reject(new UserFacingError("请求超时，请检查网络或调大超时时间。")), options.timeoutMs);
  });

  const request = requestUrl({
    url: options.url,
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    throw: false
  });

  const response = await Promise.race([request, timeout]);

  return {
    status: response.status,
    json: response.json as T,
    text: response.text
  };
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
