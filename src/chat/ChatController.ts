import type MobileAiCompanionPlugin from "../main";
import { ContextBuilder } from "../context/ContextBuilder";
import type { ContextAttachment } from "../context/types";
import type { ChatMessage } from "../providers/types";
import type { ProviderConfig } from "../settings/types";
import { UserFacingError } from "../utils/errors";
import type { ChatSession } from "./ChatStore";

export interface SendInput {
  session: ChatSession;
  provider: ProviderConfig;
  model: string;
  userInput: string;
  attachments: ContextAttachment[];
  onDelta?: (text: string) => void;
}

export interface SendResult {
  content: string;
  warnings: string[];
  characterCount: number;
  resolvedAttachments: ContextAttachment[];
}

export class ChatController {
  private activeRequestId = 0;

  constructor(private readonly plugin: MobileAiCompanionPlugin) {}

  cancel(): void {
    this.activeRequestId += 1;
  }

  async send(input: SendInput): Promise<SendResult> {
    const requestId = this.activeRequestId + 1;
    this.activeRequestId = requestId;

    if (!input.userInput.trim()) {
      throw new UserFacingError("请输入问题。");
    }

    if (!input.model.trim()) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    const context = await new ContextBuilder(this.plugin.app, this.plugin.settings)
      .build(input.userInput, input.attachments);
    const provider = this.plugin.providerRegistry.createProvider(input.provider);
    const request = {
      config: input.provider,
      model: input.model,
      messages: this.buildMessages(input.session, context.prompt),
      temperature: input.provider.temperature,
      maxTokens: input.provider.maxTokens,
      timeoutMs: this.plugin.settings.requestTimeoutMs
    };
    const response = input.provider.stream && provider.streamChat
      ? await provider.streamChat(request, (delta) => {
        if (requestId === this.activeRequestId) {
          input.onDelta?.(delta);
        }
      })
      : await provider.sendChat(request);

    if (requestId !== this.activeRequestId) {
      throw new UserFacingError("请求已取消。");
    }

    return {
      content: response.content,
      warnings: context.warnings,
      characterCount: context.characterCount,
      resolvedAttachments: context.attachments
    };
  }

  private buildMessages(session: ChatSession, prompt: string): ChatMessage[] {
    const historyMessages = session.messages.slice(-12);

    if (historyMessages.at(-1)?.role === "user") {
      historyMessages.pop();
    }

    const history: ChatMessage[] = historyMessages
      .map((message) => ({
        role: message.role,
        content: message.content
      }));

    return [
      {
        role: "system",
        content: "You are an AI assistant inside Obsidian mobile. Answer clearly in the user's language. Only use vault context that is explicitly provided."
      },
      ...history,
      {
        role: "user",
        content: prompt
      }
    ];
  }
}
