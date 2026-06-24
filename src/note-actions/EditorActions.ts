import { MarkdownView, Notice, type App, type Editor, type TFile } from "obsidian";

import type { ContextAttachment } from "../context/types";
import { UserFacingError } from "../utils/errors";

export class EditorActions {
  constructor(private readonly app: App) {}

  getActiveEditor(): Editor | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
  }

  getCurrentFileAttachment(): ContextAttachment | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;

    if (!file) {
      return null;
    }

    return {
      id: `current-file-${file.path}`,
      type: "current-file",
      path: file.path,
      label: file.basename,
      addedAt: Date.now()
    };
  }

  getSelectionAttachment(): ContextAttachment | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selectedText = view?.editor.getSelection();

    if (!view?.file || !selectedText?.trim()) {
      return null;
    }

    return {
      id: `selection-${Date.now()}`,
      type: "selection",
      path: view.file.path,
      label: `${view.file.basename} 选中文本`,
      content: selectedText,
      addedAt: Date.now()
    };
  }

  insertAtCursor(content: string): void {
    const editor = this.requireEditor();
    editor.replaceRange(content, editor.getCursor());
  }

  replaceSelection(content: string): void {
    const editor = this.requireEditor();

    if (!editor.getSelection()) {
      throw new UserFacingError("当前没有选中文本。");
    }

    editor.replaceSelection(content);
  }

  async appendToCurrentFile(content: string): Promise<void> {
    const file = this.requireCurrentFile();
    const existing = await this.app.vault.read(file);
    const separator = existing.trimEnd().length ? "\n\n" : "";
    await this.app.vault.modify(file, `${existing.trimEnd()}${separator}${content}\n`);
  }

  async copyToClipboard(content: string): Promise<void> {
    await navigator.clipboard.writeText(content);
    new Notice("已复制。");
  }

  hasEditor(): boolean {
    return this.getActiveEditor() !== null;
  }

  private requireEditor(): Editor {
    const editor = this.getActiveEditor();

    if (!editor) {
      throw new UserFacingError("没有活动编辑器。");
    }

    return editor;
  }

  private requireCurrentFile(): TFile {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;

    if (!file) {
      throw new UserFacingError("没有当前文件。");
    }

    return file;
  }
}
