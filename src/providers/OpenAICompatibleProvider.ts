import type { ProviderApiFormat, ProviderConfig } from "../settings/types";
import { appendDebugDetails, RetryableNetworkError, UserFacingError } from "../utils/errors";
import { joinModelApiUrl, requestJson } from "../utils/request";
import type { AiProvider, ChatRequest, ChatResponse, TestResult } from "./types";

interface OpenAIChoice {
  message?: {
    content?: string;
  };
}

interface OpenAIErrorResponse {
  error?: {
    message?: string;
    type?: string;
  };
}

interface OpenAIChatResponse extends OpenAIErrorResponse {
  choices?: OpenAIChoice[];
}

interface OpenAIStreamChoice {
  delta?: {
    content?: string;
  };
}

interface OpenAIStreamChunk extends OpenAIErrorResponse {
  choices?: OpenAIStreamChoice[];
}

interface ResponsesContentItem {
  type?: string;
  text?: string;
}

interface ResponsesOutputItem {
  role?: string;
  content?: ResponsesContentItem[];
}

interface ResponsesApiResponse extends OpenAIErrorResponse {
  output?: ResponsesOutputItem[];
}

interface ResponsesStreamChunk extends OpenAIErrorResponse {
  type?: string;
  delta?: string;
  response?: ResponsesApiResponse;
  text?: string;
  item?: {
    content?: ResponsesContentItem[];
  };
}

interface StreamDiagnostics {
  apiFormat: ProviderApiFormat;
  channel: "fetch" | "XMLHttpRequest";
  eventCount: number;
  dataEventCount: number;
  bytesReceived: number;
  rawChunkCount: number;
  firstEventType: string;
  lastEventType: string;
  lastEventPreview: string;
  firstChunkPreview: string;
  lastChunkPreview: string;
  trailingBufferPreview: string;
  responseStatus: string;
  responseContentType: string;
  responseHeaders: string;
}

export class OpenAICompatibleProvider implements AiProvider {
  id = "openai-compatible";
  name = "OpenAI Compatible";

  async sendChat(request: ChatRequest): Promise<ChatResponse> {
    let data: OpenAIChatResponse | ResponsesApiResponse;
    let content = "";

    if (request.config.apiFormat === "responses") {
      data = await this.postResponsesWithRetry(request);
      content = extractResponsesText(data).trim();
    } else {
      const chatData = await this.postChatCompletionWithRetry(request);
      data = chatData;
      content = chatData.choices?.[0]?.message?.content?.trim() ?? "";
    }

    if (!content) {
      throw new UserFacingError("模型返回为空。");
    }

    return {
      content,
      raw: data
    };
  }

  async streamChat(request: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse> {
    let emittedContent = "";
    const emitDelta = (text: string) => {
      emittedContent += text;
      onDelta(text);
    };

    try {
      request.onStatus?.(`正在建立 ${request.config.apiFormat === "responses" ? "Responses" : "Chat Completions"} 流式连接`);
      const content = request.config.apiFormat === "responses"
        ? await this.streamResponsesWithFetch(request, emitDelta)
        : await this.streamChatCompletionWithFetch(request, emitDelta);

      if (!content.trim()) {
        throw new UserFacingError("模型返回为空。");
      }

      return {
        content
      };
    } catch (error) {
      if (emittedContent.trim()) {
        request.onStatus?.("流式连接中断，已保留已收到内容");
        return {
          content: emittedContent
        };
      }
      request.onStatus?.("fetch 流式连接失败，正在尝试 XHR 流式通道");

      try {
        const xhrContent = request.config.apiFormat === "responses"
          ? await this.streamResponsesWithXhr(request, emitDelta)
          : await this.streamChatCompletionWithXhr(request, emitDelta);

        if (!xhrContent.trim()) {
          throw new UserFacingError("流式通道已建立，但没有收到可用内容。");
        }

        return {
          content: xhrContent
        };
      } catch (xhrError) {
        if (emittedContent.trim()) {
          request.onStatus?.("XHR 流式连接中断，已保留已收到内容");
          return {
            content: emittedContent
          };
        }

        throw combineStreamErrors(error, xhrError);
      }
    }
  }

  private async postChatCompletionWithRetry(request: ChatRequest): Promise<OpenAIChatResponse> {
    try {
      return await this.postChatCompletion(request);
    } catch (error) {
      if (!(error instanceof RetryableNetworkError) || request.maxTokens <= 768) {
        throw error;
      }

      try {
        return await this.postChatCompletion({
          ...request,
          maxTokens: 512,
          messages: [
            ...request.messages,
            {
              role: "system",
              content: "The mobile network disconnected during the previous attempt. Keep the answer concise and under 500 Chinese characters unless the user explicitly asked for code."
            }
          ]
        });
      } catch (retryError) {
        throw appendDebugDetails(retryError, [
          { label: "首次请求错误", value: error.originalMessage },
          { label: "是否已重试", value: "是，重试 max_tokens=512" }
        ]);
      }
    }
  }

  private async postResponsesWithRetry(request: ChatRequest): Promise<ResponsesApiResponse> {
    try {
      return await this.postResponses(request);
    } catch (error) {
      if (!(error instanceof RetryableNetworkError) || request.maxTokens <= 768) {
        throw error;
      }

      try {
        return await this.postResponses({
          ...request,
          maxTokens: 512,
          messages: [
            ...request.messages,
            {
              role: "system",
              content: "The mobile network disconnected during the previous attempt. Keep the answer concise and under 500 Chinese characters unless the user explicitly asked for code."
            }
          ]
        });
      } catch (retryError) {
        throw appendDebugDetails(retryError, [
          { label: "首次请求错误", value: error.originalMessage },
          { label: "是否已重试", value: "是，重试 max_output_tokens=512" }
        ]);
      }
    }
  }

  async testConnection(config: ProviderConfig, timeoutMs: number): Promise<TestResult> {
    const model = resolveModel(config);

    if (!model) {
      return {
        ok: false,
        message: "请先填写模型名。"
      };
    }

    try {
      await this.sendChat({
        config,
        model,
        messages: [
          {
            role: "user",
            content: "Reply with OK."
          }
        ],
        temperature: 0,
        maxTokens: 16,
        timeoutMs
      });

      return {
        ok: true,
        message: "短连接成功。注意：这只验证 API Key、Base URL 和模型可用，不代表真实长回答不会超时。"
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "连接失败。"
      };
    }
  }

  private async postChatCompletion(request: ChatRequest): Promise<OpenAIChatResponse> {
    const { config } = request;
    const model = request.model.trim() || resolveModel(config);

    if (!config.apiKey.trim()) {
      throw new UserFacingError("请先配置 API Key。");
    }

    if (!model) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    const response = await requestJson<OpenAIChatResponse>({
      url: joinModelApiUrl(config.baseUrl, "chat-completions"),
      method: "POST",
      timeoutMs: request.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`
      },
      body: {
        model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: false
      }
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error?.message ?? response.text ?? `HTTP ${response.status}`;
      throw new UserFacingError(`请求失败：${message}`, [
        { label: "HTTP 状态", value: String(response.status) },
        { label: "响应摘要", value: truncate(response.text || JSON.stringify(response.json), 2000) },
        { label: "请求 URL", value: joinModelApiUrl(config.baseUrl, "chat-completions") },
        { label: "模型", value: model },
        { label: "max_tokens", value: String(request.maxTokens) },
        { label: "stream", value: "false" }
      ]);
    }

    return response.json;
  }

  private async postResponses(request: ChatRequest): Promise<ResponsesApiResponse> {
    const { config } = request;
    const model = request.model.trim() || resolveModel(config);

    if (!config.apiKey.trim()) {
      throw new UserFacingError("请先配置 API Key。");
    }

    if (!model) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    const response = await requestJson<ResponsesApiResponse>({
      url: joinModelApiUrl(config.baseUrl, "responses"),
      method: "POST",
      timeoutMs: request.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`
      },
      body: buildResponsesBody(request, false)
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error?.message ?? response.text ?? `HTTP ${response.status}`;
      throw new UserFacingError(`请求失败：${message}`, [
        { label: "HTTP 状态", value: String(response.status) },
        { label: "响应摘要", value: truncate(response.text || JSON.stringify(response.json), 2000) },
        { label: "请求 URL", value: joinModelApiUrl(config.baseUrl, "responses") },
        { label: "模型", value: model },
        { label: "max_output_tokens", value: String(request.maxTokens) },
        { label: "stream", value: "false" }
      ]);
    }

    return response.json;
  }

  private async streamChatCompletionWithFetch(request: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    const { config } = request;
    const model = request.model.trim() || resolveModel(config);

    if (!config.apiKey.trim()) {
      throw new UserFacingError("请先配置 API Key。");
    }

    if (!model) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    if (!window.fetch || !window.ReadableStream) {
      throw new UserFacingError("当前移动端环境不支持 fetch 可读流。", [
        { label: "接口格式", value: "chat-completions" },
        { label: "流式通道", value: "fetch" },
        { label: "fetch 可用", value: String(Boolean(window.fetch)) },
        { label: "ReadableStream 可用", value: String(Boolean(window.ReadableStream)) }
      ]);
    }

    const url = joinModelApiUrl(config.baseUrl, "chat-completions");
    const body = {
      model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true
    };
    const controller = new AbortController();
    const idleTimeout = createIdleTimeout(request.timeoutMs, () => controller.abort());
    const diagnostics = createStreamDiagnostics("chat-completions", "fetch");

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey.trim()}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      diagnostics.responseStatus = String(response.status);
      diagnostics.responseContentType = response.headers.get("content-type") ?? "(missing)";
      diagnostics.responseHeaders = summarizeResponseHeaders(response.headers);

      if (!response.ok) {
        const text = await response.text();
        throw new UserFacingError(`请求失败：${text || `HTTP ${response.status}`}`, [
          { label: "HTTP 状态", value: String(response.status) },
          { label: "响应摘要", value: truncate(text, 2000) },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" },
          ...buildStreamDebugDetails(diagnostics)
        ]);
      }

      if (!response.body) {
        throw new UserFacingError("fetch 已返回响应，但没有提供可读流 body。", buildStreamDebugDetails(diagnostics));
      }

      if (looksLikeJsonResponse(diagnostics.responseContentType)) {
        throw new UserFacingError("流式请求返回了 JSON，而不是事件流。", buildStreamDebugDetails(diagnostics));
      }

      return await readSseStream(response.body, diagnostics, (event) => parseChatCompletionsStreamEvent(event, onDelta), () => {
        idleTimeout.bump();
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw appendDebugDetails(error, buildStreamDebugDetails(diagnostics));
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new UserFacingError(message, [
        { label: "请求方法", value: "POST" },
        { label: "请求 URL", value: url },
        { label: "模型", value: model },
        { label: "max_tokens", value: String(request.maxTokens) },
        { label: "stream", value: "true" },
        { label: "请求体摘要", value: `messages=${request.messages.length}; messageChars=${countMessageCharacters(request.messages)}` },
        { label: "原始错误", value: message },
        ...buildStreamDebugDetails(diagnostics)
      ]);
    } finally {
      idleTimeout.clear();
    }
  }

  private async streamResponsesWithFetch(request: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    const { config } = request;
    const model = request.model.trim() || resolveModel(config);

    if (!config.apiKey.trim()) {
      throw new UserFacingError("请先配置 API Key。");
    }

    if (!model) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    if (!window.fetch || !window.ReadableStream) {
      throw new UserFacingError("当前移动端环境不支持 fetch 可读流。", [
        { label: "接口格式", value: "responses" },
        { label: "流式通道", value: "fetch" },
        { label: "fetch 可用", value: String(Boolean(window.fetch)) },
        { label: "ReadableStream 可用", value: String(Boolean(window.ReadableStream)) }
      ]);
    }

    const url = joinModelApiUrl(config.baseUrl, "responses");
    const controller = new AbortController();
    const idleTimeout = createIdleTimeout(request.timeoutMs, () => controller.abort());
    const diagnostics = createStreamDiagnostics("responses", "fetch");

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey.trim()}`
        },
        body: JSON.stringify(buildResponsesBody(request, true)),
        signal: controller.signal
      });
      diagnostics.responseStatus = String(response.status);
      diagnostics.responseContentType = response.headers.get("content-type") ?? "(missing)";
      diagnostics.responseHeaders = summarizeResponseHeaders(response.headers);

      if (!response.ok) {
        const text = await response.text();
        throw new UserFacingError(`请求失败：${text || `HTTP ${response.status}`}`, [
          { label: "HTTP 状态", value: String(response.status) },
          { label: "响应摘要", value: truncate(text, 2000) },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_output_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" },
          ...buildStreamDebugDetails(diagnostics)
        ]);
      }

      if (!response.body) {
        throw new UserFacingError("fetch 已返回响应，但没有提供可读流 body。", buildStreamDebugDetails(diagnostics));
      }

      if (looksLikeJsonResponse(diagnostics.responseContentType)) {
        throw new UserFacingError("流式请求返回了 JSON，而不是事件流。", buildStreamDebugDetails(diagnostics));
      }

      return await readSseStream(response.body, diagnostics, (event) => parseResponsesStreamEvent(event, onDelta), () => {
        idleTimeout.bump();
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw appendDebugDetails(error, buildStreamDebugDetails(diagnostics));
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new UserFacingError(message, [
        { label: "请求方法", value: "POST" },
        { label: "请求 URL", value: url },
        { label: "模型", value: model },
        { label: "max_output_tokens", value: String(request.maxTokens) },
        { label: "stream", value: "true" },
        { label: "请求体摘要", value: `messages=${request.messages.length}; messageChars=${countMessageCharacters(request.messages)}` },
        { label: "原始错误", value: message },
        ...buildStreamDebugDetails(diagnostics)
      ]);
    } finally {
      idleTimeout.clear();
    }
  }

  private async streamChatCompletionWithXhr(request: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    const { config } = request;
    const model = request.model.trim() || resolveModel(config);

    if (!config.apiKey.trim()) {
      throw new UserFacingError("请先配置 API Key。");
    }

    if (!model) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    const url = joinModelApiUrl(config.baseUrl, "chat-completions");
    const body = {
      model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true
    };
    const diagnostics = createStreamDiagnostics("chat-completions", "XMLHttpRequest");

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let buffer = "";
      let content = "";
      let seenLength = 0;
      const idleTimeout = createIdleTimeout(request.timeoutMs, () => {
        xhr.abort();
        reject(new UserFacingError(buildIdleTimeoutMessage(request.timeoutMs, diagnostics), [
          { label: "请求方法", value: "POST" },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" },
          { label: "流式通道", value: "XMLHttpRequest" },
          ...buildStreamDebugDetails(diagnostics)
        ]));
      });

      xhr.open("POST", url, true);
      xhr.setRequestHeader("Accept", "text/event-stream");
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Authorization", `Bearer ${config.apiKey.trim()}`);

      xhr.onprogress = () => {
        idleTimeout.bump();
        diagnostics.responseStatus = xhr.status ? String(xhr.status) : diagnostics.responseStatus;
        diagnostics.responseHeaders = summarizeRawResponseHeaders(xhr.getAllResponseHeaders());
        diagnostics.responseContentType = xhr.getResponseHeader("content-type") ?? diagnostics.responseContentType;
        const nextText = xhr.responseText.slice(seenLength);
        seenLength = xhr.responseText.length;
        const result = readSseText(nextText, buffer, diagnostics, (event) => parseChatCompletionsStreamEvent(event, onDelta));
        buffer = result.buffer;
        content += result.content;
      };

      xhr.onload = () => {
        idleTimeout.clear();

        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new UserFacingError(`请求失败：${xhr.responseText || `HTTP ${xhr.status}`}`, [
            { label: "HTTP 状态", value: String(xhr.status) },
            { label: "响应摘要", value: truncate(xhr.responseText, 2000) },
            { label: "请求 URL", value: url },
            { label: "模型", value: model },
            { label: "max_tokens", value: String(request.maxTokens) },
            { label: "stream", value: "true" },
            { label: "流式通道", value: "XMLHttpRequest" },
            ...buildStreamDebugDetails(diagnostics)
          ]));
          return;
        }

        if (buffer) {
          const result = readSseText("\n\n", buffer, diagnostics, (event) => parseChatCompletionsStreamEvent(event, onDelta));
          content += result.content;
        }

        if (!content.trim() && looksLikeJsonResponse(diagnostics.responseContentType)) {
          reject(new UserFacingError("XHR 流式请求返回了 JSON，而不是事件流。", buildStreamDebugDetails(diagnostics)));
          return;
        }

        resolve(content);
      };

      xhr.onerror = () => {
        idleTimeout.clear();
        reject(new UserFacingError("XMLHttpRequest 流式连接失败。", [
          { label: "请求方法", value: "POST" },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" },
          { label: "流式通道", value: "XMLHttpRequest" },
          { label: "原始错误", value: "xhr.onerror" },
          ...buildStreamDebugDetails(diagnostics)
        ]));
      };

      xhr.onabort = () => {
        idleTimeout.clear();
        reject(new UserFacingError("XMLHttpRequest 流式连接已中止。", [
          { label: "请求方法", value: "POST" },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" },
          { label: "流式通道", value: "XMLHttpRequest" },
          ...buildStreamDebugDetails(diagnostics)
        ]));
      };

      xhr.send(JSON.stringify(body));
    });
  }

  private async streamResponsesWithXhr(request: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    const { config } = request;
    const model = request.model.trim() || resolveModel(config);

    if (!config.apiKey.trim()) {
      throw new UserFacingError("请先配置 API Key。");
    }

    if (!model) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    const url = joinModelApiUrl(config.baseUrl, "responses");
    const diagnostics = createStreamDiagnostics("responses", "XMLHttpRequest");

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let buffer = "";
      let content = "";
      let seenLength = 0;
      const idleTimeout = createIdleTimeout(request.timeoutMs, () => {
        xhr.abort();
        reject(new UserFacingError(buildIdleTimeoutMessage(request.timeoutMs, diagnostics), [
          { label: "请求方法", value: "POST" },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_output_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" },
          { label: "流式通道", value: "XMLHttpRequest" },
          ...buildStreamDebugDetails(diagnostics)
        ]));
      });

      xhr.open("POST", url, true);
      xhr.setRequestHeader("Accept", "text/event-stream");
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Authorization", `Bearer ${config.apiKey.trim()}`);

      xhr.onprogress = () => {
        idleTimeout.bump();
        diagnostics.responseStatus = xhr.status ? String(xhr.status) : diagnostics.responseStatus;
        diagnostics.responseHeaders = summarizeRawResponseHeaders(xhr.getAllResponseHeaders());
        diagnostics.responseContentType = xhr.getResponseHeader("content-type") ?? diagnostics.responseContentType;
        const nextText = xhr.responseText.slice(seenLength);
        seenLength = xhr.responseText.length;
        const result = readSseText(nextText, buffer, diagnostics, (event) => parseResponsesStreamEvent(event, onDelta));
        buffer = result.buffer;
        content += result.content;
      };

      xhr.onload = () => {
        idleTimeout.clear();

        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new UserFacingError(`请求失败：${xhr.responseText || `HTTP ${xhr.status}`}`, [
            { label: "HTTP 状态", value: String(xhr.status) },
            { label: "响应摘要", value: truncate(xhr.responseText, 2000) },
            { label: "请求 URL", value: url },
            { label: "模型", value: model },
            { label: "max_output_tokens", value: String(request.maxTokens) },
            { label: "stream", value: "true" },
            { label: "流式通道", value: "XMLHttpRequest" },
            ...buildStreamDebugDetails(diagnostics)
          ]));
          return;
        }

        if (buffer) {
          const result = readSseText("\n\n", buffer, diagnostics, (event) => parseResponsesStreamEvent(event, onDelta));
          content += result.content;
        }

        if (!content.trim() && looksLikeJsonResponse(diagnostics.responseContentType)) {
          reject(new UserFacingError("XHR 流式请求返回了 JSON，而不是事件流。", buildStreamDebugDetails(diagnostics)));
          return;
        }

        resolve(content);
      };

      xhr.onerror = () => {
        idleTimeout.clear();
        reject(new UserFacingError("XMLHttpRequest 流式连接失败。", [
          { label: "请求方法", value: "POST" },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_output_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" },
          { label: "流式通道", value: "XMLHttpRequest" },
          { label: "原始错误", value: "xhr.onerror" },
          ...buildStreamDebugDetails(diagnostics)
        ]));
      };

      xhr.onabort = () => {
        idleTimeout.clear();
        reject(new UserFacingError("XMLHttpRequest 流式连接已中止。", [
          { label: "请求方法", value: "POST" },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_output_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" },
          { label: "流式通道", value: "XMLHttpRequest" },
          ...buildStreamDebugDetails(diagnostics)
        ]));
      };

      xhr.send(JSON.stringify(buildResponsesBody(request, true)));
    });
  }
}

function resolveModel(config: ProviderConfig): string {
  return config.defaultModel.trim() || config.models.map((model) => model.trim()).find(Boolean) || "";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  diagnostics: StreamDiagnostics,
  parseEvent: (event: SseEvent) => string,
  onActivity: () => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunkText = decoder.decode(value, { stream: true });
    diagnostics.bytesReceived += chunkText.length;
    diagnostics.rawChunkCount += 1;
    if (diagnostics.firstChunkPreview === "(none)") {
      diagnostics.firstChunkPreview = truncate(chunkText, 160);
    }
    diagnostics.lastChunkPreview = truncate(chunkText, 160);
    const result = readSseText(chunkText, buffer, diagnostics, parseEvent);
    buffer = result.buffer;
    diagnostics.trailingBufferPreview = truncate(buffer, 160);
    content += result.content;
    onActivity();
  }

  return content;
}

function readSseText(
  text: string,
  previousBuffer: string,
  diagnostics: StreamDiagnostics,
  parseEvent: (event: SseEvent) => string
): { buffer: string; content: string } {
  let content = "";
  const raw = `${previousBuffer}${text}`;
  const normalized = raw.replace(/\r\n/g, "\n");
  const chunks = normalized.split("\n\n");
  const buffer = chunks.pop() ?? "";
  diagnostics.trailingBufferPreview = truncate(buffer, 160);

  for (const chunkText of chunks) {
    const event = parseSseEvent(chunkText);

    if (!event || !event.data || event.data === "[DONE]") {
      continue;
    }

    diagnostics.eventCount += 1;
    diagnostics.dataEventCount += 1;
    diagnostics.firstEventType = diagnostics.firstEventType || event.event;
    diagnostics.lastEventType = event.event;
    diagnostics.lastEventPreview = truncate(event.data, 160);

    const delta = parseEvent(event);

    if (delta) {
      content += delta;
    }
  }

  return {
    buffer,
    content
  };
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSseEvent(chunkText: string): SseEvent | null {
  const lines = chunkText.split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n")
  };
}

function parseChatCompletionsStreamEvent(event: SseEvent, onDelta: (text: string) => void): string {
  const chunk = JSON.parse(event.data) as OpenAIStreamChunk;
  const delta = chunk.choices?.[0]?.delta?.content ?? "";

  if (delta) {
    onDelta(delta);
  }

  return delta;
}

function parseResponsesStreamEvent(event: SseEvent, onDelta: (text: string) => void): string {
  const chunk = JSON.parse(event.data) as ResponsesStreamChunk;

  if (chunk.error?.message) {
    throw new UserFacingError(`请求失败：${chunk.error.message}`);
  }

  const eventType = chunk.type || event.event;
  const delta = extractResponsesStreamDelta(chunk, eventType);

  if (delta) {
    onDelta(delta);
    return delta;
  }

  if ((eventType === "response.completed" || eventType === "response.output_text.done") && chunk.response) {
    return "";
  }

  return "";
}

function extractResponsesText(response: ResponsesApiResponse): string {
  return (response.output ?? [])
    .filter((item) => item.role === "assistant")
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");
}

function buildResponsesBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
  const instructions = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const input = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));

  return {
    model: request.model,
    instructions: instructions || undefined,
    input,
    temperature: request.temperature,
    max_output_tokens: request.maxTokens,
    stream
  };
}

function countMessageCharacters(messages: ChatRequest["messages"]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function createIdleTimeout(timeoutMs: number, onTimeout: () => void): { bump: () => void; clear: () => void } {
  let timeoutId: number | null = null;

  const bump = () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(onTimeout, timeoutMs);
  };

  const clear = () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  bump();

  return {
    bump,
    clear
  };
}

function shouldFallbackToNonStreaming(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  const message = error.message.toLowerCase();

  return message.includes("failed to fetch")
    || message.includes("xmlhttprequest")
    || message.includes("xhr.onerror")
    || message.includes("networkerror")
    || message.includes("load failed")
    || message.includes("cors")
    || message.includes("abort")
    || message.includes("network request failed");
}

function extractResponsesStreamDelta(chunk: ResponsesStreamChunk, eventType: string): string {
  if ((eventType === "response.output_text.delta" || eventType === "output_text.delta") && typeof chunk.delta === "string") {
    return chunk.delta;
  }

  if ((eventType === "response.output_text.done" || eventType === "output_text.done") && typeof chunk.text === "string") {
    return chunk.text;
  }

  const itemText = chunk.item?.content
    ?.filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("") ?? "";

  if (itemText) {
    return itemText;
  }

  return "";
}

function createStreamDiagnostics(apiFormat: ProviderApiFormat, channel: "fetch" | "XMLHttpRequest"): StreamDiagnostics {
  return {
    apiFormat,
    channel,
    eventCount: 0,
    dataEventCount: 0,
    bytesReceived: 0,
    rawChunkCount: 0,
    firstEventType: "(none)",
    lastEventType: "(none)",
    lastEventPreview: "(none)",
    firstChunkPreview: "(none)",
    lastChunkPreview: "(none)",
    trailingBufferPreview: "(none)",
    responseStatus: "(unknown)",
    responseContentType: "(unknown)",
    responseHeaders: "(unavailable)"
  };
}

function buildStreamDebugDetails(diagnostics: StreamDiagnostics) {
  return [
    { label: "接口格式", value: diagnostics.apiFormat },
    { label: "流式通道", value: diagnostics.channel },
    { label: "流式状态码", value: diagnostics.responseStatus },
    { label: "流式 Content-Type", value: diagnostics.responseContentType },
    { label: "流式响应头", value: diagnostics.responseHeaders },
    { label: "流式事件数", value: String(diagnostics.eventCount) },
    { label: "流式数据块数", value: String(diagnostics.dataEventCount) },
    { label: "已收字节", value: String(diagnostics.bytesReceived) },
    { label: "原始块数", value: String(diagnostics.rawChunkCount) },
    { label: "首个事件", value: diagnostics.firstEventType },
    { label: "最后事件", value: diagnostics.lastEventType },
    { label: "最后事件摘要", value: diagnostics.lastEventPreview },
    { label: "首块摘要", value: diagnostics.firstChunkPreview },
    { label: "末块摘要", value: diagnostics.lastChunkPreview },
    { label: "尾部缓冲摘要", value: diagnostics.trailingBufferPreview }
  ];
}

function summarizeResponseHeaders(headers: Headers): string {
  const values: string[] = [];

  headers.forEach((value, key) => {
    values.push(`${key}=${value}`);
  });

  return values.length ? values.join("; ") : "(empty)";
}

function summarizeRawResponseHeaders(rawHeaders: string): string {
  const normalized = rawHeaders
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");

  return normalized || "(empty)";
}

function looksLikeJsonResponse(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/json");
}

function combineStreamErrors(fetchError: unknown, xhrError: unknown): Error {
  const primary = appendDebugDetails(fetchError, [
    { label: "fetch 通道结果", value: "失败" }
  ]);

  return appendDebugDetails(primary, [
    { label: "XHR 通道结果", value: xhrError instanceof Error ? xhrError.message : String(xhrError) }
  ]);
}

function buildIdleTimeoutMessage(timeoutMs: number, diagnostics: StreamDiagnostics): string {
  if (diagnostics.bytesReceived > 0 && diagnostics.eventCount === 0) {
    return `流式请求超过 ${timeoutMs} 毫秒仍未完成；已收到原始数据，但还没有解析出 SSE 事件。`;
  }

  if (diagnostics.eventCount > 0) {
    return `流式请求超过 ${timeoutMs} 毫秒仍未完成；已收到部分流式事件，但连接没有正常结束。`;
  }

  return `流式请求超过 ${timeoutMs} 毫秒仍未完成。`;
}
