import type { ProviderConfig } from "../settings/types";
import { UserFacingError } from "../utils/errors";
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

export class OpenAICompatibleProvider implements AiProvider {
  id = "openai-compatible";
  name = "OpenAI Compatible";

  async sendChat(request: ChatRequest): Promise<ChatResponse> {
    const data = await this.postChatCompletion(request);
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new UserFacingError("模型返回为空。");
    }

    return {
      content,
      raw: data
    };
  }

  async testConnection(config: ProviderConfig, timeoutMs: number): Promise<TestResult> {
    if (!config.defaultModel.trim()) {
      return {
        ok: false,
        message: "请先填写模型名。"
      };
    }

    try {
      await this.sendChat({
        config,
        model: config.defaultModel,
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
        message: "连接成功。"
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

    if (!config.apiKey.trim()) {
      throw new UserFacingError("请先配置 API Key。");
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
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: false
      }
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error?.message ?? response.text ?? `HTTP ${response.status}`;
      throw new UserFacingError(`请求失败：${message}`);
    }

    return response.json;
  }
}
