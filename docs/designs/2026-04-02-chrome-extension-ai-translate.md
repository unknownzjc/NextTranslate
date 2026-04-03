# NextTranslate - Chrome Extension AI 翻译扩展

**日期:** 2026-04-02

## 背景

用户希望创建一个 Chrome 扩展，用于翻译网页上的英文内容为中文。核心诉求包括：

1. 支持一键翻译全文，翻译页面中主体部分的英文为中文
2. 翻译的中文需要内联显示在对应英文段落的下方
3. 支持配置 AI 翻译的 Provider 端点（OpenAI 兼容格式）

## 讨论

### 主体内容识别

讨论了三种识别页面主体内容的方案：

- **方案 A - 轻量 DOM 遍历**：零依赖，通过启发式规则（`<article>`、`<main>` 等语义标签 + 文本密度）定位主体。优点是简单轻量，缺点是边缘情况识别不准。
- **方案 B - @mozilla/readability**：准确度高（Firefox 大规模验证），但约 30KB 依赖且需要额外逻辑将重建的 DOM 映射回原始节点。
- **方案 C - 混合方案**：优先语义标签，回退到文本密度算法。

最终决定使用 **defuddle** 库（由 Obsidian CEO kepano 开发），相比 Readability 更轻量，支持 TypeScript，已在 Obsidian Web Clipper 中实战验证，专为 AI/LLM 管道设计。

### 内联代码保护

讨论了段落内 `<code>` 标签在使用 `textContent` 提取时会丢失语义信息的问题——变量名如 `useState`、`fetchData` 会被 AI 误翻译。最终选择**占位符替换方案**：提取前将内联 `<code>` 文本替换为 `⟨NT_CODE_N⟩` 占位符，翻译后还原。Prompt 中要求 AI 保留占位符不变。

### AI Provider 模式

讨论了三种模式：OpenAI 兼容格式、多 Provider 格式、用户自建后端代理。最终选择 **OpenAI 兼容格式**，可覆盖 OpenAI、DeepSeek、本地 Ollama 等大部分 AI 服务。

### 译文展示方式

讨论了内联插入、浮动面板、Tooltip 悬浮三种展示方式。最终选择**内联插入**，译文直接插入到原文段落下方，与原页面融为一体，通过左边框和浅色文字区分。

### 翻译粒度与请求策略

讨论了逐段落翻译、批量合并翻译两种策略。最终选择**粗粒度批量翻译**：将多个段落合并为一批发送，以 ~2000 tokens 为阈值，尽量减少 API 请求次数。不使用流式响应，每批等待完整结果返回后再插入。通过统一的请求队列控制并发和流速，遇到 429 rate limit 时自动退避重试。

### 内容过滤

需要跳过不应翻译的内容：代码块（`<code>`、`<pre>`）、已有中文内容（中文字符占比 > 50%）、脚本/样式/SVG 等非文本内容。

### 懒加载内容

现代网页普遍使用 lazy load / infinite scroll，翻译不能是一次性操作。用户触发翻译后通过 MutationObserver 持续监听 DOM 变化，新加载的内容自动翻译。

### 技术栈

最终选择 **TypeScript + Vite + Chrome Extension Manifest V3**，具备现代化开发体验和 HMR 支持。

## 方案

采用 defuddle 库进行页面主体内容智能提取，过滤代码块和已有中文内容后，将段落批量合并发送至 OpenAI 兼容 API 进行翻译，译文以内联方式插入到英文段落下方。通过 MutationObserver 监听懒加载内容实现动态翻译。整体架构分为三层：Popup（设置与触发）、Background Service Worker（API 调用）、Content Script（内容提取与译文注入）。

## 架构

### 组件总览

```
┌─────────────────────────────────────────────┐
│                Chrome Extension             │
├──────────┬──────────────┬───────────────────┤
│  Popup   │   Background │  Content Script   │
│  (设置页) │  (Service    │  (注入到网页)      │
│          │   Worker)    │                   │
├──────────┴──────────────┴───────────────────┤
│  Popup:                                     │
│  - "翻译全文" 按钮                            │
│  - Provider 设置 (endpoint/key/model)        │
│                                             │
│  Background (Service Worker):               │
│  - 接收翻译请求，调用 AI API                   │
│  - 管理 API 调用的并发和错误处理               │
│                                             │
│  Content Script:                            │
│  - 使用 defuddle 提取页面主体                  │
│  - 收集英文段落，发送翻译请求                   │
│  - 将译文内联插入到英文段落下方                  │
└─────────────────────────────────────────────┘
```

### Manifest V3 权限

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "storage", "scripting", "alarms", "contextMenus"],
  "optional_host_permissions": ["<all_urls>"],
  "commands": {
    "toggle-translate": {
      "suggested_key": { "default": "Alt+T", "mac": "MacCtrl+T" },
      "description": "翻译/取消翻译当前页面"
    }
  }
}
```

- `activeTab`：用户点击扩展图标时获取当前 tab 的临时访问权限，足以注入 Content Script，无需为 Content Script 声明宽泛的 host_permissions
- `storage`：读写 `chrome.storage.sync` / `chrome.storage.local`
- `scripting`：配合 `activeTab` 使用 `chrome.scripting.executeScript` 按需注入 Content Script
- `alarms`：用于 Service Worker keepalive 的次要手段（见下方 Service Worker 存活策略）
- `contextMenus`：注册右键菜单"翻译此页面"入口
- `optional_host_permissions: <all_urls>`：Background Service Worker 需要向用户配置的任意 API endpoint 发起 `fetch` 请求（用户可能配置 OpenAI、DeepSeek、本地 Ollama 等不同域名的端点）。**使用 `optional_host_permissions` 而非 `host_permissions`**，避免安装时触发"可读取所有网站数据"的权限警告以及 Chrome Web Store 审核风险。用户首次保存 Provider 设置时，通过 `chrome.permissions.request({ origins: [endpointOrigin + "/*"] })` 动态申请该域名的权限（浏览器会弹出确认提示）；如果用户更换 endpoint 域名，先 `chrome.permissions.remove` 旧域名再申请新域名。如果用户拒绝权限授予，在 Popup 中明确提示"需要授权才能访问翻译服务"

注意：Manifest V3 的 CSP 限制禁止动态代码执行（`eval`、远程脚本加载），因此 defuddle 必须通过 Vite 静态打包进 Content Script bundle，不能动态加载。

### 快捷键与右键菜单

- **快捷键**：通过 `chrome.commands` 注册 `Alt+T`（Mac: `MacCtrl+T`）。Background 监听 `chrome.commands.onCommand`，收到 `"toggle-translate"` 命令后向当前活跃 tab 发送 `TOGGLE_TRANSLATE` 消息（复用与 Popup 相同的逻辑：先尝试 sendMessage，失败则注入 Content Script 后重试）
- **右键菜单**：Background 在 `chrome.runtime.onInstalled` 中通过 `chrome.contextMenus.create` 注册"翻译此页面"菜单项（`contexts: ["page"]`）。点击时同样发送 `TOGGLE_TRANSLATE` 到当前 tab

### 核心流程

1. 用户点击 Popup 中的「翻译全文」按钮（或使用快捷键 `Alt+T` / 右键菜单「翻译此页面」）
2. Popup 先检查 `chrome.storage.sync` 中是否已配置 Provider（endpoint/apiKey/model 均非空）；如果未配置，直接在 Popup 中高亮设置区域并提示"请先配置翻译服务"，不发送消息到 Content Script
3. Popup 通过 `chrome.tabs.sendMessage` 尝试联系当前 tab 的 Content Script；如果 Content Script 尚未注入，`sendMessage` 会抛出 "Could not establish connection" 错误，Popup 捕获此错误后调用 `chrome.scripting.executeScript` 注入 Content Script，并通过 `chrome.scripting.insertCSS` 注入译文样式（`executeScript` 只能注入 JS，CSS 需要单独的 `insertCSS` 调用），等待注入完成后再重新发送消息。注入期间 Popup 按钮置为 disabled 状态，防止用户重复点击。注意：CSS 注入无需额外去重——只在 Content Script 不存在时（错误路径）才执行注入，而 Content Script 已存在时（sendMessage 成功路径）自然跳过。**为避免 `insertCSS` 延迟导致首批译文无样式闪烁（FOUC），Content Script 内部应内联一段关键样式**（`nt-translation` 的基本布局：左边框、字体、间距），`insertCSS` 提供完整样式表覆盖（进度条、主题变量、动画等）。**CSP 兼容性**：Content Script 中的关键样式**必须通过 `chrome.scripting.insertCSS` 或在扩展自身的 CSS 文件中定义**，而不能通过 `document.createElement('style')` 动态创建 `<style>` 元素注入——严格 CSP 的页面（如 GitHub、银行网站）可能设置了 `style-src` 指令禁止内联样式，动态创建的 `<style>` 会被浏览器拦截。`chrome.scripting.insertCSS` 和扩展 manifest 声明的 CSS 文件不受页面 CSP 约束（Chrome 将扩展注入的样式视为特权操作），因此是安全的注入路径。具体做法：将关键样式写入一个独立的 `critical.css` 文件，Content Script 启动时通过 `chrome.runtime.sendMessage` 请求 Background 调用 `chrome.scripting.insertCSS({ files: ['critical.css'], target: { tabId } })` 注入（Content Script 自身无法调用 `chrome.scripting` API，该 API 仅 Background 可用），Background 以 tabId 为 key 做去重，确保同一 tab 不重复注入
4. Content Script 用 defuddle 识别主体区域，提取英文段落（跳过代码块、中文内容等）
5. 将段落按批次合并，通过 `chrome.runtime.sendMessage` 发给 Background Service Worker（使用 Promise 等待响应）
6. Service Worker 调用 OpenAI 兼容 API 进行翻译（同步等待完整结果），通过 sendResponse 返回翻译结果
7. Content Script 收到响应后，内联插入译文到对应段落下方
8. 开启 MutationObserver 监听，后续懒加载的新内容自动翻译

注意：Content Script 采用**按需注入**而非 manifest 声明注入（不在 `manifest.json` 中配置 `content_scripts` 字段）。好处是：只在用户主动触发时注入，避免在所有页面上加载不必要的脚本；配合 `activeTab` 权限即可注入到当前页面，Content Script 本身不需要额外的 host_permissions（`host_permissions: <all_urls>` 仅用于 Service Worker 的 API 调用）。

### 设置存储

```typescript
interface ProviderConfig {
  endpoint: string        // API base URL，如 "https://api.openai.com/v1"（不含 /chat/completions，代码自动拼接；自动去除末尾斜杠）
  apiKey: string          // API Key
  model: string           // 如 "gpt-4o-mini"
  targetLanguage: string  // 翻译目标语言，如 "Simplified Chinese"、"Japanese"、"Korean"，默认 "Simplified Chinese"
  jsonMode: 'auto' | 'enabled' | 'disabled' // JSON mode（response_format）策略，默认 'auto'。'auto'：首次翻译时尝试 JSON mode，如果 Provider 返回 400/422 错误或非法 JSON，自动回退到分隔符模式并将此字段持久化为 'disabled'（下次不再尝试）；'enabled'：强制使用 JSON mode（用户确认 Provider 支持时手动设置）；'disabled'：始终使用分隔符模式
}
```

非敏感设置（endpoint、model、targetLanguage、jsonMode）使用 `chrome.storage.sync` 存储，支持跨设备同步。**API Key 默认存储于 `chrome.storage.local`，不做跨设备同步**——sync storage 的数据会经过 Google 服务器传输，API Key 作为凭证不应暴露于此路径。Popup 设置页中提供"跨设备同步 API Key"可选开关（默认关闭），用户明确开启后才将 API Key 写入 `chrome.storage.sync`。读取时优先从 sync 读取，sync 中不存在则回退到 local。

**连接测试**：Popup 设置页提供「测试连接」按钮。点击后向 Background 发送 `TEST_CONNECTION` 消息，Background 使用当前配置向 API endpoint 发送一个轻量级翻译请求（将 "hello" 翻译为目标语言），根据响应状态判断：HTTP 200 且返回合法结果 → 显示绿色"连接成功"；HTTP 401/403 → 提示"API Key 无效"；HTTP 404 → 提示"端点地址错误"；网络错误 → 提示"无法连接到服务器"；超时（5 秒）→ 提示"连接超时"。测试期间按钮显示 loading 状态，防止重复点击。这避免用户在配置错误的情况下触发全文翻译才发现问题。

### 消息通信协议

组件间通过 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` 通信。Content Script → Background 使用 request-response 模式（`sendMessage` 返回 Promise），Background 在 `onMessage` listener 中调用 API 后通过 `sendResponse` 返回结果。**注意：由于 API 调用是异步的，`onMessage` listener 必须 `return true` 以保持消息通道开放直到 `sendResponse` 被调用，否则通道会在 listener 同步返回后立即关闭。** 消息类型定义如下：

```typescript
// Popup → Content Script
type ToggleTranslateMsg = { type: 'TOGGLE_TRANSLATE' }
// Content Script 通过 sendResponse 返回 ToggleTranslateResponse，告知 Popup 本次操作的结果：
type ToggleTranslateResponse = {
  action: 'started' | 'cancelled' | 'toggled_visible' | 'toggled_hidden' | 'busy'
}
// 'started'：首次触发翻译；'cancelled'：翻译进行中，已取消；
// 'toggled_visible'/'toggled_hidden'：翻译已完成，切换译文显示/隐藏；
// 'busy'：Content Script 正在处理上一次 toggle 操作，本次请求被忽略。
// Popup 根据 action 更新按钮文案和 UI 状态（收到 'busy' 时不改变 UI）。
// **防抖锁**：Content Script 内部维护 `toggleBusy: boolean` 标志。收到 TOGGLE_TRANSLATE 时，
// 如果 toggleBusy 为 true，立即 sendResponse({ action: 'busy' }) 并 return；
// 否则置 toggleBusy = true，执行完状态切换后置 toggleBusy = false。
// 这避免了快速连续点击导致的状态竞争（例如翻译启动流程尚未完成时收到第二次 toggle，
// 被误判为"进行中取消"导致刚启动的翻译立即被取消）。
// 首次点击触发翻译并开启 MutationObserver；
// 如果翻译正在进行中再次点击，Content Script 向 Background 发送 CANCEL_TRANSLATE 以中止进行中的 API 请求，
// 同时清空本地待发送队列、隐藏已有译文并停止 MutationObserver；
// 如果翻译已完成，再次点击切换译文的显示/隐藏

// Content Script → Background (Service Worker)
type TranslateBatchMsg = {
  type: 'TRANSLATE_BATCH'
  batchId: string             // 全局唯一标识，使用 crypto.randomUUID() 生成，确保跨 tab、跨 SW 重启不碰撞
  texts: string[]             // 待翻译段落数组
  totalBatches: number   // 本轮翻译的总批次数，Background 用于计算进度百分比。首次全文翻译时在分段完成后确定；MutationObserver 触发的增量翻译作为独立轮次，有自己的 totalBatches，Background 将增量批次的进度累加到已有进度之上
  // 注意：tabId 不需要在消息中传递，Background 通过 onMessage 的 sender.tab.id 获取
}

// Content Script → Background (取消翻译)
type CancelTranslateMsg = { type: 'CANCEL_TRANSLATE' }
// Background 收到后通过 sender.tab.id 识别来源 tab，中止该 tab 所有进行中的 API 请求（AbortController.abort()）、
// 清空该 tab 的请求队列、清除 Badge 状态

// Background sendResponse 返回值（通过 sendMessage 的 Promise resolve 传回 Content Script）
type TranslateBatchResult = {
  batchId: string
  translations: string[] // 翻译结果数组，与 texts 一一对应
  error?: string         // 错误信息（如有）
}

// Background → Popup (状态反馈)
type TranslateStatusMsg = {
  type: 'TRANSLATE_STATUS'
  status: 'translating' | 'done' | 'cancelled' | 'error'
  progress?: { completed: number; total: number }
  error?: string
}
// 翻译进行中 Background 通过 chrome.runtime.sendMessage 广播 TRANSLATE_STATUS（Popup 如已打开则通过 onMessage 接收并实时更新 UI；未打开则无接收方，消息自动丢弃无副作用）。
// Popup 每次打开时也通过 QUERY_STATUS 主动查询一次当前状态，确保恢复正确的 UI。

// Popup → Background (查询当前状态)
type QueryStatusMsg = { type: 'QUERY_STATUS'; tabId: number }

// Popup → Background (测试连接)
type TestConnectionMsg = { type: 'TEST_CONNECTION' }
// Background 返回 TestConnectionResult：
type TestConnectionResult = {
  success: boolean
  error?: string  // 如 "API Key 无效"、"端点地址错误"、"无法连接到服务器"、"连接超时"
}

// Content Script → Background (心跳 keepalive，每 25 秒一次，翻译进行中持续发送)
type KeepaliveMsg = { type: 'KEEPALIVE' }
// Background 收到后仅回复 true，目的是重置 Service Worker 闲置计时器防止被终止
// Popup 每次打开时先通过 chrome.tabs.query({ active: true, currentWindow: true }) 获取当前 tab ID，
// 然后向 Background 发送 QUERY_STATUS（必须包含 tabId，因为 Popup 不是 Content Script，
// Background 无法从 sender.tab 获取 tab ID）。Background 回复当前 tab 的 TRANSLATE_STATUS。
// 这样即使 Popup 在翻译过程中被关闭又重新打开，也能立即恢复正确的 UI 状态。
```

### 内容提取与过滤

- **主体提取**：使用 defuddle 识别页面主体区域。**defuddle 版本需在 `package.json` 中精确锁定（不使用 `^`），因为 `debug.contentSelector` 不是 defuddle 的稳定公开 API，版本更新可能改变其结构。** defuddle 内部会 `cloneNode(true)` 整份文档在克隆体上做裁剪，**不修改原始 DOM**，返回的 `content` 是提取后的 HTML 字符串（非 DOM 引用），也没有 `element` 属性。因此提取流程为：以 `debug: true` 调用 defuddle，通过返回的 `debug.contentSelector`（CSS selector 字符串）在原始文档中 `document.querySelector` 定位主体容器；如果 `contentSelector` 为空，回退到对 defuddle 返回的 `content` HTML 做文本指纹匹配（提取 content 中前 200 个纯文本字符作为指纹，在 `document.body` 子树中用 TreeWalker 搜索包含该文本的最小容器）。定位到原始容器后，在其内部直接遍历原始 DOM 子节点收集待翻译段落，注入译文时可直接操作原始节点。如果 defuddle 未能识别出主体区域（`content` 为空）**或 defuddle 抛出异常**（如 DOM 结构异常触发内部错误）**或 defuddle 执行超时（3 秒）**，回退到 `document.body` 作为提取容器，并在 Popup 中提示用户"未检测到主体区域，已翻译全页内容"。defuddle 调用需包裹在 try/catch 中，并通过 `Promise.race` 与 3 秒超时 Promise 竞争——复杂页面（深层嵌套 DOM、大量节点）可能导致 defuddle 的克隆和遍历耗时过长，超时保护确保不阻塞翻译流程
- **段落定义**：以下 DOM 元素视为"段落"进行提取：`<p>`、`<h1>`-`<h6>`、`<li>`、`<blockquote>`、`<td>`、`<th>`、`<figcaption>`、`<dt>`、`<dd>`。遍历时采用最内层匹配原则——如果一个 `<li>` 内部包含 `<p>`，只提取 `<p>` 而不重复提取 `<li>` 的文本。短文本（少于 10 个非空白字符）跳过不翻译
- **代码块跳过**：跳过 `<code>`、`<pre>`、`<kbd>`、`<samp>` 等代码相关标签，不发送翻译
- **非文本内容跳过**：跳过 `<script>`、`<style>`、`<svg>`、数学公式（MathJax/KaTeX）等
- **隐藏内容跳过**：跳过 `display:none`、`visibility:hidden`、`aria-hidden="true"` 的元素及 `<template>` 标签内的内容。**性能优化**：避免对每个候选元素调用 `getComputedStyle`（会强制布局回流，大页面 1000+ 节点时造成明显卡顿）。采用分层检测策略：(1) 先检查 `<template>` 标签和 `aria-hidden="true"` 属性（纯 DOM 读取，零开销）；(2) 再检查 `offsetParent === null`（浏览器内部缓存，极低开销，可捕获绝大多数 `display:none` 情况，但注意 `<body>` 直接子元素和 `position:fixed/sticky` 元素的 `offsetParent` 也为 `null`，需排除）；(3) 仅对 `offsetParent` 检测不确定的元素（fixed/sticky 定位等）回退到 `getComputedStyle` 检查 `visibility:hidden` 和 `display:none`。这样大部分元素只需前两步即可判定，避免批量触发布局回流。原因：`textContent` 会提取不可见元素的文本，导致浪费 token 并产生"幽灵译文"
- **中文内容跳过**：如果段落中文字符占比 > 50%，视为已是中文，跳过翻译
- **已翻译标记**：维护已翻译节点的 Set（以 DOM 元素引用为 key），避免重复翻译
- **翻译粒度为纯文本**：提取段落时使用 `textContent` 而非 `innerHTML`。原因：(1) 发送 HTML 标签会浪费 token 且增加 AI 出错概率；(2) AI 难以在翻译时精确保留 HTML 结构（尤其是 `<a>` 标签的 href）；(3) 译文本身就是辅助参考，无需保留加粗、链接等内联格式。译文以纯文本形式插入 `<div class="nt-translation">`。**内联代码保护**：`textContent` 会将段落内 `<code>` 标签的内容（如变量名 `useState`、`fetchData`）提取为普通文本，AI 可能将其误翻译。提取前先遍历段落内所有内联 `<code>` 元素，将其文本替换为占位符 `⟨NT_CODE_0⟩`、`⟨NT_CODE_1⟩`...（使用角括号 `⟨⟩` 而非尖括号 `<>` 避免被 AI 解读为 HTML），同时记录占位符到原始文本的映射；提取 `textContent` 后发送翻译；收到译文后将占位符还原为原始代码文本。Prompt 中增加规则："Preserve placeholders like ⟨NT_CODE_N⟩ exactly as-is, do not translate or modify them."。如果 AI 返回的译文中占位符缺失或被修改，回退为直接使用不还原的译文（降级但不报错）
- **Prompt 注入防护**：页面内容直接嵌入 AI Prompt，恶意页面可能注入不可见文本（如 `display:none` 元素中的 "Ignore all previous instructions..."）试图操纵翻译结果。防护措施：(1) 跳过隐藏元素（见上方"隐藏内容跳过"）从源头过滤注入向量；(2) 系统提示词使用强角色锚定，明确要求模型仅执行翻译任务；(3) 译文注入使用 `textContent` 而非 `innerHTML`，即使 AI 返回恶意 HTML/JS 也不会被执行（XSS 防护）；(4) 对提取的段落文本截断上限（单段最多 10,000 字符），避免超长注入文本

### iframe 与 Shadow DOM

- **iframe**：跳过跨域 iframe（受同源策略限制无法访问 `contentDocument`）；对于同域 iframe，可选地通过 `iframe.contentDocument` 递归遍历其内部 DOM 提取段落。默认不进入 iframe，作为 P6 增强功能
- **Shadow DOM**：遍历段落时检查元素的 `shadowRoot` 属性（仅 `open` 模式的 Shadow DOM 可访问），如果存在则递归进入 Shadow DOM 子树提取段落。`closed` 模式的 Shadow Root 无法从外部访问，直接跳过。此为 P6 增强功能

### 懒加载内容的动态翻译

用户点击「翻译全文」后，进入**持续监听模式**：

- 使用 **MutationObserver** 监听主体区域的 DOM 变化（配置 `{ childList: true, subtree: true }`）
- 当新节点插入时（如 infinite scroll、lazy load），自动对新内容执行提取 + 翻译 + 注入。使用 300ms debounce 合并短时间内的大量 DOM 变动，避免频繁触发翻译请求
- MutationObserver 的回调中必须过滤掉扩展自身注入的 `nt-translation` 节点，避免翻译自己的译文导致无限循环。判断方式：跳过所有携带 `nt-` 前缀 class 的节点及其子节点
- 通过已翻译节点 Set 避免重复处理
- 再次点击「翻译全文」关闭监听并切换译文显示/隐藏
- 翻译状态为 per-tab 维护（通过 Content Script 内存变量），页面刷新后状态重置，不持久化
- **SPA 页面切换处理**：单页应用（SPA）通过 History API 导航不会重新加载页面，Content Script 不会被卸载重注入，导致旧的翻译状态（已翻译节点 Set、MutationObserver、注入的译文 DOM）残留。Content Script 通过监听 `popstate` 事件、`hashchange` 事件，以及劫持 `history.pushState` / `history.replaceState` 检测 SPA 导航（覆盖 History API 路由和 hash 路由两种模式），导航发生时：(1) 如果有翻译正在进行，先向 Background 发送 `CANCEL_TRANSLATE` 以中止该 tab 的进行中 API 请求（注意：SPA 导航不触发 `chrome.tabs.onUpdated`，Background 无法自动感知，必须由 Content Script 主动通知）；(2) 清除所有翻译状态、移除已注入的译文节点、断开 MutationObserver

### 翻译 API 调用策略

- **批量翻译**：将多个段落合并为一批发送，减少 API 请求次数。以 token 阈值（约 2000 tokens，可在高级设置中调整）为界，短段落尽量合并，超长段落单独发送。如果单个段落超出安全阈值（默认 4000 tokens），按句子边界（句号、问号、感叹号）拆分为多个子段，每个子段独立翻译后再拼接，避免单段超出模型上下文窗口。Token 数量使用字符数估算：英文及拉丁语系按 1 token ≈ 3 chars（保守估算，不同模型 tokenizer 差异较大，宁可多分批也不要超出上下文窗口），CJK 字符（中日韩）按 1 token ≈ 1.5 chars，混合文本取加权平均。批量请求中使用 `∥NT∥` 作为段落分隔符（该字符串在自然文本中几乎不可能出现，避免 `---` 与 Markdown 水平线、文本内容冲突），Prompt 中要求 AI 按相同分隔符返回结果，以便正确对应回原段落
- **同步等待**：不使用流式响应，每批翻译请求等待完整结果返回后再插入译文
- **请求队列**：所有翻译批次进入统一的请求队列，队列控制**全局**最大并发数（默认 3）和请求间隔（默认 200ms）。并发限制是全局共享的，而非 per-tab——多个 tab 同时翻译时共享 3 个并发槽位，避免 N 个 tab × 3 并发导致大量并行请求压垮 API Provider。**公平调度**：多 tab 同时翻译时采用 round-robin 调度而非 FIFO——每个 tab 的下一个批次排入各自的子队列，调度器轮流从各 tab 子队列中取出一个批次发送，确保一个大页面的翻译不会饿死其他 tab。具体实现：Background 维护一个 `tabQueue: Map<number, BatchMsg[]>`（per-tab FIFO 子队列）和一个 `activeTabIds: number[]`（参与调度的 tab 列表），调度器每次从 `activeTabIds` 中取下一个 tab（循环指针），从其子队列 dequeue 一个批次发送；如果某 tab 子队列为空则跳过并移出 `activeTabIds`，直到所有子队列耗尽。收到 429 响应时自动退避：暂停队列，按 `Retry-After` 头（需同时处理秒数格式和 RFC 7231 日期格式两种形式）或指数退避等待后恢复。退避参数：初始延迟 2s，2x 乘数，上限 60s，±20% 随机抖动（避免多 tab 同时退避后同时恢复导致的惊群效应）。这样无论是首次全文翻译还是 MutationObserver 触发的增量翻译，都经过同一个队列限流
- **多 Tab 隔离**：Background Service Worker 为所有 tab 共享，请求队列按 tabId 隔离管理。Service Worker 通过 `onMessage` 回调的 `sender.tab.id` 识别来源 tab，内部为每个 tab 维护独立的队列和进度状态（批次缓冲、已完成计数等），但并发槽位全局共享（见上方请求队列），确保多 tab 同时翻译时既不互相阻塞队列内部状态、也不超出全局并发限制
- **Tab 生命周期管理**：监听 `chrome.tabs.onRemoved` 和 `chrome.tabs.onUpdated`（`status === 'loading'` 表示页面导航），当 tab 关闭或导航到新页面时，清除该 tab 的翻译队列、取消未完成的请求（通过 AbortController）、清除 Badge 状态，避免资源泄漏
- **Service Worker 存活**：Manifest V3 的 Service Worker 闲置约 30 秒后会被浏览器终止。**主要 keepalive 策略：Content Script 心跳**——翻译进行中时，Content Script 每 25 秒向 Background 发送一条 `{ type: 'KEEPALIVE' }` 消息（Background 收到后仅回复 `true`），因为处理消息会重置 SW 的闲置计时器。**次要 keepalive 策略：`chrome.alarms`**——作为兜底，通过 `chrome.alarms.create` 设置周期性 alarm。注意：**`chrome.alarms` 在生产环境中最小周期为 1 分钟**（非开发模式下设置低于 60 秒的值会被浏览器自动提升到 60 秒），因此不能作为唯一的 keepalive 手段。翻译完成后 Content Script 停止心跳、Background 清除 alarm
- **退避状态持久化**：速率限制退避状态（当前退避延迟、退避截止时间戳）持久化到 `chrome.storage.session`（MV3 session storage，SW 作用域，跨 SW 重启存活但浏览器关闭后清除）。SW 重启后从 `chrome.storage.session` 恢复退避状态，如果当前时间仍在退避窗口内则继续等待，避免 SW 终止后立即重启导致退避状态丢失、请求以全速发出再次触发 429。每次退避开始时写入 `{ backoffUntil: timestamp, backoffDelay: currentDelay }`，退避结束后清除
- **安全上限**：单个 tab 最多发送 100 个批次（约覆盖 500-1000 个段落）。超出上限后暂停翻译并通过 Popup 提示用户"页面内容过多，已翻译前 N 段"，用户可手动选择继续。**重试预算**：单次翻译会话（从用户点击"翻译全文"到翻译完成/取消）维护一个全局重试计数器，上限 20 次。每个批次因 API 错误（非 429）或响应解析失败而触发的重试均消耗此预算；429 退避重试单独计数，不消耗重试预算（因为 429 是速率限制而非真正的失败，退避后大概率成功）。预算耗尽后，剩余失败批次不再自动重试，保持"翻译失败，点击重试"状态，用户可手动逐个重试（手动重试不受预算限制）。这防止大量批次同时失败时重试风暴导致 API 账单失控
- **逐批渲染**：每批翻译完成后立即插入对应段落的译文，用户可以看到译文逐批出现。由于并发请求可能乱序完成，采用**按文档顺序渲染**策略：Content Script 为每个批次分配递增序号，维护一个"下一个待渲染序号"指针；如果某批次先于前序批次完成，暂存其结果，等前序批次渲染完毕后再按序插入，确保用户看到的译文从上到下依次出现
- **批次-段落映射**：Content Script 在发送批次前构建 `Map<batchId, { seq: number, elements: Element[] }>`，记录每个批次对应的原始 DOM 元素引用数组（按文档顺序）。翻译结果返回后，通过 `batchId` 从 Map 中取出对应的 DOM 元素数组，将 `translations[i]` 的译文插入到 `elements[i]` 的下方。如果在翻译期间原始 DOM 元素被页面移除（SPA 导航或动态更新），检查 `element.isConnected`，跳过已脱离文档的节点
- **Service Worker 恢复策略**：如果 Service Worker 被意外终止，Content Script 侧的 `sendMessage` 会收到 "Could not establish connection" 错误。Content Script 暂停发送队列，以指数退避策略重试（初始 1s，2x 乘数，上限 30s，±20% 随机抖动），最多重试 5 次。Service Worker 重启后（浏览器在收到消息时自动唤醒），恢复发送当前未完成的批次。超过最大重试次数后标记翻译失败，通过 Badge 显示错误状态。**注意：Service Worker 重启后内存状态全部丢失**（请求队列、per-tab 进度计数、AbortController 等），因此 Content Script 重试时应重新发送当前批次而非仅重连，Background 应以 `batchId` 做幂等去重（收到已处理过的 batchId 时跳过或直接返回缓存结果），避免同一批次被重复翻译
- **扩展更新导致的 Content Script 孤立**：当扩展更新时，已注入的 Content Script 变为"孤立脚本"——其 `chrome.runtime` 上下文失效，`sendMessage` 抛出 "Extension context invalidated" 错误（不同于 SW 终止的 "Could not establish connection"，后者可通过重试恢复，前者不可恢复）。Content Script 应在每次 `sendMessage` 的 catch 中检查 `chrome.runtime.id === undefined`（孤立脚本的标志），检测到后：(1) 立即停止所有翻译活动（清空队列、断开 MutationObserver）；(2) 在页面内注入一个固定定位的横幅提示 "扩展已更新，请刷新页面以继续使用翻译功能"（横幅包含可点击的刷新按钮，调用 `location.reload()`）；(3) 不再做任何重试。此错误不会被 SW 恢复策略的重试逻辑触及，因为检测在重试之前
- **SPA 导航取消后的孤立响应**：当 SPA 导航触发 `CANCEL_TRANSLATE` 时，进行中的 `fetch` 通过 `AbortController.abort()` 中止，但已经完成网络传输、尚未投递到 `onMessage` handler 的响应仍可能到达。此时 Content Script 已重置 `batchId → elements` Map，这些孤立响应在 Map 查找时会得到 `undefined`，应**显式检查并静默丢弃**（而非依赖隐式 undefined 行为）——在 `translations` 回调入口处检查 `batchMap.has(batchId)`，不命中则直接 `return`，不做任何 DOM 操作。Background 侧，对已 abort 的请求调用 `sendResponse` 不会抛出（Chrome 消息通道在 abort 后已关闭，`sendResponse` 为空操作），但仍应在 `fetch` 的 catch 中检查 `error.name === 'AbortError'` 并跳过 `sendResponse` 调用，保持代码意图清晰
- **Prompt 设计**：系统提示词指定翻译目标语言（从 `ProviderConfig.targetLanguage` 读取，默认 Simplified Chinese）。不硬编码源语言为英文——实际页面可能包含日文、法文、德文等非英文内容，让 AI 自行识别源语言更灵活可靠（前置的「中文字符占比 > 50%」过滤已确保不会将中文内容发送翻译）。**跨批次术语一致性**：不同批次独立翻译时，同一技术术语（如 "dependency injection"、"middleware"）可能在不同批次中被翻译为不同的中文表述。为保持一致性，Content Script 在所有段落提取完成后、分批发送前，先扫描全部待翻译文本，提取高频术语（出现 ≥ 2 次的、以大写字母开头的连续词组或被反引号 / `<code>` 包裹的词组），去重后构建术语列表（最多 30 个）。该术语列表作为 Prompt 的一部分附加到系统提示词中（`"Glossary for consistent translation across paragraphs:\n- dependency injection\n- middleware\n- ..."`），要求 AI 在整个翻译过程中对这些术语保持统一译法。术语列表在同一轮翻译会话中保持不变，所有批次共享同一份列表。由于术语仅作为参考提示而非强制映射，AI 仍保留根据上下文选择最佳译法的灵活性。MutationObserver 触发的增量翻译复用已有术语列表，不重新扫描。**JSON mode 自动探测**：当 `ProviderConfig.jsonMode` 为 `'auto'`（默认值）时，首批翻译请求携带 `response_format: { type: "json_object" }`。如果 Provider 返回 HTTP 400/422 错误（表示不支持该参数），Background 捕获此错误后将 `jsonMode` 持久化更新为 `'disabled'`，并立即以分隔符模式重试该批次（不计为失败）。如果首批成功返回合法 JSON，将 `jsonMode` 持久化更新为 `'enabled'`。后续批次直接使用已确定的模式，不再探测。这样用户无需理解 JSON mode 是什么，大多数主流 Provider（OpenAI、DeepSeek、Anthropic）会自动获得更可靠的 JSON 模式，而不支持的 Provider（部分 Ollama 模型、旧版 vLLM）会优雅降级

```
## JSON mode（优先）

System Prompt:
You are a translation engine. Translate the following text into ${targetLanguage}.
Rules:
- You will receive a JSON object with a "texts" array containing paragraphs to translate.
- Return a JSON object with a "translations" array containing the translated paragraphs.
- The "translations" array MUST have the same length as the "texts" array.
- Output plain text only in each translation. Do not use any markdown formatting.
- Keep proper nouns, brand names, and technical terms in their original form when appropriate.
- Preserve placeholders like ⟨NT_CODE_N⟩ exactly as-is. Do not translate, modify, or remove them.
- Auto-detect the source language. If a paragraph is already in ${targetLanguage}, return it as-is.
${glossary ? `\nGlossary — translate these terms consistently across all paragraphs:\n${glossary.join(", ")}` : ""}

User Prompt:
{"texts": ["paragraph 1", "paragraph 2", ...]}

Expected Response:
{"translations": ["译文 1", "译文 2", ...]}

## 分隔符模式（回退）

System Prompt:
You are a translation engine. Translate the following text into ${targetLanguage}.
Rules:
- Preserve the original paragraph structure.
- Output plain text only. Do not use any markdown formatting (no **, no ##, no `, no - lists).
- Paragraphs are separated by "∥NT∥". You MUST return the same number of "∥NT∥" separated sections.
- Only output the translated text. Do not add explanations, notes, or extra content.
- Keep proper nouns, brand names, and technical terms in their original form when appropriate.
- Preserve placeholders like ⟨NT_CODE_N⟩ exactly as-is. Do not translate, modify, or remove them.
- Auto-detect the source language. If a paragraph is already in ${targetLanguage}, return it as-is.
${glossary ? `\nGlossary — translate these terms consistently across all paragraphs:\n${glossary.join(", ")}` : ""}

User Prompt:
{batched paragraphs joined by "\n∥NT∥\n"}
```

### 翻译缓存

- **会话内缓存**：Content Script 维护 `Map<string, string>`，key 为段落文本与目标语言拼接后的 FNV-1a 哈希值（即 `fnv1a(text + "\0" + targetLanguage)`，使用 NUL 分隔避免拼接歧义；纯同步计算，适合内存缓存场景；SHA-256 via SubtleCrypto 是异步的，对会话内 Map 查找来说过重），value 为翻译结果。MutationObserver 触发增量翻译或 SPA 导航后重新翻译时，先查缓存命中则直接使用，不发送 API 请求。当用户在 Popup 中更改 `targetLanguage` 后重新触发翻译，由于 cache key 包含语言信息，旧语言的缓存不会被错误命中
- **持久化缓存（P6 增强）**：可选地将翻译结果持久化到 `chrome.storage.local`，key 格式为 `cache:{origin}:{hash}`。设置 LRU 上限（每个 origin 最多 5000 条）和 TTL（7 天过期），避免存储无限膨胀。页面刷新或再次访问同一页面时可直接使用缓存译文，无需重新调用 API

### 错误处理

- 单个批次翻译失败不阻塞其他批次
- 失败的段落下方显示"翻译失败，点击重试"提示，用户可手动触发重试
- API Key 无效等全局错误通过 Popup 提示用户检查设置
- 网络断开或请求超时（默认 30s）时，显示网络错误提示并暂停队列，网络恢复后可手动重试
- 翻译结果解析失败时的处理：**JSON mode 下**，如果响应不是合法 JSON 或 `translations` 数组长度与 `texts` 不匹配，视为该批次失败，回退到逐段重试（逐段重试仍使用 JSON mode，单段不存在数量不匹配问题；如果单段 JSON 解析也失败——例如模型返回纯文本或包裹了 markdown 代码块——则尝试容错恢复：先用正则 `` /```(?:json)?\s*([\s\S]*?)```/ `` 剥离 markdown 代码块后重新 `JSON.parse`；仍失败则将原始响应文本 `trim()` 后直接作为译文使用，因为单段场景下原始文本大概率就是翻译结果本身）。**JSON mode 自动探测失败**：当 `jsonMode` 为 `'auto'` 且首批请求返回 HTTP 400/422 时，Background 将 `jsonMode` 持久化为 `'disabled'`，以分隔符模式重试该批次（不计为用户可见的失败）。**分隔符模式下**，`∥NT∥` 分隔段数与原文不匹配时，先 `trim()` 整个响应文本，再按 `\n∥NT∥\n` 分割（分隔符两侧的换行符是 Prompt 要求的格式），每个分段再 `trim()` 去除首尾空白。如果分割结果数量与原文段落数一致则匹配成功；否则尝试宽松模式（按 `∥NT∥` 分割，忽略前后换行），仍不匹配则视为失败，回退到逐段重试

### 译文内联插入

- 译文作为 `<div class="nt-translation">` 插入到英文段落下方，**必须使用 `textContent` 赋值**（而非 `innerHTML`），防止 AI 返回的内容中包含恶意 HTML/JS 导致 XSS
- 源段落和对应译文 div 通过 `data-nt-id` 属性关联（递增计数器），用于在框架重渲染后重新匹配。Content Script 维护 `Map<string, { sourceEl: WeakRef<Element>, translatedText: string }>`（key 为 `nt-id`），当 MutationObserver 检测到 `nt-translation` 节点被移除时，检查对应的源元素（通过 `data-nt-id` 匹配）是否仍然存在（`isConnected`），如果源元素仍在文档中则重新注入缓存的译文。这解决了 React/Vue/Svelte 等框架的 DOM 协调（reconciliation）可能移除注入节点的问题
- 译文 div 添加 `lang` 属性，值根据 `ProviderConfig.targetLanguage` 映射（如 `"Simplified Chinese"` → `"zh-CN"`、`"Japanese"` → `"ja"`），确保屏幕阅读器正确识别语言、浏览器正确选择字体和排版规则
- 使用 `nt-` 前缀的 CSS 类名避免与页面样式冲突；译文样式使用高特异性选择器（如 `div.nt-translation[data-nt]`）并对关键属性添加 `!important`，防止页面全局样式（如 `* { color: red }` 或 CSS reset）覆盖译文显示。**所有译文样式必须定义在扩展的静态 CSS 文件中**（通过 `chrome.scripting.insertCSS` 注入），**禁止在 Content Script 中通过 `element.style` 或 `document.createElement('style')` 设置样式**——前者设置的 inline style 不受页面 CSP 限制但会降低可维护性且无法使用伪元素/media query，后者在严格 CSP 页面会被拦截（详见核心流程第 3 步 CSP 兼容性说明）。唯一例外：`data-nt-theme` 属性的动态设置（通过 `setAttribute`），因为它仅切换 CSS 变量的选择器匹配，不涉及 inline style
- 译文通过左边框 + 浅色文字区分于原文。**自动适配明暗主题**：Content Script 在注入时检测页面背景亮度——从 defuddle 定位到的主体容器开始，沿 DOM 树向上遍历至 `<body>` → `<html>`，对每个节点调用 `getComputedStyle` 读取 `backgroundColor`，取第一个非透明（alpha > 0）的值计算相对亮度；如果所有祖先均为透明则默认为亮色主题（白色背景假设）。根据亮度结果选择明色方案（浅灰背景 + `#555` 文字 + `#4A90D9` 边框）或暗色方案（深灰背景 + `#bbb` 文字 + `#5BA0E0` 边框），通过在根译文容器上添加 `data-nt-theme="light|dark"` 属性切换 CSS 变量
- **防止复制污染**：译文 div 默认设置 `user-select: none`，避免用户框选原文时误选译文。译文 div 在 hover 时显示一个小型"复制译文"按钮（`nt-copy-btn`），点击后通过 `navigator.clipboard.writeText` 复制译文内容
- 再次点击「翻译全文」可以切换显示/隐藏译文

### 页面内进度指示

除了扩展图标 Badge 外，在页面内显示翻译进度，用户无需查看工具栏即可感知状态：

- Content Script 在翻译开始时注入一个固定定位（`position: fixed`）的进度条，位于页面顶部（类似 NProgress 风格的细长条），使用 `nt-progress` 前缀 class
- 显示"翻译中... 42%"文本 + 进度条动画
- 翻译完成时进度条显示绿色并在 1 秒后淡出移除
- 翻译失败时显示红色并保留 3 秒
- 翻译取消时立即移除
- 使用与译文相同的明暗主题适配逻辑

### 扩展图标状态指示

通过 `chrome.action.setBadgeText` 和 `chrome.action.setBadgeBackgroundColor` 在扩展图标上显示翻译状态，即使 Popup 关闭用户也能感知进度：

- **翻译中**：显示蓝色 Badge，文本为已完成百分比（如 `42%`）。**所有 `setBadgeText` / `setBadgeBackgroundColor` 调用必须传入 `tabId` 参数**，确保多 tab 同时翻译时各 tab 的 Badge 状态互不覆盖
- **翻译完成**：显示绿色 Badge `✓`，3 秒后自动清除
- **已取消**：显示灰色 Badge `—`，3 秒后自动清除（用户在翻译进行中点击取消触发）
- **翻译失败**：显示红色 Badge `!`，用户点击 Popup 可查看详细错误

### 项目文件结构

```
NextTranslate/
├── src/
│   ├── background/
│   │   └── index.ts          # Service Worker：API 调用、消息路由、快捷键/右键菜单处理
│   ├── content/
│   │   ├── index.ts          # Content Script 入口
│   │   ├── extractor.ts      # 使用 defuddle 提取主体段落
│   │   ├── translator.ts     # 翻译调度（分段、缓存、并发控制）
│   │   ├── injector.ts       # 将译文 DOM 插入页面
│   │   ├── progress.ts       # 页面内进度条组件
│   │   └── style.css         # 译文注入样式 + 进度条样式
│   ├── popup/
│   │   ├── index.html        # Popup 页面
│   │   ├── index.ts          # Popup 逻辑
│   │   └── style.css         # Popup 样式
│   ├── shared/
│   │   ├── types.ts          # 共享类型定义
│   │   ├── messages.ts       # 消息通信协议
│   │   └── storage.ts        # chrome.storage 读写封装（含动态权限申请）
├── tests/
│   ├── unit/                 # Vitest 单元测试
│   │   ├── extractor.test.ts # 段落提取、过滤逻辑
│   │   ├── translator.test.ts # 分段、分隔符/JSON 解析、token 估算
│   │   └── injector.test.ts  # 译文注入、主题检测
│   ├── fixtures/             # 测试用 HTML 快照（真实页面结构）
│   └── e2e/                  # Puppeteer E2E 测试（加载扩展 + mock API server）
├── public/
│   ├── manifest.json         # Chrome Extension Manifest V3
│   └── icons/                # 扩展图标
├── package.json
├── tsconfig.json
├── vite.config.ts
└── CLAUDE.md
```

### 开发分阶段规划

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| P0 | 项目脚手架搭建（Vite + TS + Manifest V3 + Vitest） | 基础 |
| P1 | Popup 设置页（endpoint/key/model/targetLanguage 配置 + 存储 + 动态权限申请） | 核心 |
| P2 | Content Script + defuddle 主体提取 + 段落收集 | 核心 |
| P3 | Background API 调用 + 请求队列 + JSON mode/分隔符模式 + 翻译流程串通 + mock API server | 核心 |
| P4 | 译文内联插入 + data-nt-id 关联 + 样式 + 页面内进度条 + Badge 状态指示 | 核心 |
| P5 | 多 Tab 队列隔离 + Tab 生命周期清理 + SW keepalive（心跳 + alarm） + 快捷键/右键菜单 | 核心 |
| P6 | 懒加载监听（MutationObserver）+ 框架重渲染恢复 + 会话内翻译缓存 + 安全上限 + iframe/Shadow DOM + 持久化缓存 + 体验优化 | 增强 |

### 测试策略

- **单元测试（Vitest）**：覆盖纯逻辑模块——段落提取与过滤（`extractor.ts`）、分隔符/JSON 响应解析（`translator.ts`）、token 估算、中文字符占比检测、主题亮度检测等。不依赖真实浏览器 API，通过 mock `chrome.*` 对象测试消息通信和存储逻辑
- **集成测试（HTML 快照）**：将真实网页（GitHub README、Medium 文章、Hacker News、文档站点等）保存为 HTML 快照文件放入 `tests/fixtures/`，使用 JSDOM 或 Happy DOM 加载后测试 extractor 能否正确识别主体区域、提取段落、过滤代码块和中文内容
- **E2E 测试（Puppeteer）**：使用 Puppeteer 以 `--load-extension` 参数加载打包后的扩展，启动一个本地 mock API server（返回固定翻译结果），测试完整的翻译流程：点击 Popup → 译文出现 → 切换显示/隐藏 → 取消翻译等。P3 阶段搭建 mock API server，P4 之后逐步补充 E2E 用例
