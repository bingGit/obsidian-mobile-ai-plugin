import type { App, TFile } from "obsidian";

import type { MobileAiSettings } from "../settings/types";
import { UserFacingError } from "../utils/errors";
import { extractFileMentions, stripMentionTokens } from "./MentionParser";
import type { BuiltContext, ContextAttachment } from "./types";

export class ContextBuilder {
  constructor(
    private readonly app: App,
    private readonly settings: MobileAiSettings
  ) {}

  async build(userInput: string, attachments: ContextAttachment[]): Promise<BuiltContext> {
    const warnings: string[] = [];
    const normalizedAttachments = await this.resolveMentionAttachments(userInput, attachments, warnings);
    const limitedAttachments = normalizedAttachments.slice(0, this.settings.maxContextFiles);

    if (normalizedAttachments.length > limitedAttachments.length) {
      warnings.push(`已限制为最多 ${this.settings.maxContextFiles} 个上下文文件。`);
    }

    const parts: string[] = [];
    let characterCount = 0;

    for (const attachment of limitedAttachments) {
      const raw = await this.readAttachment(attachment);
      const clipped = clip(raw, this.settings.maxFileCharacters);

      if (clipped.wasClipped) {
        warnings.push(`${attachment.label} 已截断到 ${this.settings.maxFileCharacters} 字符。`);
      }

      const block = formatAttachment(attachment, clipped.content);

      if (characterCount + block.length > this.settings.maxTotalContextCharacters) {
        warnings.push(`总上下文已达到 ${this.settings.maxTotalContextCharacters} 字符限制，后续附件未加入。`);
        break;
      }

      parts.push(block);
      characterCount += block.length;
    }

    const requestText = stripMentionTokens(userInput) || userInput.trim();
    const prompt = parts.length
      ? `<context>\n${parts.join("\n\n")}\n</context>\n\n<user_request>\n${requestText}\n</user_request>`
      : requestText;

    return {
      prompt,
      attachments: limitedAttachments,
      warnings,
      characterCount: characterCount + requestText.length
    };
  }

  private async resolveMentionAttachments(
    userInput: string,
    attachments: ContextAttachment[],
    warnings: string[]
  ): Promise<ContextAttachment[]> {
    const existingPaths = new Set(attachments.map((attachment) => attachment.path).filter(Boolean));
    const resolved = [...attachments];

    for (const mention of extractFileMentions(userInput)) {
      if (existingPaths.has(mention.path)) {
        continue;
      }

      const file = this.app.vault.getAbstractFileByPath(mention.path);

      if (!isMarkdownFile(file)) {
        warnings.push(`未找到引用文件：${mention.path}`);
        continue;
      }

      resolved.push({
        id: `mention-${file.path}`,
        type: "file",
        path: file.path,
        label: file.basename,
        addedAt: Date.now()
      });
      existingPaths.add(file.path);
    }

    return resolved;
  }

  private async readAttachment(attachment: ContextAttachment): Promise<string> {
    if (attachment.content !== undefined) {
      return attachment.content;
    }

    if (!attachment.path) {
      throw new UserFacingError(`${attachment.label} 缺少文件路径。`);
    }

    const file = this.app.vault.getAbstractFileByPath(attachment.path);

    if (!isMarkdownFile(file)) {
      throw new UserFacingError(`文件不存在或不是 Markdown 文件：${attachment.path}`);
    }

    return this.app.vault.read(file);
  }
}

function formatAttachment(attachment: ContextAttachment, content: string): string {
  if (attachment.type === "selection") {
    return `<selection path="${attachment.path ?? ""}" label="${attachment.label}">\n${content}\n</selection>`;
  }

  return `<file path="${attachment.path ?? attachment.label}" type="${attachment.type}">\n${content}\n</file>`;
}

function clip(content: string, maxCharacters: number): { content: string; wasClipped: boolean } {
  if (content.length <= maxCharacters) {
    return {
      content,
      wasClipped: false
    };
  }

  return {
    content: `${content.slice(0, maxCharacters)}\n\n[内容已截断]`,
    wasClipped: true
  };
}

function isMarkdownFile(file: unknown): file is TFile {
  return Boolean(file && typeof file === "object" && "extension" in file && file.extension === "md");
}
