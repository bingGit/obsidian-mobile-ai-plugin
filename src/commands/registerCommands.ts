import { Notice } from "obsidian";

import type MobileAiCompanionPlugin from "../main";

export function registerCommands(plugin: MobileAiCompanionPlugin): void {
  plugin.addCommand({
    id: "open-mobile-ai-chat",
    name: "Open Mobile AI chat",
    callback: async () => {
      await plugin.activateChatView();
    }
  });

  plugin.addCommand({
    id: "summarize-current-note",
    name: "Summarize current note with Mobile AI",
    callback: async () => {
      const view = await plugin.activateChatView();
      view?.addCurrentFileAttachment();
      view?.setPrompt("请总结当前笔记，保留关键观点、行动项和可复用结论。");
    }
  });

  plugin.addCommand({
    id: "rewrite-selection",
    name: "Rewrite selected text with Mobile AI",
    callback: async () => {
      const view = await plugin.activateChatView();
      view?.addSelectionAttachment();
      view?.setPrompt("请改写选中文本，让表达更清晰自然，并保持原意。");
    }
  });

  plugin.addCommand({
    id: "extract-todos",
    name: "Extract todos from current note with Mobile AI",
    callback: async () => {
      const view = await plugin.activateChatView();
      view?.addCurrentFileAttachment();
      view?.setPrompt("请从当前笔记中提炼待办事项，按 Markdown 任务列表输出。");
    }
  });

  plugin.addCommand({
    id: "mobile-ai-privacy-note",
    name: "Show Mobile AI privacy note",
    callback: () => {
      new Notice("Mobile AI 只会发送你输入和明确添加的上下文到已配置 API。不会默认上传整个 vault。", 8000);
    }
  });
}
