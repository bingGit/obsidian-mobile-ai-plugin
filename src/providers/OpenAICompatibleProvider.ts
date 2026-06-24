import type { ProviderConfig } from "../settings/types";
import { appendDebugDetails, RetryableNetworkError, UserFacingError } from "../utils/errors";
import { joinChatCompletionsUrl, requestJson } from "../utils/request";
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

export class OpenAICompatibleProvider implements AiProvider {
  id = "openai-compatible";
  name = "OpenAI Compatible";

  async sendChat(request: ChatRequest): Promise<ChatResponse> {
    const data = await this.postChatCompletionWithRetry(request);
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new UserFacingError("模型返回为空。");
    }

    return {
      content,
      raw: data
    };
  }

  async streamChat(request: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse> {
    try {
      const content = await this.streamChatCompletion(request, onDelta);

      if (!content.trim()) {
        throw new UserFacingError("模型返回为空。");
      }

      return {
        content
      };
    } catch (error) {
      if (shouldFallbackToNonStreaming(error)) {
        request.onStatus?.("流式连接不可用，已自动降级为非流式请求");
        return this.sendChat({
          ...request,
          config: {
            ...request.config,
            stream: false
          }
        });
      }

      throw error;
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
      url: joinChatCompletionsUrl(config.baseUrl),
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
        { label: "请求 URL", value: joinChatCompletionsUrl(config.baseUrl) },
        { label: "模型", value: model },
        { label: "max_tokens", value: String(request.maxTokens) },
        { label: "stream", value: "false" }
      ]);
    }

    return response.json;
  }

  private async streamChatCompletion(request: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    const { config } = request;
    const model = request.model.trim() || resolveModel(config);

    if (!config.apiKey.trim()) {
      throw new UserFacingError("请先配置 API Key。");
    }

    if (!model) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    if (!window.fetch || !window.ReadableStream) {
      return (await this.sendChat({ ...request, config: { ...config, stream: false } })).content;
    }

    const url = joinChatCompletionsUrl(config.baseUrl);
    const body = {
      model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true
    };
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), request.timeoutMs);

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

      if (!response.ok) {
        const text = await response.text();
        throw new UserFacingError(`请求失败：${text || `HTTP ${response.status}`}`, [
          { label: "HTTP 状态", value: String(response.status) },
          { label: "响应摘要", value: truncate(text, 2000) },
          { label: "请求 URL", value: url },
          { label: "模型", value: model },
          { label: "max_tokens", value: String(request.maxTokens) },
          { label: "stream", value: "true" }
        ]);
      }

      if (!response.body) {
        return (await this.sendChat({ ...request, config: { ...config, stream: false } })).content;
      }

      return await readSseStream(response.body, onDelta);
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new UserFacingError(message, [
        { label: "请求方法", value: "POST" },
        { label: "请求 URL", value: url },
        { label: "模型", value: model },
        { label: "max_tokens", value: String(request.maxTokens) },
        { label: "stream", value: "true" },
        { label: "请求体摘要", value: `messages=${request.messages.length}; messageChars=${countMessageCharacters(request.messages)}` },
        { label: "原始错误", value: message }
      ]);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }
}

function resolveModel(config: ProviderConfig): string {
  return config.defaultModel.trim() || config.models.map((model) => model.trim()).find(Boolean) || "";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

async function readSseStream(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const data = trimmed.slice(5).trim();

      if (!data || data === "[DONE]") {
        continue;
      }

      const chunk = JSON.parse(data) as OpenAIStreamChunk;
      const delta = chunk.choices?.[0]?.delta?.content ?? "";

      if (delta) {
        content += delta;
        onDelta(delta);
      }
    }
  }

  return content;
}

function countMessageCharacters(messages: ChatRequest["messages"]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function shouldFallbackToNonStreaming(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  const message = error.message.toLowerCase();

  return message.includes("failed to fetch")
    || message.includes("networkerror")
    || message.includes("load failed")
    || message.includes("cors")
    || message.includes("abort");
}
