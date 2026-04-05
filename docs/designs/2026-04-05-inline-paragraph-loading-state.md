# 段落内联 Loading 状态

**Date:** 2026-04-05

## Context

当前翻译体验存在明显缺陷：用户点击翻译后，只能通过右下角的全局进度条感知翻译进度，每个段落本身没有任何视觉反馈。用户无法判断某个具体段落"是否正在翻译"以及"翻译结果会出现在哪里"，翻译结果突然插入也会造成轻微的布局跳动感。

目标是在每个待翻译段落上增加内联 loading 状态，并通过预占位消除布局跳动，提升整体翻译体验。

## Discussion

**位置选择**：经过对三种方案的讨论，最终选择"两者结合"——在原文段落末尾显示动态 loading dots，同时在译文将要出现的位置提前插入一个 skeleton 占位块。单纯在源文末尾加 dots 无法消除布局跳动；单纯加 skeleton 则缺乏与段落的直接关联感。

**方案选型**：在以下三种方案中最终选定方案 A：

| 方案 | 描述 | 放弃原因 |
|------|------|---------|
| **A（选定）** | 源文末尾 dots + 译文位置 skeleton 占位 | — |
| B | 单行高度预留 + 末尾文字标签 | 多行译文仍会跳动 |
| C | 末尾 spinner + 译文渐入 | 无法消除布局跳动，大量 spinner 视觉嘈杂 |

**关键技术约束**：
- `extractTextWithCodeProtection` 已通过 clone + 移除所有 `[data-nt]` 节点来隔离 UI 元素，dots span 只需加 `data-nt` 属性即可自动被文本提取排除，不影响翻译质量。
- `shouldSkipElement` 已过滤 `nt-` 前缀 class 的元素，skeleton 占位块不会被误识别为待翻译段落。
- 缓存命中的段落直接同步渲染，不应出现 loading 状态，新的 `onBlocksQueued` 回调设计在缓存渲染之后触发，天然规避此问题。

**译文揭示动画**：选择在 loading → 文字切换时触发短暂的 `nt-reveal` fade-in 动画（0.25s），只在从 loading 状态转换时加该 class，避免缓存命中块触发多余动画。

## Approach

在 `Translator` 中新增一个 `onBlocksQueued` 回调，在段落收集、缓存渲染完成后，将所有仍处于 pending 状态的段落元素一次性通知给外部。`Injector` 接收通知后，在每个 pending 段落上同时挂载两个 loading UI：源文末尾的呼吸动画三点（`···`）和译文位置的 shimmer skeleton 占位块。当翻译结果到达时，`insertTranslation` 方法在填入文字的同时清理 loading 状态，触发淡入动画揭示译文。

这一方案改动最小、职责清晰：`Translator` 只负责通知，`Injector` 统一管理 loading 生命周期，现有的插入位置逻辑（`shouldAppendInside`）无需修改。

## Architecture

### 改动文件清单

| 文件 | 改动类型 |
|------|---------|
| `src/content/translator.ts` | 新增 `onBlocksQueued?` 回调接口，在 `start()` 中触发 |
| `src/content/injector.ts` | 新增 `showLoadingPlaceholder()`、`clearLoadingIndicators()`；修改 `insertTranslation()`、`removeAll()`、`setVisibility()` |
| `src/content/index.ts` | 实现 `onBlocksQueued`，在 `onError`/`onCancelled` 中调用清理 |
| `src/content/style.css` | 新增 dots 动画、shimmer skeleton、fade-in 揭示共 3 段样式 |

---

### Translator 改动

**`TranslatorCallbacks` 接口**新增可选回调：

```typescript
onBlocksQueued?: (elements: Element[]) => void;
```

**`start()` 方法**在初始缓存渲染循环完成后，触发回调：

```typescript
// 所有 tryRenderBlock 调用完成后
if (this.callbacks.onBlocksQueued) {
  const pendingEls = this.blockStates
    .filter(bs => !bs.rendered)
    .map(bs => bs.element);
  if (pendingEls.length > 0) {
    this.callbacks.onBlocksQueued(pendingEls);
  }
}
```

---

### Injector 改动

**新增状态**：

```typescript
private pendingDotsElements = new Set<HTMLElement>();
```

**`showLoadingPlaceholder(sourceEl: Element)`**（新增）：

1. 复用 `ntIdCounter` 分配 `ntId`，写入 `data-nt-id`（确保后续 `findExistingTranslation` 能定位到占位块）
2. 创建 `.nt-pending-dots[data-nt][data-nt-theme]` span，文字 `···`，追加到 `sourceEl` 末尾，加入 `pendingDotsElements`
3. 创建 `.nt-translation.nt-loading[data-nt][data-nt-id][data-nt-theme]` 占位块，按 `shouldAppendInside` 逻辑插入正确位置，加入 `translationElements`

**`insertTranslation(sourceEl, text)`**（新增部分）：

```typescript
// 找到已有翻译元素（可能是 loading 占位块）后：
if (translationEl.classList.contains('nt-loading')) {
  translationEl.classList.remove('nt-loading');
  translationEl.classList.add('nt-reveal');
  setTimeout(() => translationEl.classList.remove('nt-reveal'), 300);
}
translationEl.textContent = text;  // 已有逻辑

// 新增：移除源文末尾的 dots
const dotsEl = sourceEl.querySelector('.nt-pending-dots[data-nt]');
if (dotsEl) {
  dotsEl.remove();
  this.pendingDotsElements.delete(dotsEl as HTMLElement);
}
```

**`clearLoadingIndicators()`**（新增）：

```typescript
clearLoadingIndicators() {
  for (const el of this.pendingDotsElements) el.remove();
  this.pendingDotsElements.clear();
  for (const el of this.translationElements) {
    el.classList.remove('nt-loading', 'nt-reveal');
  }
}
```

调用时机：`removeAll()`、`setVisibility(false)`（即 `hideAll()`）。

---

### index.ts 改动

```typescript
const translator = new Translator({
  // ...已有回调...
  onBlocksQueued: (elements) => {
    for (const el of elements) injector.showLoadingPlaceholder(el);
  },
  onError: (error) => {
    injector.clearLoadingIndicators();  // 新增
    progressBar.error(error);
    reportTranslateStatus('error', latestProgress, error);
  },
  onCancelled: () => {
    state = 'idle';
    injector.clearLoadingIndicators();  // 新增
    progressBar.hide();
  },
});
```

---

### CSS 新增样式

```css
/* === 段落末尾 loading dots === */

.nt-pending-dots[data-nt] {
  display: inline-block !important;
  margin-left: 0.3em !important;
  color: #4A90D9 !important;
  user-select: none !important;
  animation: nt-dot-fade 1.4s ease-in-out infinite !important;
}

.nt-pending-dots[data-nt-theme="dark"] {
  color: #5BA0E0 !important;
}

@keyframes nt-dot-fade {
  0%, 100% { opacity: 0.2; }
  50%       { opacity: 1;   }
}

/* === 译文位置 Skeleton 占位块 === */

.nt-translation.nt-loading[data-nt] {
  min-height: 1.4em !important;
  border-radius: 3px !important;
  background: linear-gradient(
    90deg,
    rgba(74, 144, 217, 0.08) 25%,
    rgba(74, 144, 217, 0.18) 50%,
    rgba(74, 144, 217, 0.08) 75%
  ) !important;
  background-size: 200% 100% !important;
  animation: nt-shimmer 1.6s ease-in-out infinite !important;
}

.nt-translation.nt-loading[data-nt-theme="dark"] {
  background: linear-gradient(
    90deg,
    rgba(91, 160, 224, 0.08) 25%,
    rgba(91, 160, 224, 0.18) 50%,
    rgba(91, 160, 224, 0.08) 75%
  ) !important;
  background-size: 200% 100% !important;
}

@keyframes nt-shimmer {
  0%   { background-position: 200% 0;  }
  100% { background-position: -200% 0; }
}

/* === 译文揭示动画（仅从 loading 状态转换时触发） === */

.nt-translation.nt-reveal[data-nt] {
  animation: nt-fade-in 0.25s ease-out !important;
}

@keyframes nt-fade-in {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: translateY(0);   }
}
```

---

### 完整数据流

```
用户点击翻译
  ↓
translator.start() → collectParagraphs() → N 个段落
  ↓
建立 blockStates，同步填充缓存命中块
  ↓
tryRenderBlock 全部块
  → 缓存命中：onBatchTranslated → insertTranslation（直接渲染，无 loading）
  ↓
收集 filter(!bs.rendered) → M 个 pending 块
  ↓
onBlocksQueued(pendingElements[M])
  → injector.showLoadingPlaceholder(el) × M
  → 源文末尾追加 [···] + 译文位置插入 [shimmer skeleton]
  ↓
批次 API 请求发送中...
  ↓
某块返回 → tryRenderBlock → onBatchTranslated
  → injector.insertTranslation(el, text)
    ├─ 移除 nt-loading，加 nt-reveal（25ms fade-in）
    ├─ textContent = translatedText
    └─ 移除源文末尾 [···]
  ↓
所有块完成 → onComplete → progressBar 完成提示（保留右下角）
```

---

### 边界情况处理

| 场景 | 处理方式 |
|------|---------|
| 取消翻译 | `onCancelled` 调用 `injector.clearLoadingIndicators()`，清理全部 dots + loading skeleton |
| 翻译出错 | `onError` 中同样调用清理，避免 loading 状态永久悬挂 |
| 重新翻译 / SPA 导航 | `injector.removeAll()` 内含 `clearLoadingIndicators()` 调用 |
| 缓存命中块 | 不进入 `onBlocksQueued`，直接渲染，不显示任何 loading |
| 增量翻译（滚动加载） | 路径同样经过 `translator.start()`，自然触发 `onBlocksQueued` |
| 已翻译段落 | `collectParagraphs` 过滤掉，不出现在 `onBlocksQueued` 中 |
| dots 文字被重新提取 | `extractTextWithCodeProtection` clone 时删除所有 `[data-nt]` 节点，完全隔离 |
| 可见性切换（翻译完成后） | loading 状态早已清理，`setVisibility` 只操作 `.nt-translation` 即可 |
