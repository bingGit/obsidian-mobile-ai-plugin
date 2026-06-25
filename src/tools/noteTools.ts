import { MarkdownView, Notice, TFile, type App } from "obsidian";

import { UserFacingError } from "../utils/errors";
import type { Tool, ToolCall } from "../providers/types";

export interface ToolExecutionResult {
  // 工具执行结果, 序列化后塞进 role:"tool" 的 message.content。
  // 用结构化字符串方便 AI 解析, 不引入 JSON 解析复杂度。
  resultText: string;
  // 简短摘要, 用于在 chat UI 上显示 "🔧 read_file foo.md (success)"
  summary: string;
  // 工具结果是否代表成功。
  ok: boolean;
}

// 工具执行上下文, 由 ChatController 注入。
// app 用于读/写文件; onUserNotice 用于在长任务时弹进度。
export interface ToolExecutionContext {
  app: App;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
) => Promise<ToolExecutionResult>;

// 工具注册表: 名字 -> schema + executor。
// 顺序就是传给 AI 的 tools 数组顺序, 也会是 AI 在 description 里看到的顺序。
export const NOTE_TOOLS: Array<Tool & { execute: ToolExecutor }> = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the full content of a file in the vault. Use path='.' to read the file the user is currently editing. Returns the raw text including any frontmatter.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the vault root, e.g. 'notes/foo.md'. Use '.' for the currently active file."
          }
        },
        required: ["path"]
      }
    },
    execute: executeReadFile
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Overwrite a file in the vault with new content. Destructive: replaces the entire file. Prefer this only when the user explicitly asks to rewrite, replace, or overwrite a file. To add to a file, use append_to_file instead.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the vault root. Use '.' for the currently active file."
          },
          content: {
            type: "string",
            description:
              "The complete new content for the file."
          }
        },
        required: ["path", "content"]
      }
    },
    execute: executeWriteFile
  },
  {
    type: "function",
    function: {
      name: "append_to_file",
      description:
        "Append text to the end of a file in the vault, separated by a blank line if the file does not already end with one. Use this when the user asks to 'add N words/chars' or 'continue writing'.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the vault root. Use '.' for the currently active file."
          },
          content: {
            type: "string",
            description:
              "The text to append. Do not include leading newlines; the tool handles spacing."
          }
        },
        required: ["path", "content"]
      }
    },
    execute: executeAppendToFile
  }
];

// 只暴露给 ChatRequest 的 schema 部分 (没有 execute 函数)。
export function getNoteToolsSchema(): Tool[] {
  return NOTE_TOOLS.map(({ type, function: fn }) => ({ type, function: fn }));
}

const toolExecutors = new Map<string, ToolExecutor>(
  NOTE_TOOLS.map((t) => [t.function.name, t.execute])
);

export async function executeToolCall(
  toolCall: ToolCall,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const executor = toolExecutors.get(toolCall.function.name);

  if (!executor) {
    return {
      ok: false,
      resultText: `Error: unknown tool '${toolCall.function.name}'`,
      summary: `unknown tool ${toolCall.function.name}`
    };
  }

  let args: Record<string, unknown> = {};
  try {
    args = toolCall.function.arguments
      ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>)
      : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      resultText: `Error: tool arguments are not valid JSON: ${message}`,
      summary: `bad arguments for ${toolCall.function.name}`
    };
  }

  try {
    return await executor(args, ctx);
  } catch (error) {
    if (error instanceof UserFacingError) {
      return {
        ok: false,
        resultText: `Error: ${error.message}`,
        summary: `${toolCall.function.name} failed`
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      resultText: `Error: ${message}`,
      summary: `${toolCall.function.name} failed`
    };
  }
}

// 解析 path: "." 走当前文件, 其它的按 vault 相对路径解析。
function resolveTargetFile(app: App, path: string): TFile | null {
  const trimmed = path.trim();

  if (trimmed === "" || trimmed === ".") {
    return app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
  }

  // 去掉开头的 "/" 防止误用绝对路径。
  const normalized = trimmed.replace(/^\/+/, "");
  const abstract = app.vault.getAbstractFileByPath(normalized);

  if (abstract instanceof TFile) {
    return abstract;
  }
  return null;
}

function describeFile(file: TFile): string {
  return file.path;
}

async function executeReadFile(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const path = typeof args.path === "string" ? args.path : "";
  const file = resolveTargetFile(ctx.app, path);

  if (!file) {
    return {
      ok: false,
      resultText: `Error: file not found at path '${path || "."}'`,
      summary: `read_file ${path || "(current)"} — not found`
    };
  }

  const content = await ctx.app.vault.read(file);
  return {
    ok: true,
    resultText: content,
    summary: `read_file ${describeFile(file)} (${content.length} chars)`
  };
}

async function executeWriteFile(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const path = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";

  if (content === "" && path === "") {
    return {
      ok: false,
      resultText: "Error: both path and content are empty",
      summary: "write_file — empty args"
    };
  }

  const file = resolveTargetFile(ctx.app, path);

  if (!file) {
    return {
      ok: false,
      resultText: `Error: file not found at path '${path || "."}'. Use append_to_file if you meant to create a new file.`,
      summary: `write_file ${path || "(current)"} — not found`
    };
  }

  // 优先用 editor.setValue 以支持 Cmd+Z 撤销; 只在 active view 不是这个文件时才走 vault.modify。
  const view = ctx.app.workspace.getActiveViewOfType(MarkdownView);
  if (view && view.file === file) {
    view.editor.setValue(content);
  } else {
    await ctx.app.vault.modify(file, content);
  }

  new Notice(`已写入 ${describeFile(file)} (${content.length} 字符)`, 4000);
  return {
    ok: true,
    resultText: `Wrote ${content.length} characters to ${describeFile(file)}.`,
    summary: `write_file ${describeFile(file)} (${content.length} chars)`
  };
}

async function executeAppendToFile(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const path = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";

  if (content === "") {
    return {
      ok: false,
      resultText: "Error: content is empty",
      summary: "append_to_file — empty content"
    };
  }

  const file = resolveTargetFile(ctx.app, path);

  if (!file) {
    return {
      ok: false,
      resultText: `Error: file not found at path '${path || "."}'`,
      summary: `append_to_file ${path || "(current)"} — not found`
    };
  }

  const existing = await ctx.app.vault.read(file);
  const trimmedEnd = existing.trimEnd();
  const separator = trimmedEnd.length ? "\n\n" : "";
  const newContent = `${trimmedEnd}${separator}${content}\n`;

  const view = ctx.app.workspace.getActiveViewOfType(MarkdownView);
  if (view && view.file === file) {
    view.editor.setValue(newContent);
  } else {
    await ctx.app.vault.modify(file, newContent);
  }

  new Notice(`已追加 ${content.length} 字符到 ${describeFile(file)}`, 4000);
  return {
    ok: true,
    resultText: `Appended ${content.length} characters to ${describeFile(file)}.`,
    summary: `append_to_file ${describeFile(file)} (+${content.length} chars)`
  };
}
