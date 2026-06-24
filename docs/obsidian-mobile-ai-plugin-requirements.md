# Obsidian Mobile AI 插件需求文档

## 1. 基本信息

讨论时间：2026-06-24

文档生成时间：2026-06-24

目标平台：Obsidian Mobile，优先 Android，同时兼容 iOS 的插件运行环境

参考项目：Claudian

文档目的：定义一个移动端可用、支持中转站 API Key、支持模型选择、支持 `@文件` 上下文的 Obsidian AI 插件。

## 2. 背景

用户希望在 Obsidian mobile 中获得类似 Claudian 的 AI 协作体验，但当前公开插件不完全符合预期：

- 有些插件支持移动端，但配置、交互或能力不够贴近“知识库 AI 协作”。
- 有些插件接近 Claudian，但依赖桌面 CLI、Node、bash、Claude Code、Codex 等能力，无法在 Obsidian mobile 中完整运行。
- 用户明确需要支持自定义 API Key、自定义中转站、模型选择和 `@文件`。

Claudian 的价值在于把 AI 变成 vault 内的协作者：侧边栏聊天、文件读写、搜索、内联编辑、`@mention`、计划模式、多会话和工具能力。但 Claudian 官方 manifest 标记为 `isDesktopOnly: true`，README 也说明需要 Claude Code CLI / Codex CLI 等桌面运行环境。

因此，本插件不照搬 Claudian 的桌面 agent 模型，而是做一个 mobile-first 的轻量版本：

> 在 Obsidian mobile 里，通过 API 型模型服务实现聊天、文件引用、笔记辅助编辑和上下文问答；不依赖本地 CLI，不执行 bash，不要求桌面环境。

## 3. 产品定位

本插件定位为 Obsidian mobile 中的 AI 协作侧边栏。

它要做的事情：

- 支持用户配置中转站 API Key 和 Base URL。
- 支持选择模型。
- 支持 OpenAI-compatible 接口优先接入。
- 支持在聊天框中通过 `@文件` 引用 vault 内 Markdown 文件。
- 支持引用当前笔记、当前选中文本、最近打开文件。
- 支持 AI 回答后插入、追加或替换当前笔记内容。
- 支持移动端友好的会话界面。
- 支持基础会话历史。

它不做的事情：

- 不依赖 Claude Code CLI、Codex CLI、Opencode CLI。
- 不执行 shell/bash 命令。
- 不访问 vault 外部文件。
- 不做 MCP stdio 本地服务。
- 不在 MVP 做完整 agent 自动改多文件。
- 不把 API Key 上传到插件作者服务器。
- 不承诺离线 AI 能力。

## 4. 目标用户

主要用户：

- 在手机上使用 Obsidian 记录和整理笔记的人。
- 有自己的模型中转站、OpenAI-compatible 网关或第三方 API 服务的人。
- 想在移动端快速问当前笔记、引用文件、整理内容、生成摘要的人。
- 不想被强绑定某一个官方 provider 的用户。

典型场景：

- 在手机上打开一篇笔记，问 AI：“帮我总结当前文件。”
- 在聊天框输入 `@项目A/会议记录.md`，让 AI 根据这篇笔记提炼待办。
- 同时引用多篇文件，让 AI 比较观点。
- 选中一段文字，让 AI 改写、扩写、压缩或转换格式。
- 让 AI 根据一段聊天结果追加到当前笔记末尾。

## 5. 参考 Claudian 的取舍

### 5.1 借鉴的能力

- 侧边栏聊天作为主入口。
- `@mention` 作为上下文添加方式。
- 当前笔记和选中文本可以进入上下文。
- 支持多轮对话。
- 支持会话历史。
- 支持内联编辑或替换选区。
- 支持计划式回答，但不自动执行危险操作。
- 重视隐私说明和数据发送边界。

### 5.2 移动端重做的能力

- Claudian 的 CLI provider 改为 API provider。
- Claudian 的 `@mention` 外部文件、MCP、subagent 改为 MVP 只支持 vault 内文件。
- Claudian 的文件写入工具改为明确的用户确认操作，例如“插入到当前光标”“替换选区”“追加到文件末尾”。
- Claudian 的多标签会话在 MVP 简化为单聊天视图 + 会话列表。

### 5.3 暂不做的能力

- 不做 bash 执行。
- 不做 MCP server 管理。
- 不做 subagent。
- 不做跨目录外部文件读写。
- 不做自动多文件重构。
- 不做后台长期任务。

## 6. MVP 功能范围

### 6.1 插件安装与移动端兼容

插件 manifest 必须设置：

```json
{
  "isDesktopOnly": false
}
```

验收标准：

- 可在 Obsidian Android 中启用。
- 可在 Obsidian iOS 中启用，若 iOS 存在能力差异，需要显示说明。
- 插件无 Node、fs、child_process、shell、native binary 依赖。
- HTTP 请求使用 Obsidian 插件环境可用的网络请求能力。

### 6.2 Provider 与中转站设置

MVP 优先支持 OpenAI-compatible chat completions 接口。

设置项：

- Provider 名称。
- Base URL。
- API Key。
- 默认模型。
- 可选模型列表。
- 温度 `temperature`。
- 最大输出 token。
- 是否开启流式输出。
- 连接测试按钮。

默认示例：

```text
Base URL: https://api.example.com/v1
API Key: sk-...
Model: claude-3-5-sonnet
Endpoint: /chat/completions
```

验收标准：

- 用户可以新增、编辑、删除 provider。
- 用户可以选择默认 provider。
- 用户可以手动输入模型名。
- 用户可以保存多个常用模型。
- 连接测试能返回成功或明确错误。
- API Key 在设置页默认隐藏。

### 6.3 模型选择

聊天界面需要支持快速选择模型。

验收标准：

- 顶部显示当前 provider 和模型。
- 可切换模型。
- 模型列表来自用户配置，MVP 不强依赖远程模型列表接口。
- 会话记录保存当时使用的模型名。

### 6.4 聊天侧边栏

提供一个移动端友好的聊天视图。

入口：

- Ribbon 图标。
- Command Palette。
- 当前文件菜单或编辑器命令。

界面元素：

- 消息列表。
- 输入框。
- 发送按钮。
- 停止生成按钮。
- 模型选择。
- 上下文附件列表。
- 插入到笔记的操作按钮。

验收标准：

- 支持多轮对话。
- 支持流式显示，若流式不可用则降级为一次性返回。
- 支持取消当前请求。
- 网络失败时保留用户输入。
- 重新打开插件后可恢复最近会话。

### 6.5 `@文件` 引用

用户在输入框中键入 `@` 后，弹出文件选择建议。

支持范围：

- Markdown 文件。
- 当前文件。
- 最近打开文件。
- 文件夹内搜索。

语法示例：

```text
总结 @项目A/会议记录.md 并列出待办
对比 @文章/观点1.md 和 @文章/观点2.md
```

验收标准：

- 输入 `@` 后能搜索 vault 内 Markdown 文件。
- 选择文件后以 chip/tag 形式展示，避免长路径撑破手机界面。
- 请求发送前读取文件内容并加入上下文。
- 文件不存在或被移动时，发送前提示。
- 单次最多引用文件数可配置，默认 5 个。
- 单文件最大读取字符数可配置，默认 20,000 字符。

### 6.6 当前笔记上下文

除手动 `@文件` 外，插件应支持快速添加当前笔记。

能力：

- 添加当前文件全文。
- 添加当前选中文本。
- 添加当前标题块。
- 添加当前光标附近若干段落。

MVP 优先级：

1. 当前文件全文。
2. 当前选中文本。
3. 光标附近内容。

验收标准：

- 用户能一键把当前笔记加入上下文。
- 如果当前文件很长，需要提示截断或让用户选择上下文范围。
- 上下文列表可移除单个附件。

### 6.7 AI 对笔记的写入操作

AI 默认只回答，不自动改笔记。写入必须由用户点击确认。

MVP 操作：

- 插入到当前光标。
- 替换当前选区。
- 追加到当前笔记末尾。
- 复制回答。

后续操作：

- 追加到指定文件。
- 新建笔记。
- 基于模板生成笔记。
- diff 预览后应用。

验收标准：

- 所有写入操作都可撤销，或至少符合 Obsidian 编辑器原生撤销行为。
- 替换选区前显示明确按钮。
- 没有活动编辑器时，隐藏插入/替换按钮。
- 写入失败时保留 AI 输出。

### 6.8 快捷指令

提供一组常用 prompt 操作。

MVP 内置指令：

- 总结当前笔记。
- 提炼待办。
- 改写选中文本。
- 翻译选中文本。
- 整理成 Markdown 大纲。
- 根据 `@文件` 生成摘要。

后续支持：

- 用户自定义 prompt 模板。
- `/` 斜杠指令。
- 模板变量，例如 `{{selection}}`、`{{currentFile}}`、`{{date}}`。

### 6.9 会话历史

MVP 保存最近会话。

建议保存内容：

- 会话标题。
- 消息列表。
- 使用的 provider 和模型。
- 引用文件路径。
- 创建时间和更新时间。

验收标准：

- 可查看最近会话。
- 可删除会话。
- 可清空历史。
- 可关闭历史保存。

## 7. 非功能需求

### 7.1 移动端体验

- 输入框适配软键盘。
- 文件建议列表适合触屏。
- 上下文 chip 不遮挡输入。
- 长回答可折叠或滚动。
- 按钮足够大，避免误触。
- 网络慢时有加载状态。

### 7.2 隐私与安全

- 明确提示：发送给 API 的内容包括用户输入、被引用文件内容、当前笔记或选中文本。
- API Key 不显示明文。
- API Key 不写入会话导出内容。
- 不默认上传整个 vault。
- 不做遥测。
- 不把请求经过插件作者服务器。

### 7.3 成本控制

- 请求前展示上下文数量。
- 长文件自动截断并提示。
- 可配置最大上下文字符数。
- 可配置最大输出 token。
- 可查看本次请求大致上下文长度。

### 7.4 稳定性

- 网络失败不丢输入。
- 模型报错展示原始错误摘要。
- Base URL 错误时给出可理解提示。
- 请求超时可配置。
- 插件升级不破坏已保存 provider 配置。

## 8. 技术实现方案

### 8.1 技术栈

- TypeScript。
- Obsidian Plugin API。
- 原生 DOM / Obsidian Component。
- 不引入重型前端框架，除非后续 UI 复杂度明显上升。
- 构建工具可使用官方 sample plugin 的 esbuild 模式。

### 8.2 模块划分

建议结构：

```text
src/
  main.ts
  settings/
    SettingsTab.ts
    types.ts
  providers/
    OpenAICompatibleProvider.ts
    ProviderRegistry.ts
    types.ts
  chat/
    ChatView.ts
    ChatController.ts
    ChatStore.ts
  context/
    MentionParser.ts
    FileSuggest.ts
    ContextBuilder.ts
    TokenBudget.ts
  note-actions/
    EditorActions.ts
    ApplyResult.ts
  commands/
    registerCommands.ts
  utils/
    errors.ts
    request.ts
```

### 8.3 Provider 抽象

MVP 只实现 OpenAI-compatible，但保留接口：

```ts
interface AiProvider {
  id: string;
  name: string;
  sendChat(request: ChatRequest): Promise<ChatResponse>;
  streamChat?(request: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse>;
  testConnection(config: ProviderConfig): Promise<TestResult>;
}
```

这样以后可以新增：

- Anthropic 原生 Messages API。
- Gemini API。
- OpenRouter 特化配置。
- Ollama / LM Studio 桌面端支持。

### 8.4 请求格式

OpenAI-compatible 请求示例：

```json
{
  "model": "claude-3-5-sonnet",
  "messages": [
    { "role": "system", "content": "You are an AI assistant inside Obsidian." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.7,
  "stream": true
}
```

请求 URL：

```text
{{baseUrl}}/chat/completions
```

如果用户输入的 Base URL 已包含 `/chat/completions`，设置页需要检测并提示，避免拼接错误。

### 8.5 上下文构造

发送给模型的上下文建议采用明确分隔：

```text
<context>
<file path="项目A/会议记录.md">
...文件内容...
</file>

<selection path="当前文件.md">
...选中文本...
</selection>
</context>

<user_request>
用户输入
</user_request>
```

上下文原则：

- 用户明确添加的文件优先。
- 当前选中文本优先于当前文件全文。
- 超出预算时先截断最长文件。
- 截断必须在提示中说明。
- 不隐式发送整个 vault。

### 8.6 `@文件` 实现

实现步骤：

1. 监听输入框内容。
2. 识别最后一个未闭合的 `@query`。
3. 从 `app.vault.getMarkdownFiles()` 获取候选文件。
4. 按路径和文件名模糊匹配。
5. 用户点击或回车选择。
6. 插入为内部 mention token，并加入上下文附件列表。

建议内部结构：

```ts
interface ContextAttachment {
  id: string;
  type: "file" | "selection" | "current-file";
  path?: string;
  label: string;
  content?: string;
  addedAt: number;
}
```

### 8.7 存储

插件配置：

```text
.obsidian/plugins/<plugin-id>/data.json
```

建议配置内容：

- provider 列表。
- 默认 provider。
- 默认模型。
- UI 偏好。
- 历史保存开关。

会话历史：

```text
.obsidian/plugins/<plugin-id>/sessions.json
```

注意：

- 如果用户使用 Git 同步 `.obsidian`，API Key 可能被同步。
- 后续应评估 Obsidian `secretStorage`，或者至少在文档中提示用户不要同步包含 key 的配置文件。

## 9. 迭代计划

### M0：需求确认

- 确认插件名称。
- 确认 MVP 只做 OpenAI-compatible。
- 确认 `@文件` 只支持 vault 内 Markdown 文件。
- 确认不做 CLI/bash/MCP。

### M1：插件骨架与设置

- 创建 Obsidian 插件项目。
- manifest 设置 mobile 可用。
- 设置页支持 Base URL、API Key、模型名。
- 支持连接测试。
- 支持保存和加载设置。

### M2：基础聊天

- 增加聊天侧边栏。
- 支持发送消息。
- 支持非流式返回。
- 支持错误提示。
- 支持取消或防重复发送。

### M3：`@文件` 上下文

- 输入 `@` 弹出文件建议。
- 支持选择 Markdown 文件。
- 发送时读取文件内容。
- 支持上下文 chip 展示和移除。
- 支持上下文长度限制。

### M4：当前笔记与选区

- 一键添加当前文件。
- 一键添加选中文本。
- 支持总结当前笔记。
- 支持改写选中文本。

### M5：写入笔记

- 复制回答。
- 插入到当前光标。
- 替换当前选区。
- 追加到当前笔记末尾。
- 写入失败保留内容。

### M6：体验增强

- 流式输出。
- 会话历史。
- 快捷指令。
- 用户自定义 prompt 模板。
- diff 预览后应用。

## 10. 做什么与不做什么

### MVP 必做

- 移动端可用。
- 中转站 Base URL。
- API Key。
- 模型选择。
- 基础聊天。
- `@文件`。
- 当前文件/选区上下文。
- 复制、插入、替换、追加。
- 错误处理和不丢输入。

### MVP 不做

- CLI agent。
- bash。
- MCP。
- 外部目录文件。
- 自动批量改文件。
- 向量数据库。
- 全 vault 索引。
- 图片理解。
- 语音输入。
- 多 provider 原生协议。

### 后续再做

- Anthropic 原生 API。
- Gemini 原生 API。
- RAG / 向量索引。
- 多文件 diff。
- 自定义技能或 prompt 包。
- `@文件夹`。
- `@标签`。
- `@最近修改`。
- `@搜索结果`。
- 图片附件。
- 语音输入。

## 11. 验收标准

基础配置：

- 用户可以在 Obsidian mobile 启用插件。
- 用户可以配置中转站 Base URL、API Key、模型。
- 连接测试成功时能返回可理解结果。
- 连接失败时能显示明确错误。

聊天：

- 用户能发送消息并得到回答。
- 用户能切换模型。
- 网络失败不丢输入。
- 可复制回答。

`@文件`：

- 输入 `@` 能搜索并选择 Markdown 文件。
- 被引用文件能加入请求上下文。
- 多文件引用能正常工作。
- 文件过长时能截断并提示。

笔记操作：

- 能把 AI 回答插入当前光标。
- 能替换当前选区。
- 能追加到当前笔记末尾。
- 没有活动编辑器时不展示不可用操作。

安全：

- 插件不默认发送整个 vault。
- 插件不做遥测。
- 写入笔记前需要用户明确点击操作。

## 12. 风险与待确认问题

技术风险：

- Obsidian iOS 和 Android 的插件网络能力可能存在差异。
- 不同中转站的 OpenAI-compatible 兼容程度不同。
- 流式输出在移动端可能不稳定，需要可降级。
- API Key 存储如果随 `.obsidian` 同步，存在泄露风险。
- 长文件上下文会导致高成本和超 token。

待确认问题：

- 插件名称是什么？
- 第一版是否只支持 OpenAI-compatible？
- 是否必须支持 Anthropic 原生 API？
- 默认模型列表由用户手填，还是内置常见模型？
- `@文件` 是否需要支持别名和标题搜索？
- 是否支持 `@文件#标题` 引用单个标题块？
- 是否需要会话历史默认开启？
- 是否接受 API Key 存在插件 data.json，还是第一版必须做更安全的 secret storage？
- 是否需要发布到 Obsidian 社区插件市场，还是先手动安装？

## 13. 推荐决策

第一版建议采用：

- 插件名称暂定为 `Mobile AI Companion`。
- 只支持 OpenAI-compatible 接口，优先服务中转站。
- 设置页只要求 Base URL、API Key、模型名。
- 主入口是聊天侧边栏。
- MVP 支持 `@文件`、当前文件、选中文本。
- AI 默认只读上下文，不自动改笔记。
- 写入操作必须用户点击确认。
- 不做 CLI、bash、MCP、外部文件。
- 不做全 vault 索引，避免移动端性能和隐私复杂度。

这个范围能最快验证核心价值：

> 在 Obsidian mobile 里，用自己的中转站模型和 API Key，对当前笔记与 `@文件` 做可靠的 AI 问答和辅助编辑。

## 14. 参考资料

- Claudian 仓库：https://github.com/YishenTu/claudian
- Claudian manifest：https://raw.githubusercontent.com/YishenTu/claudian/main/manifest.json
- Claudian README：https://raw.githubusercontent.com/YishenTu/claudian/main/README.md
- Obsidian API 类型定义：https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts
