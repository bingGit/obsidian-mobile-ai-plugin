import { MarkdownView } from "obsidian";

import type MobileAiCompanionPlugin from "../main";
import { ContextBuilder } from "../context/ContextBuilder";
import type { ContextAttachment } from "../context/types";
import type { ChatMessage, Tool, ToolCall } from "../providers/types";
import type { ProviderConfig } from "../settings/types";
import { UserFacingError } from "../utils/errors";
import { executeToolCall, getNoteToolsSchema, type ToolExecutionContext, type ToolExecutionResult } from "../tools/noteTools";
import type { ChatSession } from "./ChatStore";

export interface SendInput {
  session: ChatSession;
  provider: ProviderConfig;
  model: string;
  userInput: string;
  attachments: ContextAttachment[];
  onDelta?: (text: string) => void;
  onStatus?: (message: string) => void;
  // 工具执行后的回调, 用于在 chat UI 渲染 "🔧 read_file foo.md" 这种小标签。
  // 不会出现在最终的 message content 里, 纯 UI 用途。
  onToolCall?: (call: ToolCall, result: ToolExecutionResult) => void;
}

export interface SendResult {
  content: string;
  warnings: string[];
  characterCount: number;
  resolvedAttachments: ContextAttachment[];
  // 这次发送过程中 AI 实际调用的工具记录, 用于回写到 session 消息里持久化。
  toolCalls: Array<{ call: ToolCall; result: ToolExecutionResult }>;
}

// 单次发送里 AI 连续调用工具的硬上限。
// 防止 AI 写"先 read 再 read 再 read 再 write"这种循环把用户 vault 写穿。
const MAX_TOOL_ITERATIONS = 5;

export class ChatController {
  private activeRequestId = 0;
  private activeAbortController: AbortController | null = null;

  constructor(private readonly plugin: MobileAiCompanionPlugin) {}

  cancel(): void {
    this.activeRequestId += 1;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
  }

  async send(input: SendInput): Promise<SendResult> {
    if (!input.userInput.trim()) {
      throw new UserFacingError("请输入问题。");
    }

    if (!input.model.trim()) {
      throw new UserFacingError("请先选择或填写模型。");
    }

    const requestId = this.activeRequestId + 1;
    this.activeRequestId = requestId;
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const context = await new ContextBuilder(this.plugin.app, this.plugin.settings)
      .build(input.userInput, input.attachments);
    const provider = this.plugin.providerRegistry.createProvider(input.provider);
    const baseMessages = this.buildMessages(input.session, context.prompt, input.provider.apiFormat);
    const tools = getNoteToolsSchema();

    const ctx: ToolExecutionContext = { app: this.plugin.app };
    const allToolCalls: Array<{ call: ToolCall; result: ToolExecutionResult }> = [];

    // 用可变 messages 数组, 每次 AI 调完工具就把结果回灌进去, 再发一次。
    // 终止条件: AI 这一轮不再调任何 tool, 或者达到 MAX_TOOL_ITERATIONS。
    let messages: ChatMessage[] = baseMessages;
    let finalContent = "";

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (requestId !== this.activeRequestId || abortController.signal.aborted) {
          throw new UserFacingError("请求已取消。");
        }

        const request = {
          config: input.provider,
          model: input.model,
          messages,
          temperature: input.provider.temperature,
          maxTokens: input.provider.maxTokens,
          timeoutMs: this.plugin.settings.requestTimeoutMs,
          tools,
          onStatus: input.onStatus,
          signal: abortController.signal
        };

        const response = input.provider.stream && provider.streamChat
          ? await provider.streamChat(request, (delta) => {
            if (requestId === this.activeRequestId && !abortController.signal.aborted) {
              input.onDelta?.(delta);
            }
          })
          : await provider.sendChat(request);

        if (requestId !== this.activeRequestId || abortController.signal.aborted) {
          throw new UserFacingError("请求已取消。");
        }

        // 累加这一轮的文本内容。OpenAI 流式 API 把每轮的 content 完整返回一次, onDelta 也会
        // 同步把同样内容打给 ChatView, 这边把多轮的 content 累加成总文本, 防止最后一轮
        // 把前面的覆盖掉。
        finalContent += response.content;

        // 串行执行工具: 同一次响应里的多个 tool_calls 按顺序串行处理, 防止并行写同一文件冲突。
        // (Phase 1 不做并行 tool, 即使 AI 一次返回多个 call, 我们也一个一个来。)
        const toolCalls = response.toolCalls ?? [];

        if (toolCalls.length === 0) {
          break;
        }

        // 把 AI 这一轮的 assistant 消息带 tool_calls 推进 messages, 让 OpenAI 把工具结果关联回去。
        messages = [
          ...messages,
          {
            role: "assistant",
            content: response.content,
            tool_calls: toolCalls
          }
        ];

        for (const call of toolCalls) {
          if (requestId !== this.activeRequestId || abortController.signal.aborted) {
            throw new UserFacingError("请求已取消。");
          }

          const result = await executeToolCall(call, ctx);
          allToolCalls.push({ call, result });
          input.onToolCall?.(call, result);
          messages = [
            ...messages,
            {
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: result.resultText
            }
          ];
        }
        // 继续循环, 让 AI 基于工具结果生成下一轮。
      }
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }

    return {
      content: finalContent,
      warnings: context.warnings,
      characterCount: context.characterCount,
      resolvedAttachments: context.attachments,
      toolCalls: allToolCalls
    };
  }

  private buildMessages(session: ChatSession, prompt: string, apiFormat: string | undefined): ChatMessage[] {
    const historyMessages = session.messages.slice(-12);

    if (historyMessages.at(-1)?.role === "user") {
      historyMessages.pop();
    }

    const history: ChatMessage[] = historyMessages
      .map((message) => ({
        role: message.role,
        content: message.content
      }));

    const systemContent = buildSystemPrompt(this.plugin, apiFormat);

    return [
      {
        role: "system",
        content: systemContent
      },
      ...history,
      {
        role: "user",
        content: prompt
      }
    ];
  }
}

// 提取出来的 system prompt 构造: 根据当前 active file 和 apiFormat 给出对应的引导。
// apiFormat 用来决定要不要提 "如果工具不可用就只用文本回答" 这类 fallback 措辞。
function buildSystemPrompt(plugin: MobileAiCompanionPlugin, apiFormat: string | undefined): string {
  const active = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const activePath = active?.file?.path;
  const activeLineCount = active?.editor ? active.editor.lineCount() : 0;

  const base = "You are an AI assistant inside Obsidian mobile. Answer clearly in the user's language. Only use vault context that is explicitly provided or explicitly requested through available vault tools.";

  const toolGuidance = [
    "",
    "## Tools",
    "You have access to vault file tools. Decide when to use them based on the user's instruction; for plain questions or discussion, just answer in text without calling tools.",
    activePath ? `- Current active file: '${activePath}' (~${activeLineCount} lines). Use path='.' for it when appropriate.` : "- There may be no active file; use explicit vault-relative paths from the user's request when needed.",
    "",
    "When the user asks where a note should be placed, filed, moved, categorized, or whether it belongs in a folder:",
    "- Inspect the referenced note content if it was not already provided.",
    "- Use list_vault_structure to understand the user's folder system.",
    "- Use search_vault_notes with keywords from the note to find similar notes.",
    "- Recommend 1-3 candidate folders with reasons. Do not move or rewrite the file unless the user explicitly asks.",
    "",
    "When the user asks to modify a file (summarize, rewrite, expand, translate, add content, etc.):",
    "- For destructive operations (write_file, which overwrites), make sure you have read the current content with read_file first unless the user explicitly provided the new full text.",
    "- For additive operations (append_to_file), you typically do not need to read first."
  ].join("\n");

  if (apiFormat === "responses") {
    return base + toolGuidance + "\n\nNote: this provider's tool-calling support may differ; if tools do not work, just answer the user in text describing what you would do.";
  }
  return base + toolGuidance;
}
