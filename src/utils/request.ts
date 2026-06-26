import { requestUrl } from "obsidian";

import { type DebugDetail, RetryableNetworkError, UserFacingError } from "./errors";
import type { ProviderApiFormat } from "../settings/types";

export interface JsonRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface JsonResponse<T> {
  status: number;
  json: T;
  text: string;
}

export async function requestJson<T>(options: JsonRequestOptions): Promise<JsonResponse<T>> {
  let timeoutId: number | undefined;
  let abortHandler: (() => void) | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new UserFacingError("请求超时，请检查网络或调大超时时间。")),
      options.timeoutMs
    );
  });
  const abort = new Promise<never>((_, reject) => {
    if (!options.signal) {
      return;
    }

    if (options.signal.aborted) {
      reject(new UserFacingError("请求已取消。"));
      return;
    }

    abortHandler = () => reject(new UserFacingError("请求已取消。"));
    options.signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    const request = requestUrl({
      url: options.url,
      method: options.method ?? "GET",
      headers: getMobileSafeHeaders(options.headers),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      throw: false
    });

    const response = await Promise.race([request, timeout, abort]);

    return {
      status: response.status,
      json: response.json as T,
      text: response.text
    };
  } catch (error) {
    throw normalizeRequestError(error, options);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }

    if (options.signal && abortHandler) {
      options.signal.removeEventListener("abort", abortHandler);
    }
  }
}

export function joinModelApiUrl(baseUrl: string, apiFormat: ProviderApiFormat): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");

  if (!trimmed) {
    throw new UserFacingError("请先配置 Base URL。");
  }

  const suffix = apiFormat === "responses" ? "/responses" : "/chat/completions";

  if (trimmed.endsWith("/chat/completions") || trimmed.endsWith("/responses")) {
    return trimmed;
  }

  return `${trimmed}${suffix}`;
}

function getMobileSafeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    Connection: "close",
    ...headers
  };
}

function normalizeRequestError(error: unknown, options: JsonRequestOptions): Error {
  if (error instanceof UserFacingError) {
    return new UserFacingError(
      error.message,
      [...error.debugDetails, ...buildRequestDebugDetails(options, error.message)]
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const debugDetails = buildRequestDebugDetails(options, message);

  if (
    lower.includes("unexpected end of stream")
    || lower.includes("end of stream")
    || lower.includes("connection reset")
    || lower.includes("socket")
  ) {
    return new RetryableNetworkError(
      `移动端网络连接被提前断开。短连接测试成功只能说明 API 凭据可用，真实聊天的长响应仍可能被中转站或 Android 网络层中断。可以尝试把最大输出 token 降到 512，或把请求超时调到 180000。插件会尝试用更短输出重试。原始错误：${message}`,
      message,
      debugDetails
    );
  }

  if (lower.includes("timeout") || message.includes("请求超时")) {
    return new UserFacingError(
      `请求超过 ${options.timeoutMs} 毫秒仍未返回。测试连接成功只代表短请求可用；真实聊天在非流式模式下要等完整回答返回。建议把请求超时调到 180000，或把最大输出 token 降到 512 后复测。`,
      debugDetails
    );
  }

  return new UserFacingError(message, debugDetails);
}

function buildRequestDebugDetails(options: JsonRequestOptions, originalMessage: string): DebugDetail[] {
  const body = summarizeBody(options.body);

  return [
    { label: "请求方法", value: options.method ?? "GET" },
    { label: "请求 URL", value: options.url },
    { label: "超时毫秒", value: String(options.timeoutMs) },
    { label: "请求头", value: summarizeHeaders(getMobileSafeHeaders(options.headers)) },
    { label: "请求体摘要", value: body },
    { label: "原始错误", value: originalMessage }
  ];
}

function summarizeHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => {
      if (key.toLowerCase() === "authorization") {
        return `${key}=Bearer ***`;
      }

      return `${key}=${value}`;
    })
    .join("; ");
}

function summarizeBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    return body === undefined ? "无" : String(body);
  }

  const candidate = body as {
    model?: unknown;
    messages?: Array<{ content?: unknown }>;
    input?: Array<{ content?: unknown }>;
    instructions?: unknown;
    max_tokens?: unknown;
    max_output_tokens?: unknown;
    temperature?: unknown;
    stream?: unknown;
  };
  const inputs = Array.isArray(candidate.messages) ? candidate.messages : Array.isArray(candidate.input) ? candidate.input : [];
  const messageCount = inputs.length;
  const messageCharacters = inputs.length
    ? inputs.reduce((total, message) => total + summarizeContentLength(message.content), 0)
    : 0;

  return [
    `model=${String(candidate.model ?? "")}`,
    `messages=${messageCount}`,
    `messageChars=${messageCharacters}`,
    `instructionsChars=${String(candidate.instructions ? String(candidate.instructions).length : 0)}`,
    `max_tokens=${String(candidate.max_tokens ?? "")}`,
    `max_output_tokens=${String(candidate.max_output_tokens ?? "")}`,
    `temperature=${String(candidate.temperature ?? "")}`,
    `stream=${String(candidate.stream ?? "")}`
  ].join("; ");
}

function summarizeContentLength(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }

  if (Array.isArray(content)) {
    return content.reduce((total, item) => total + summarizeContentLength(item), 0);
  }

  if (content && typeof content === "object") {
    const candidate = content as { text?: unknown; content?: unknown };
    return summarizeContentLength(candidate.text) + summarizeContentLength(candidate.content);
  }

  return String(content ?? "").length;
}
