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
      name: "list_vault_structure",
      description:
        "Inspect the markdown folder structure of the vault. Use this when the user asks where a note should be filed, how the vault is organized, or which folder may fit a note. Returns folder counts and sample note paths only; it does not read every note.",
      parameters: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description:
              "Optional folder path relative to the vault root. Empty means scan the whole vault."
          },
          max_depth: {
            type: "number",
            description:
              "How many folder levels to include from the root. Default 3, maximum 6."
          },
          include_files: {
            type: "boolean",
            description:
              "Whether to include a few sample markdown file paths for each folder. Default true."
          },
          max_entries: {
            type: "number",
            description:
              "Maximum number of folder entries to return. Default 120, maximum 300."
          }
        }
      }
    },
    execute: executeListVaultStructure
  },
  {
    type: "function",
    function: {
      name: "search_vault_notes",
      description:
        "Search markdown notes by path, title, headings, and optional content snippets. Use this to find notes similar to a referenced file before recommending a destination folder.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search terms, usually keywords extracted from the user's note or request."
          },
          root: {
            type: "string",
            description:
              "Optional folder path to limit the search. Empty means the whole vault."
          },
          limit: {
            type: "number",
            description:
              "Maximum result count. Default 8, maximum 20."
          },
          search_content: {
            type: "boolean",
            description:
              "Whether to inspect note content snippets in addition to paths/headings. Default true."
          },
          max_files: {
            type: "number",
            description:
              "Maximum number of markdown files to inspect when search_content is true. Default 250, maximum 500."
          }
        },
        required: ["query"]
      }
    },
    execute: executeSearchVaultNotes
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

function normalizeVaultPath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function getMarkdownFilesUnder(app: App, root: string): TFile[] {
  const normalizedRoot = normalizeVaultPath(root);
  const prefix = normalizedRoot ? `${normalizedRoot}/` : "";

  return app.vault
    .getMarkdownFiles()
    .filter((file) => !prefix || file.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function getFolderPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function boolArg(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

interface FolderSummary {
  path: string;
  directFiles: number;
  totalFiles: number;
  samples: string[];
}

function ensureFolderSummary(summaries: Map<string, FolderSummary>, path: string): FolderSummary {
  const existing = summaries.get(path);

  if (existing) {
    return existing;
  }

  const created: FolderSummary = {
    path,
    directFiles: 0,
    totalFiles: 0,
    samples: []
  };
  summaries.set(path, created);
  return created;
}

function relativeFolderDepth(folderPath: string, root: string): number {
  const normalizedRoot = normalizeVaultPath(root);
  const relative = normalizedRoot && folderPath.startsWith(`${normalizedRoot}/`)
    ? folderPath.slice(normalizedRoot.length + 1)
    : folderPath;

  if (!relative) {
    return 0;
  }

  return relative.split("/").length;
}

async function executeListVaultStructure(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const root = typeof args.root === "string" ? normalizeVaultPath(args.root) : "";
  const maxDepth = clampNumber(args.max_depth, 3, 1, 6);
  const maxEntries = clampNumber(args.max_entries, 120, 20, 300);
  const includeFiles = boolArg(args.include_files, true);
  const files = getMarkdownFilesUnder(ctx.app, root);

  if (root && files.length === 0) {
    return {
      ok: false,
      resultText: `Error: no markdown files found under folder '${root}'.`,
      summary: `list_vault_structure ${root} - empty`
    };
  }

  const summaries = new Map<string, FolderSummary>();
  ensureFolderSummary(summaries, root);

  for (const file of files) {
    const folderPath = getFolderPath(file.path);
    const directSummary = ensureFolderSummary(summaries, folderPath);
    directSummary.directFiles += 1;

    if (directSummary.samples.length < 4) {
      directSummary.samples.push(file.path);
    }

    const parts = folderPath ? folderPath.split("/") : [];
    for (let index = 0; index <= parts.length; index++) {
      const ancestor = parts.slice(0, index).join("/");

      if (root && ancestor && ancestor !== root && !ancestor.startsWith(`${root}/`)) {
        continue;
      }

      const summary = ensureFolderSummary(summaries, ancestor);
      summary.totalFiles += 1;
    }
  }

  const entries = [...summaries.values()]
    .filter((summary) => relativeFolderDepth(summary.path, root) <= maxDepth)
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, maxEntries);

  const lines = [
    "Vault markdown structure",
    `Root: ${root || "(vault root)"}`,
    `Markdown files under root: ${files.length}`,
    `Returned folders: ${entries.length}${summaries.size > entries.length ? ` of ${summaries.size}` : ""}`,
    "",
    "Folders:"
  ];

  for (const entry of entries) {
    lines.push(`- ${entry.path || "(vault root)"} (direct md: ${entry.directFiles}, total md: ${entry.totalFiles})`);

    if (includeFiles && entry.samples.length) {
      lines.push(`  samples: ${entry.samples.join("; ")}`);
    }
  }

  return {
    ok: true,
    resultText: lines.join("\n"),
    summary: `list_vault_structure ${root || "(root)"} (${entries.length} folders)`
  };
}

interface SearchResult {
  file: TFile;
  score: number;
  title: string;
  headings: string[];
  snippet: string;
}

function getSearchTerms(query: string): string[] {
  const normalized = query
    .toLowerCase()
    .replace(/[，。、“”‘’：；！？（）【】《》]/g, " ")
    .replace(/[_\-/#|]+/g, " ");
  const terms = normalized
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);

  if (normalized.trim().length >= 2) {
    terms.unshift(normalized.trim());
  }

  return [...new Set(terms)].slice(0, 12);
}

function scoreText(value: string, terms: string[], weight: number): number {
  const normalized = value.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (normalized.includes(term)) {
      score += weight;
    }
  }

  return score;
}

function extractTitle(content: string, fallback: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || fallback;
}

function extractHeadings(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /^#{1,3}\s+/.test(line))
    .slice(0, 5)
    .map((line) => line.replace(/^#{1,3}\s+/, "").trim());
}

function extractSnippet(content: string, terms: string[]): string {
  const normalized = content.toLowerCase();
  const firstMatch = terms
    .map((term) => normalized.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const start = firstMatch === undefined ? 0 : Math.max(0, firstMatch - 90);
  const snippet = content
    .slice(start, start + 240)
    .replace(/\s+/g, " ")
    .trim();

  return snippet;
}

async function executeSearchVaultNotes(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";

  if (!query) {
    return {
      ok: false,
      resultText: "Error: query is required.",
      summary: "search_vault_notes - empty query"
    };
  }

  const root = typeof args.root === "string" ? normalizeVaultPath(args.root) : "";
  const limit = clampNumber(args.limit, 8, 1, 20);
  const maxFiles = clampNumber(args.max_files, 250, 20, 500);
  const searchContent = boolArg(args.search_content, true);
  const terms = getSearchTerms(query);
  const files = getMarkdownFilesUnder(ctx.app, root);
  const candidates = files
    .map((file) => ({
      file,
      pathScore: scoreText(file.path, terms, 18) + scoreText(file.basename, terms, 30)
    }))
    .sort((a, b) => b.pathScore - a.pathScore || a.file.path.localeCompare(b.file.path))
    .slice(0, searchContent ? maxFiles : files.length);
  const results: SearchResult[] = [];

  for (const candidate of candidates) {
    let content = "";
    let title = candidate.file.basename;
    let headings: string[] = [];
    let snippet = "";
    let contentScore = 0;

    if (searchContent) {
      content = await ctx.app.vault.cachedRead(candidate.file);
      title = extractTitle(content, candidate.file.basename);
      headings = extractHeadings(content);
      contentScore += scoreText(title, terms, 32);
      contentScore += scoreText(headings.join("\n"), terms, 24);
      contentScore += scoreText(content.slice(0, 8000), terms, 10);
      snippet = extractSnippet(content, terms);
    }

    const score = candidate.pathScore + contentScore;

    if (score > 0) {
      results.push({
        file: candidate.file,
        score,
        title,
        headings,
        snippet
      });
    }
  }

  results.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const limited = results.slice(0, limit);
  const lines = [
    "Vault note search",
    `Query: ${query}`,
    `Root: ${root || "(vault root)"}`,
    `Markdown files considered: ${candidates.length} of ${files.length}`,
    `Results: ${limited.length}`,
    ""
  ];

  for (const result of limited) {
    lines.push(`- ${result.file.path} (score: ${result.score})`);
    lines.push(`  title: ${result.title}`);

    if (result.headings.length) {
      lines.push(`  headings: ${result.headings.join(" | ")}`);
    }

    if (result.snippet) {
      lines.push(`  snippet: ${result.snippet}`);
    }
  }

  return {
    ok: true,
    resultText: lines.join("\n"),
    summary: `search_vault_notes "${query.slice(0, 24)}" (${limited.length} results)`
  };
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
