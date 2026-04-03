# NextTranslate Chrome Extension 实现计划

**Goal:** 构建一个 Chrome 扩展，使用 AI 将网页英文内容翻译为中文，译文内联显示在原文下方。

**Architecture:** 三层架构——Popup（设置与触发）、Background Service Worker（API 调用与队列管理）、Content Script（内容提取与译文注入）。Content Script 按需注入（非 manifest 声明），通过 defuddle 库提取页面主体，批量发送至 OpenAI 兼容 API 翻译，译文以内联 DOM 方式插入。

**Tech Stack:** TypeScript, Vite (手动 Rollup 多入口), Chrome Extension Manifest V3, Vitest, defuddle, Puppeteer (E2E)

---

## P0: 项目脚手架搭建

### Task 1: 初始化 npm 项目

**Files:**
- Create: `package.json`

**Step 1: 初始化项目**

Run: `npm init -y`

**Step 2: 修改 package.json**

```json
{
  "name": "next-translate",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch --mode development",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 3: 验证 package.json 正确**

Run: `cat package.json`

---

### Task 2: 安装依赖

**Files:**
- Modify: `package.json`

**Step 1: 安装生产依赖**

Run: `npm install defuddle@0.13.0`

注意：defuddle 版本精确锁定，不使用 `^`。安装后在 `package.json` 中确认版本号无 `^` 前缀，如有需手动去除。

**Step 2: 安装开发依赖**

Run: `npm install -D typescript vite vitest @types/chrome happy-dom`

**Step 3: 验证安装**

Run: `ls node_modules/.package-lock.json 2>/dev/null; node -e "require('./node_modules/defuddle/package.json').version" 2>/dev/null || echo "check defuddle"`

---

### Task 3: 创建 TypeScript 配置

**Files:**
- Create: `tsconfig.json`

**Step 1: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vitest/globals"],
    "outDir": "dist",
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 2: 验证 TypeScript 配置**

Run: `npx tsc --noEmit`
Expected: 无错误（因为还没有源文件，应直接通过）

---

### Task 4: 创建 Vite 构建配置

**Files:**
- Create: `vite.config.ts`

**Step 1: 创建 vite.config.ts**

设计文档要求按需注入 Content Script（不在 manifest 中声明），因此需要将 background、content script、popup 作为独立入口打包。Content Script 不能使用 ES module 格式（`chrome.scripting.executeScript` 注入的脚本在页面上下文中运行，需要 IIFE 格式）。

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        popup: resolve(__dirname, 'src/popup/index.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Content script 需要固定文件名，供 chrome.scripting.executeScript 引用
          if (chunkInfo.name === 'content') return 'content/index.js';
          if (chunkInfo.name === 'background') return 'background/index.js';
          return '[name]/[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // Content Script 必须是 IIFE 格式，但 Rollup 多入口不支持混合 format。
        // 解决方案：使用单一 'es' format，content script 通过单独的 vite build 打包为 IIFE。
        // 简化方案：全部使用 'es' 格式，因为 chrome.scripting.executeScript
        // 在 MV3 中支持 ES module（通过 world: 'ISOLATED'）。
        // 但为最大兼容性，我们使用双构建方案。
      },
    },
  },
});
```

由于 Content Script 需要 IIFE 格式而 Background/Popup 需要 ES module，使用双构建策略。更新 `vite.config.ts`：

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'development' ? 'inline' : false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        popup: resolve(__dirname, 'src/popup/index.html'),
      },
      output: {
        entryFileNames: '[name]/index.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
```

再创建一个 Content Script 专用构建配置：

**Files:**
- Create: `vite.config.content.ts`

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist/content',
    emptyOutDir: false,
    sourcemap: mode === 'development' ? 'inline' : false,
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'NextTranslateContent',
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: {
        // 确保所有依赖内联（defuddle 等）
        inlineDynamicImports: true,
      },
    },
  },
}));
```

**Step 2: 更新 package.json scripts**

```json
{
  "scripts": {
    "dev": "npm run build:main -- --watch --mode development & npm run build:content -- --watch --mode development",
    "build": "tsc --noEmit && npm run build:main && npm run build:content",
    "build:main": "vite build",
    "build:content": "vite build --config vite.config.content.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

---

### Task 5: 创建 Manifest V3 配置

**Files:**
- Create: `public/manifest.json`
- Create: `public/icons/` (目录)

**Step 1: 创建 public 目录**

Run: `mkdir -p public/icons`

**Step 2: 创建 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "NextTranslate",
  "version": "0.1.0",
  "description": "AI-powered webpage translator - translate English content to Chinese inline",
  "permissions": ["activeTab", "storage", "scripting", "alarms", "contextMenus"],
  "optional_host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/index.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/index.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "commands": {
    "toggle-translate": {
      "suggested_key": { "default": "Alt+T", "mac": "MacCtrl+T" },
      "description": "Translate/cancel translation of current page"
    }
  }
}
```

**Step 3: 创建占位图标**

使用简单的 SVG 转 PNG 占位符（后续替换为正式图标）：

Run: `touch public/icons/icon16.png public/icons/icon48.png public/icons/icon128.png`

注意：空 PNG 会导致 Chrome 加载警告但不影响功能。正式开发时需替换为实际图标文件。

---

### Task 6: 创建最小源文件骨架（验证构建）

**Files:**
- Create: `src/background/index.ts`
- Create: `src/content/index.ts`
- Create: `src/popup/index.html`
- Create: `src/popup/index.ts`
- Create: `src/popup/style.css`
- Create: `src/shared/types.ts`
- Create: `src/shared/messages.ts`
- Create: `src/shared/storage.ts`

**Step 1: 创建目录结构**

Run: `mkdir -p src/{background,content,popup,shared} tests/{unit,fixtures,e2e}`

**Step 2: 创建共享类型骨架**

`src/shared/types.ts`:
```typescript
export interface ProviderConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  jsonMode: 'auto' | 'enabled' | 'disabled';
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  endpoint: '',
  apiKey: '',
  model: '',
  targetLanguage: 'Simplified Chinese',
  jsonMode: 'auto',
};
```

**Step 3: 创建消息类型骨架**

`src/shared/messages.ts`:
```typescript
// Popup → Content Script
export type ToggleTranslateMsg = { type: 'TOGGLE_TRANSLATE' };
export type ToggleTranslateResponse = {
  action: 'started' | 'cancelled' | 'toggled_visible' | 'toggled_hidden' | 'busy';
};

// Content Script → Background
export type TranslateBatchMsg = {
  type: 'TRANSLATE_BATCH';
  batchId: string;
  texts: string[];
  totalBatches: number;
};

export type CancelTranslateMsg = { type: 'CANCEL_TRANSLATE' };

// Background → sendResponse
export type TranslateBatchResult = {
  batchId: string;
  translations: string[];
  error?: string;
};

// Background → Popup (broadcast)
export type TranslateStatusMsg = {
  type: 'TRANSLATE_STATUS';
  status: 'translating' | 'done' | 'cancelled' | 'error';
  progress?: { completed: number; total: number };
  error?: string;
};

// Popup → Background
export type QueryStatusMsg = { type: 'QUERY_STATUS'; tabId: number };

// Popup → Background
export type TestConnectionMsg = { type: 'TEST_CONNECTION' };
export type TestConnectionResult = {
  success: boolean;
  error?: string;
};

// Content Script → Background (keepalive)
export type KeepaliveMsg = { type: 'KEEPALIVE' };

export type MessageFromContentScript =
  | TranslateBatchMsg
  | CancelTranslateMsg
  | KeepaliveMsg;

export type MessageFromPopup =
  | QueryStatusMsg
  | TestConnectionMsg;

export type MessageToContentScript =
  | ToggleTranslateMsg;
```

**Step 4: 创建存储工具骨架**

`src/shared/storage.ts`:
```typescript
import { ProviderConfig, DEFAULT_PROVIDER_CONFIG } from './types';

export async function loadProviderConfig(): Promise<ProviderConfig> {
  // TODO: P1 实现
  return DEFAULT_PROVIDER_CONFIG;
}

export async function saveProviderConfig(config: Partial<ProviderConfig>): Promise<void> {
  // TODO: P1 实现
}
```

**Step 5: 创建 Background 骨架**

`src/background/index.ts`:
```typescript
console.log('[NextTranslate] Background service worker started');

chrome.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
  sendResponse({ ok: true });
  return true;
});
```

**Step 6: 创建 Content Script 骨架**

`src/content/index.ts`:
```typescript
console.log('[NextTranslate] Content script injected');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TOGGLE_TRANSLATE') {
    sendResponse({ action: 'started' as const });
  }
});
```

**Step 7: 创建 Popup 骨架**

`src/popup/index.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NextTranslate</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <h1>NextTranslate</h1>
    <button id="translate-btn">翻译全文</button>
    <div id="settings">
      <h2>设置</h2>
      <label>
        API Endpoint
        <input type="text" id="endpoint" placeholder="https://api.openai.com/v1">
      </label>
      <label>
        API Key
        <input type="password" id="api-key" placeholder="sk-...">
      </label>
      <label>
        Model
        <input type="text" id="model" placeholder="gpt-4o-mini">
      </label>
    </div>
  </div>
  <script type="module" src="index.ts"></script>
</body>
</html>
```

`src/popup/index.ts`:
```typescript
console.log('[NextTranslate] Popup loaded');
```

`src/popup/style.css`:
```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  width: 360px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #333;
  padding: 16px;
}

h1 {
  font-size: 18px;
  margin-bottom: 12px;
}

h2 {
  font-size: 14px;
  margin-bottom: 8px;
  color: #666;
}

#translate-btn {
  width: 100%;
  padding: 10px;
  background: #4A90D9;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 15px;
  margin-bottom: 16px;
}

#translate-btn:hover {
  background: #3A7BC8;
}

#translate-btn:disabled {
  background: #ccc;
  cursor: not-allowed;
}

#settings label {
  display: block;
  margin-bottom: 12px;
  font-size: 13px;
  color: #555;
}

#settings input {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
}

#settings input:focus {
  outline: none;
  border-color: #4A90D9;
}
```

**Step 8: 验证构建**

Run: `npm run build`
Expected: `dist/` 目录生成以下文件：
- `dist/background/index.js`
- `dist/content/index.js`
- `dist/popup/index.html`
- `dist/popup/index.js` (或类似 hash 文件名)
- `dist/manifest.json` (从 public 复制)
- `dist/icons/`

---

### Task 7: 配置 Vitest

**Files:**
- Create: `vitest.config.ts`

**Step 1: 创建 vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
    },
  },
});
```

**Step 2: 创建一个验证测试**

`tests/unit/setup.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { DEFAULT_PROVIDER_CONFIG } from '@shared/types';

describe('项目设置验证', () => {
  it('默认配置应有正确的目标语言', () => {
    expect(DEFAULT_PROVIDER_CONFIG.targetLanguage).toBe('Simplified Chinese');
  });

  it('默认 jsonMode 应为 auto', () => {
    expect(DEFAULT_PROVIDER_CONFIG.jsonMode).toBe('auto');
  });
});
```

**Step 3: 运行测试**

Run: `npm test`
Expected: 2 个测试通过

---

### Task 8: 创建 CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

**Step 1: 创建 CLAUDE.md**

```markdown
# NextTranslate - Chrome Extension AI 翻译扩展

## 项目概述
Chrome Extension (Manifest V3)，使用 AI 翻译网页英文内容为中文，译文内联显示在原文段落下方。

## 技术栈
- TypeScript + Vite（手动 Rollup 多入口）
- Chrome Extension Manifest V3
- defuddle（页面主体内容提取）
- Vitest（单元测试）+ Puppeteer（E2E 测试）

## 构建命令
- `npm run dev` — 开发模式（watch + rebuild）
- `npm run build` — 生产构建
- `npm test` — 运行单元测试
- `npm run test:watch` — 监听模式测试

## 架构
- `src/background/` — Service Worker，处理 API 调用、消息路由、并发队列
- `src/content/` — Content Script，按需注入，处理内容提取、翻译调度、译文注入
- `src/popup/` — Popup 页面，设置与翻译触发
- `src/shared/` — 共享类型、消息协议、存储工具

## 关键约定
- Content Script 按需注入（不在 manifest 中声明 content_scripts）
- 所有样式使用 `nt-` 前缀，通过 chrome.scripting.insertCSS 注入（不动态创建 style 元素）
- 译文使用 textContent 赋值（防 XSS），不使用 innerHTML
- defuddle 版本精确锁定，不使用 `^`
- API Key 默认存储在 chrome.storage.local（不同步）
```

**Step 3: 提交**

Run: `git init && git add -A && git commit -m "P0: project scaffolding with Vite + TS + MV3 + Vitest"`

---

## P1: Popup 设置页

### Task 9: 实现存储工具（storage.ts）

**Files:**
- Modify: `src/shared/storage.ts`
- Create: `tests/unit/storage.test.ts`

**Step 1: 编写存储测试**

`tests/unit/storage.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.storage API
const mockStorage: Record<string, Record<string, unknown>> = { sync: {}, local: {} };

const createStorageArea = (area: Record<string, unknown>) => ({
  get: vi.fn((keys: string[]) => Promise.resolve(
    Object.fromEntries(keys.filter(k => k in area).map(k => [k, area[k]]))
  )),
  set: vi.fn((items: Record<string, unknown>) => {
    Object.assign(area, items);
    return Promise.resolve();
  }),
  remove: vi.fn((keys: string[]) => {
    keys.forEach(k => delete area[k]);
    return Promise.resolve();
  }),
});

vi.stubGlobal('chrome', {
  storage: {
    sync: createStorageArea(mockStorage.sync),
    local: createStorageArea(mockStorage.local),
  },
  permissions: {
    request: vi.fn(() => Promise.resolve(true)),
    remove: vi.fn(() => Promise.resolve(true)),
  },
});

import { loadProviderConfig, saveProviderConfig, requestEndpointPermission } from '@shared/storage';
import { DEFAULT_PROVIDER_CONFIG } from '@shared/types';

describe('storage', () => {
  beforeEach(() => {
    mockStorage.sync = {};
    mockStorage.local = {};
  });

  it('未配置时返回默认值', async () => {
    const config = await loadProviderConfig();
    expect(config).toEqual(DEFAULT_PROVIDER_CONFIG);
  });

  it('保存并加载非敏感设置到 sync', async () => {
    await saveProviderConfig({ endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    const config = await loadProviderConfig();
    expect(config.endpoint).toBe('https://api.openai.com/v1');
    expect(config.model).toBe('gpt-4o-mini');
  });

  it('API Key 默认存储在 local', async () => {
    await saveProviderConfig({ apiKey: 'sk-test123' });
    expect(mockStorage.local['nt:apiKey']).toBe('sk-test123');
    expect(mockStorage.sync['nt:apiKey']).toBeUndefined();
  });

  it('endpoint 自动去除末尾斜杠', async () => {
    await saveProviderConfig({ endpoint: 'https://api.openai.com/v1/' });
    const config = await loadProviderConfig();
    expect(config.endpoint).toBe('https://api.openai.com/v1');
  });

  it('requestEndpointPermission 请求正确的 origin 权限', async () => {
    const granted = await requestEndpointPermission('https://api.deepseek.com/v1');
    expect(granted).toBe(true);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://api.deepseek.com/*'],
    });
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/storage.test.ts`
Expected: FAIL（storage.ts 尚未实现）

**Step 3: 实现 storage.ts**

`src/shared/storage.ts`:
```typescript
import { ProviderConfig, DEFAULT_PROVIDER_CONFIG } from './types';

const SYNC_KEYS = ['nt:endpoint', 'nt:model', 'nt:targetLanguage', 'nt:jsonMode'] as const;
const LOCAL_KEYS = ['nt:apiKey'] as const;

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get([...SYNC_KEYS]),
    chrome.storage.local.get([...LOCAL_KEYS]),
  ]);

  // API Key：优先 sync（用户开启了同步），回退到 local
  const syncApiKey = (await chrome.storage.sync.get(['nt:apiKey']))['nt:apiKey'];

  return {
    endpoint: syncData['nt:endpoint'] ?? DEFAULT_PROVIDER_CONFIG.endpoint,
    apiKey: syncApiKey ?? localData['nt:apiKey'] ?? DEFAULT_PROVIDER_CONFIG.apiKey,
    model: syncData['nt:model'] ?? DEFAULT_PROVIDER_CONFIG.model,
    targetLanguage: syncData['nt:targetLanguage'] ?? DEFAULT_PROVIDER_CONFIG.targetLanguage,
    jsonMode: syncData['nt:jsonMode'] ?? DEFAULT_PROVIDER_CONFIG.jsonMode,
  };
}

export async function saveProviderConfig(config: Partial<ProviderConfig>): Promise<void> {
  const syncItems: Record<string, unknown> = {};
  const localItems: Record<string, unknown> = {};

  if (config.endpoint !== undefined) {
    syncItems['nt:endpoint'] = config.endpoint.replace(/\/+$/, '');
  }
  if (config.model !== undefined) {
    syncItems['nt:model'] = config.model;
  }
  if (config.targetLanguage !== undefined) {
    syncItems['nt:targetLanguage'] = config.targetLanguage;
  }
  if (config.jsonMode !== undefined) {
    syncItems['nt:jsonMode'] = config.jsonMode;
  }
  if (config.apiKey !== undefined) {
    localItems['nt:apiKey'] = config.apiKey;
  }

  const promises: Promise<void>[] = [];
  if (Object.keys(syncItems).length > 0) {
    promises.push(chrome.storage.sync.set(syncItems));
  }
  if (Object.keys(localItems).length > 0) {
    promises.push(chrome.storage.local.set(localItems));
  }
  await Promise.all(promises);
}

export async function requestEndpointPermission(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  const origin = `${url.protocol}//${url.host}/*`;
  return chrome.permissions.request({ origins: [origin] });
}

export async function removeEndpointPermission(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  const origin = `${url.protocol}//${url.host}/*`;
  return chrome.permissions.remove({ origins: [origin] });
}

export function isProviderConfigured(config: ProviderConfig): boolean {
  return config.endpoint !== '' && config.apiKey !== '' && config.model !== '';
}
```

**Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/storage.test.ts`
Expected: PASS

---

### Task 10: 实现 Popup 完整功能

**Files:**
- Modify: `src/popup/index.html`
- Modify: `src/popup/index.ts`
- Modify: `src/popup/style.css`

**Step 1: 完善 Popup HTML**

`src/popup/index.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NextTranslate</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <div id="header">
      <h1>NextTranslate</h1>
      <div id="status-bar" class="hidden"></div>
    </div>

    <button id="translate-btn" disabled>翻译全文</button>

    <div id="config-warning" class="hidden">
      <p>请先配置翻译服务</p>
    </div>

    <div id="settings">
      <h2>翻译设置</h2>

      <label>
        <span>API Endpoint</span>
        <input type="text" id="endpoint" placeholder="https://api.openai.com/v1" spellcheck="false">
      </label>

      <label>
        <span>API Key</span>
        <input type="password" id="api-key" placeholder="sk-..." spellcheck="false">
      </label>

      <label>
        <span>Model</span>
        <input type="text" id="model" placeholder="gpt-4o-mini" spellcheck="false">
      </label>

      <label>
        <span>目标语言</span>
        <select id="target-language">
          <option value="Simplified Chinese" selected>简体中文</option>
          <option value="Traditional Chinese">繁體中文</option>
          <option value="Japanese">日本語</option>
          <option value="Korean">한국어</option>
          <option value="English">English</option>
        </select>
      </label>

      <div id="settings-actions">
        <button id="save-btn">保存设置</button>
        <button id="test-btn">测试连接</button>
      </div>

      <div id="test-result" class="hidden"></div>
    </div>
  </div>
  <script type="module" src="index.ts"></script>
</body>
</html>
```

**Step 2: 实现 Popup 逻辑**

`src/popup/index.ts`:
```typescript
import { loadProviderConfig, saveProviderConfig, requestEndpointPermission, removeEndpointPermission, isProviderConfigured } from '@shared/storage';
import type { ProviderConfig } from '@shared/types';
import type { ToggleTranslateResponse, TranslateStatusMsg, TestConnectionResult } from '@shared/messages';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const translateBtn = $<HTMLButtonElement>('#translate-btn');
const saveBtn = $<HTMLButtonElement>('#save-btn');
const testBtn = $<HTMLButtonElement>('#test-btn');
const endpointInput = $<HTMLInputElement>('#endpoint');
const apiKeyInput = $<HTMLInputElement>('#api-key');
const modelInput = $<HTMLInputElement>('#model');
const targetLangSelect = $<HTMLSelectElement>('#target-language');
const configWarning = $<HTMLDivElement>('#config-warning');
const statusBar = $<HTMLDivElement>('#status-bar');
const testResult = $<HTMLDivElement>('#test-result');

let currentConfig: ProviderConfig;
let previousEndpoint = '';

// 初始化：加载配置
async function init() {
  currentConfig = await loadProviderConfig();
  previousEndpoint = currentConfig.endpoint;

  endpointInput.value = currentConfig.endpoint;
  apiKeyInput.value = currentConfig.apiKey;
  modelInput.value = currentConfig.model;
  targetLangSelect.value = currentConfig.targetLanguage;

  updateTranslateButton();
  await queryCurrentStatus();
}

function updateTranslateButton() {
  const configured = isProviderConfigured(currentConfig);
  translateBtn.disabled = !configured;
  configWarning.classList.toggle('hidden', configured);
}

// 保存设置
saveBtn.addEventListener('click', async () => {
  const newConfig: Partial<ProviderConfig> = {
    endpoint: endpointInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    targetLanguage: targetLangSelect.value,
  };

  // 动态权限申请
  if (newConfig.endpoint && newConfig.endpoint !== previousEndpoint) {
    try {
      // 先申请新域名权限
      const granted = await requestEndpointPermission(newConfig.endpoint);
      if (!granted) {
        showTestResult('需要授权才能访问翻译服务', 'error');
        return;
      }
      // 移除旧域名权限（如有）
      if (previousEndpoint) {
        await removeEndpointPermission(previousEndpoint).catch(() => {});
      }
      previousEndpoint = newConfig.endpoint;
    } catch {
      showTestResult('Endpoint URL 格式无效', 'error');
      return;
    }
  }

  await saveProviderConfig(newConfig);
  currentConfig = await loadProviderConfig();
  updateTranslateButton();
  showTestResult('设置已保存', 'success');
});

// 测试连接
testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testBtn.textContent = '测试中...';
  testResult.classList.remove('hidden');
  testResult.textContent = '正在连接...';
  testResult.className = 'testing';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }) as TestConnectionResult;
    if (result.success) {
      showTestResult('连接成功', 'success');
    } else {
      showTestResult(result.error ?? '连接失败', 'error');
    }
  } catch {
    showTestResult('无法连接到扩展后台', 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = '测试连接';
  }
});

// 翻译按钮
translateBtn.addEventListener('click', async () => {
  translateBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    let response: ToggleTranslateResponse;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    } catch {
      // Content Script 尚未注入，注入后重试
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/index.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/style.css'],
      });
      response = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    }

    updateUIFromResponse(response);
  } catch (e) {
    console.error('[NextTranslate] Toggle failed:', e);
  } finally {
    translateBtn.disabled = false;
  }
});

function updateUIFromResponse(response: ToggleTranslateResponse) {
  switch (response.action) {
    case 'started':
      translateBtn.textContent = '取消翻译';
      break;
    case 'cancelled':
      translateBtn.textContent = '翻译全文';
      break;
    case 'toggled_visible':
      translateBtn.textContent = '隐藏译文';
      break;
    case 'toggled_hidden':
      translateBtn.textContent = '显示译文';
      break;
    case 'busy':
      // 不改变 UI
      break;
  }
}

// 查询当前 tab 翻译状态
async function queryCurrentStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const status = await chrome.runtime.sendMessage({
      type: 'QUERY_STATUS',
      tabId: tab.id,
    }) as TranslateStatusMsg | null;

    if (status) {
      updateStatusUI(status);
    }
  } catch {
    // Background 可能未就绪
  }
}

// 监听翻译状态广播
chrome.runtime.onMessage.addListener((message: TranslateStatusMsg) => {
  if (message.type === 'TRANSLATE_STATUS') {
    updateStatusUI(message);
  }
});

function updateStatusUI(status: TranslateStatusMsg) {
  statusBar.classList.remove('hidden');

  switch (status.status) {
    case 'translating':
      if (status.progress) {
        const pct = Math.round((status.progress.completed / status.progress.total) * 100);
        statusBar.textContent = `翻译中... ${pct}%`;
        statusBar.className = 'translating';
      }
      translateBtn.textContent = '取消翻译';
      break;
    case 'done':
      statusBar.textContent = '翻译完成';
      statusBar.className = 'done';
      translateBtn.textContent = '隐藏译文';
      setTimeout(() => statusBar.classList.add('hidden'), 3000);
      break;
    case 'cancelled':
      statusBar.textContent = '已取消';
      statusBar.className = 'cancelled';
      translateBtn.textContent = '翻译全文';
      setTimeout(() => statusBar.classList.add('hidden'), 2000);
      break;
    case 'error':
      statusBar.textContent = status.error ?? '翻译出错';
      statusBar.className = 'error';
      break;
  }
}

function showTestResult(message: string, type: 'success' | 'error') {
  testResult.classList.remove('hidden');
  testResult.textContent = message;
  testResult.className = type;
  if (type === 'success') {
    setTimeout(() => testResult.classList.add('hidden'), 3000);
  }
}

init();
```

**Step 3: 完善 Popup 样式**

`src/popup/style.css`:
```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  width: 360px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #333;
  padding: 16px;
}

#header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

h1 {
  font-size: 18px;
}

h2 {
  font-size: 14px;
  margin-bottom: 8px;
  color: #666;
}

#status-bar {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
}
#status-bar.translating { background: #e3f2fd; color: #1565c0; }
#status-bar.done { background: #e8f5e9; color: #2e7d32; }
#status-bar.cancelled { background: #f5f5f5; color: #757575; }
#status-bar.error { background: #fce4ec; color: #c62828; }

.hidden { display: none !important; }

#translate-btn {
  width: 100%;
  padding: 10px;
  background: #4A90D9;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 15px;
  margin-bottom: 16px;
  transition: background 0.2s;
}
#translate-btn:hover { background: #3A7BC8; }
#translate-btn:disabled { background: #ccc; cursor: not-allowed; }

#config-warning {
  background: #fff3e0;
  color: #e65100;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 12px;
  font-size: 13px;
  text-align: center;
}

#settings label {
  display: block;
  margin-bottom: 12px;
  font-size: 13px;
  color: #555;
}
#settings label span { display: block; margin-bottom: 4px; }

#settings input, #settings select {
  display: block;
  width: 100%;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
}
#settings input:focus, #settings select:focus {
  outline: none;
  border-color: #4A90D9;
}

#settings-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
#settings-actions button {
  flex: 1;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 13px;
}
#settings-actions button:hover { background: #f5f5f5; }
#settings-actions button:disabled { opacity: 0.5; cursor: not-allowed; }

#save-btn { background: #4A90D9; color: white; border-color: #4A90D9; }
#save-btn:hover { background: #3A7BC8; }

#test-result {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
}
#test-result.success { background: #e8f5e9; color: #2e7d32; }
#test-result.error { background: #fce4ec; color: #c62828; }
#test-result.testing { background: #f5f5f5; color: #757575; }
```

**Step 4: 构建并手动测试**

Run: `npm run build`

然后在 Chrome 中加载 `dist/` 目录作为解压的扩展进行手动验证。

---

### Task 11: 提交 P1

Run: `git add -A && git commit -m "P1: popup settings page with storage, dynamic permissions"`

---

## P2: Content Script + defuddle 主体提取

### Task 12: 实现内容提取器（extractor.ts）

**Files:**
- Create: `src/content/extractor.ts`
- Create: `tests/unit/extractor.test.ts`

**Step 1: 编写提取器测试**

`tests/unit/extractor.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isChineseDominant,
  shouldSkipElement,
  extractTextWithCodeProtection,
  restoreCodePlaceholders,
  estimateTokens,
  splitIntoBatches,
} from '../../src/content/extractor';

describe('isChineseDominant', () => {
  it('纯中文返回 true', () => {
    expect(isChineseDominant('这是一段中文文字')).toBe(true);
  });

  it('纯英文返回 false', () => {
    expect(isChineseDominant('This is English text')).toBe(false);
  });

  it('中文占比 > 50% 返回 true', () => {
    expect(isChineseDominant('这是中文 with some English')).toBe(true);
  });

  it('中文占比 < 50% 返回 false', () => {
    expect(isChineseDominant('This is mostly English 少量中文')).toBe(false);
  });

  it('空字符串返回 false', () => {
    expect(isChineseDominant('')).toBe(false);
  });
});

describe('shouldSkipElement', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('跳过 code 元素', () => {
    const el = document.createElement('code');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 pre 元素', () => {
    const el = document.createElement('pre');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 script 元素', () => {
    const el = document.createElement('script');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 style 元素', () => {
    const el = document.createElement('style');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 aria-hidden 元素', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过 template 元素', () => {
    const el = document.createElement('template');
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('不跳过正常 p 元素', () => {
    const el = document.createElement('p');
    document.body.appendChild(el);
    el.textContent = 'Hello world, this is a test paragraph';
    expect(shouldSkipElement(el)).toBe(false);
  });

  it('跳过 nt- 前缀元素', () => {
    const el = document.createElement('div');
    el.className = 'nt-translation';
    expect(shouldSkipElement(el)).toBe(true);
  });

  it('跳过短文本（< 10 个非空白字符）', () => {
    const el = document.createElement('p');
    document.body.appendChild(el);
    el.textContent = 'Hi';
    expect(shouldSkipElement(el)).toBe(true);
  });
});

describe('extractTextWithCodeProtection', () => {
  it('替换内联 code 为占位符', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Use the <code>useState</code> hook to manage state';
    const { text, codeMap } = extractTextWithCodeProtection(p);
    expect(text).toContain('⟨NT_CODE_0⟩');
    expect(text).not.toContain('useState');
    expect(codeMap.get('⟨NT_CODE_0⟩')).toBe('useState');
  });

  it('多个 code 标签分别替换', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Call <code>fetchData</code> then <code>setState</code>';
    const { text, codeMap } = extractTextWithCodeProtection(p);
    expect(text).toContain('⟨NT_CODE_0⟩');
    expect(text).toContain('⟨NT_CODE_1⟩');
    expect(codeMap.size).toBe(2);
  });

  it('无 code 标签时直接返回文本', () => {
    const p = document.createElement('p');
    p.textContent = 'Simple paragraph without code';
    const { text, codeMap } = extractTextWithCodeProtection(p);
    expect(text).toBe('Simple paragraph without code');
    expect(codeMap.size).toBe(0);
  });
});

describe('restoreCodePlaceholders', () => {
  it('还原占位符为原始代码', () => {
    const codeMap = new Map([['⟨NT_CODE_0⟩', 'useState']]);
    const result = restoreCodePlaceholders('使用 ⟨NT_CODE_0⟩ hook 管理状态', codeMap);
    expect(result).toBe('使用 useState hook 管理状态');
  });

  it('占位符缺失时返回原始文本（降级）', () => {
    const codeMap = new Map([['⟨NT_CODE_0⟩', 'useState']]);
    const result = restoreCodePlaceholders('翻译结果没有占位符', codeMap);
    expect(result).toBe('翻译结果没有占位符');
  });
});

describe('estimateTokens', () => {
  it('英文文本按 1:3 估算', () => {
    const text = 'abc'; // 3 chars → ~1 token
    expect(estimateTokens(text)).toBeCloseTo(1, 0);
  });

  it('CJK 文本按 1:1.5 估算', () => {
    const text = '你好世'; // 3 CJK chars → 2 tokens
    expect(estimateTokens(text)).toBeCloseTo(2, 0);
  });
});

describe('splitIntoBatches', () => {
  it('短段落合并为一批', () => {
    const texts = ['Hello world', 'Foo bar', 'Baz qux'];
    const batches = splitIntoBatches(texts, 2000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([0, 1, 2]);
  });

  it('超长段落单独成批', () => {
    const shortText = 'Hello';
    const longText = 'A'.repeat(6000); // ~2000 tokens, 超过阈值
    const texts = [shortText, longText, shortText];
    const batches = splitIntoBatches(texts, 2000);
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/extractor.test.ts`
Expected: FAIL

**Step 3: 实现 extractor.ts**

`src/content/extractor.ts`:
```typescript
import Defuddle from 'defuddle';

// --- 常量 ---

const PARAGRAPH_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION', 'DT', 'DD']);
const SKIP_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT']);
const MIN_TEXT_LENGTH = 10;
const MAX_TEXT_LENGTH = 10000;
const DEFUDDLE_TIMEOUT_MS = 3000;

// --- 中文检测 ---

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

export function isChineseDominant(text: string): boolean {
  if (text.length === 0) return false;
  const stripped = text.replace(/\s/g, '');
  if (stripped.length === 0) return false;
  const cjkMatches = stripped.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  return cjkCount / stripped.length > 0.5;
}

// --- 元素过滤 ---

export function shouldSkipElement(el: Element): boolean {
  // 跳过扩展自身注入的节点
  if (el.className && typeof el.className === 'string' && el.className.split(' ').some(c => c.startsWith('nt-'))) {
    return true;
  }

  // 跳过代码和非文本标签
  if (SKIP_TAGS.has(el.tagName)) return true;

  // 跳过 aria-hidden
  if (el.getAttribute('aria-hidden') === 'true') return true;

  // 跳过隐藏元素（分层检测策略）
  if (isHidden(el)) return true;

  // 跳过短文本
  const text = (el.textContent ?? '').replace(/\s/g, '');
  if (text.length < MIN_TEXT_LENGTH) return true;

  // 跳过中文主导内容
  if (isChineseDominant(el.textContent ?? '')) return true;

  return false;
}

function isHidden(el: Element): boolean {
  // 纯 DOM 检测
  if (el.tagName === 'TEMPLATE') return true;

  // offsetParent 检测（对大多数 display:none 有效）
  if (el instanceof HTMLElement) {
    if (el.offsetParent === null) {
      // 排除 body 直接子元素和 fixed/sticky 定位
      if (el.parentElement === document.body || el === document.body) return false;
      const position = getComputedStyle(el).position;
      if (position === 'fixed' || position === 'sticky') {
        // 对 fixed/sticky 需要进一步检查
        const style = getComputedStyle(el);
        return style.display === 'none' || style.visibility === 'hidden';
      }
      return true;
    }
  }

  return false;
}

// --- 内联代码保护 ---

export function extractTextWithCodeProtection(el: Element): { text: string; codeMap: Map<string, string> } {
  const codeMap = new Map<string, string>();
  const codeElements = el.querySelectorAll(':scope > code, :scope code');

  // 如果没有内联 code，直接返回 textContent
  if (codeElements.length === 0) {
    return { text: el.textContent ?? '', codeMap };
  }

  // 克隆节点以避免修改原始 DOM
  const clone = el.cloneNode(true) as Element;
  const cloneCodeElements = clone.querySelectorAll('code');

  cloneCodeElements.forEach((code, index) => {
    const placeholder = `⟨NT_CODE_${index}⟩`;
    const originalText = code.textContent ?? '';
    codeMap.set(placeholder, originalText);
    code.textContent = placeholder;
  });

  return { text: clone.textContent ?? '', codeMap };
}

export function restoreCodePlaceholders(translatedText: string, codeMap: Map<string, string>): string {
  if (codeMap.size === 0) return translatedText;

  let result = translatedText;
  for (const [placeholder, original] of codeMap) {
    result = result.replace(placeholder, original);
  }
  return result;
}

// --- Token 估算 ---

export function estimateTokens(text: string): number {
  let cjkChars = 0;
  let otherChars = 0;

  for (const char of text) {
    if (CJK_REGEX.test(char)) {
      cjkChars++;
    } else {
      otherChars++;
    }
    CJK_REGEX.lastIndex = 0; // reset regex state
  }

  return cjkChars / 1.5 + otherChars / 3;
}

// --- 批次分割 ---

export function splitIntoBatches(texts: string[], tokenThreshold: number = 2000): number[][] {
  const batches: number[][] = [];
  let currentBatch: number[] = [];
  let currentTokens = 0;

  for (let i = 0; i < texts.length; i++) {
    const tokens = estimateTokens(texts[i]);

    // 超长段落单独成批
    if (tokens > tokenThreshold) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([i]);
      continue;
    }

    if (currentTokens + tokens > tokenThreshold && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(i);
    currentTokens += tokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// --- 术语提取 ---

export function extractGlossaryTerms(texts: string[], maxTerms: number = 30): string[] {
  const termCounts = new Map<string, number>();

  for (const text of texts) {
    // 匹配大写字母开头的词组（1-3 个单词）
    const matches = text.match(/\b[A-Z][a-zA-Z]*(?:\s+[A-Za-z]+){0,2}\b/g) ?? [];
    for (const match of matches) {
      const term = match.trim();
      if (term.length > 2) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      }
    }
  }

  // 只保留出现 >= 2 次的术语
  return Array.from(termCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term]) => term);
}

// --- 超长段落拆分 ---

export function splitLongText(text: string, maxTokens: number = 4000): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const sentences = text.split(/(?<=[.?!。？！])\s+/);
  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (estimateTokens(current + ' ' + sentence) > maxTokens && current) {
      parts.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.length > 0 ? parts : [text];
}

// --- 主体提取 ---

export interface ExtractedParagraph {
  element: Element;
  text: string;
  codeMap: Map<string, string>;
}

export async function findMainContainer(): Promise<Element> {
  try {
    const result = await Promise.race([
      new Promise<{ content: string; debug?: { contentSelector?: string } }>((resolve) => {
        const parsed = new Defuddle(document, { debug: true }).parse();
        resolve(parsed);
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('defuddle timeout')), DEFUDDLE_TIMEOUT_MS)
      ),
    ]);

    // 通过 contentSelector 定位原始 DOM 中的主体容器
    if (result.debug?.contentSelector) {
      const container = document.querySelector(result.debug.contentSelector);
      if (container) return container;
    }

    // 回退：文本指纹匹配
    if (result.content) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = result.content;
      const fingerprint = (tempDiv.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (fingerprint.length > 50) {
        const found = findContainerByFingerprint(document.body, fingerprint);
        if (found) return found;
      }
    }
  } catch {
    // defuddle 失败或超时，回退到 body
  }

  return document.body;
}

function findContainerByFingerprint(root: Element, fingerprint: string): Element | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let bestMatch: Element | null = null;
  let bestLength = Infinity;

  let node: Node | null = walker.currentNode;
  while (node) {
    if (node instanceof Element) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.includes(fingerprint) && text.length < bestLength) {
        bestMatch = node;
        bestLength = text.length;
      }
    }
    node = walker.nextNode();
  }

  return bestMatch;
}

// --- 段落收集 ---

export function collectParagraphs(container: Element, translatedSet: Set<Element>): ExtractedParagraph[] {
  const paragraphs: ExtractedParagraph[] = [];
  const visited = new Set<Element>();

  function walk(el: Element) {
    if (shouldSkipElement(el)) return;
    if (translatedSet.has(el)) return;

    // 检查是否为段落标签
    if (PARAGRAPH_TAGS.has(el.tagName)) {
      // 最内层匹配：如果子节点中有段落标签，让子节点处理
      const hasChildParagraph = Array.from(el.children).some(child => PARAGRAPH_TAGS.has(child.tagName));
      if (!hasChildParagraph && !visited.has(el)) {
        visited.add(el);
        const { text, codeMap } = extractTextWithCodeProtection(el);
        const trimmed = text.trim();
        if (trimmed.length >= MIN_TEXT_LENGTH && trimmed.length <= MAX_TEXT_LENGTH) {
          paragraphs.push({ element: el, text: trimmed, codeMap });
        }
      }
    }

    // 继续遍历子节点
    for (const child of el.children) {
      walk(child);
    }
  }

  walk(container);
  return paragraphs;
}
```

**Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/extractor.test.ts`
Expected: PASS

---

### Task 13: 提交 P2

Run: `git add -A && git commit -m "P2: content script extractor with defuddle, paragraph collection, code protection"`

---

## P3: Background API 调用 + 翻译流程

### Task 14: 实现 Prompt 构建与响应解析

**Files:**
- Create: `src/shared/prompt.ts`
- Create: `tests/unit/prompt.test.ts`

**Step 1: 编写 Prompt/解析 测试**

`tests/unit/prompt.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  buildTranslateRequest,
  parseJsonModeResponse,
  parseSeparatorModeResponse,
  NT_SEPARATOR,
} from '../../src/shared/prompt';

describe('buildTranslateRequest', () => {
  it('JSON mode 构建正确的请求体', () => {
    const req = buildTranslateRequest({
      texts: ['Hello world', 'Good morning'],
      targetLanguage: 'Simplified Chinese',
      model: 'gpt-4o-mini',
      mode: 'json',
    });
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(req.messages[1].content).toContain('"texts"');
    expect(req.messages[0].content).toContain('Simplified Chinese');
  });

  it('分隔符模式不包含 response_format', () => {
    const req = buildTranslateRequest({
      texts: ['Hello world', 'Good morning'],
      targetLanguage: 'Simplified Chinese',
      model: 'gpt-4o-mini',
      mode: 'separator',
    });
    expect(req.response_format).toBeUndefined();
    expect(req.messages[1].content).toContain(NT_SEPARATOR);
  });

  it('包含术语表', () => {
    const req = buildTranslateRequest({
      texts: ['Hello'],
      targetLanguage: 'Simplified Chinese',
      model: 'gpt-4o-mini',
      mode: 'json',
      glossary: ['Dependency Injection', 'Middleware'],
    });
    expect(req.messages[0].content).toContain('Dependency Injection');
    expect(req.messages[0].content).toContain('Middleware');
  });
});

describe('parseJsonModeResponse', () => {
  it('解析正确的 JSON 响应', () => {
    const raw = '{"translations": ["你好世界", "早上好"]}';
    const result = parseJsonModeResponse(raw, 2);
    expect(result).toEqual({ translations: ['你好世界', '早上好'] });
  });

  it('数量不匹配时返回 null', () => {
    const raw = '{"translations": ["你好世界"]}';
    const result = parseJsonModeResponse(raw, 2);
    expect(result).toBeNull();
  });

  it('非法 JSON 返回 null', () => {
    const result = parseJsonModeResponse('not json', 1);
    expect(result).toBeNull();
  });

  it('剥离 markdown 代码块后解析', () => {
    const raw = '```json\n{"translations": ["你好"]}\n```';
    const result = parseJsonModeResponse(raw, 1);
    expect(result).toEqual({ translations: ['你好'] });
  });

  it('单段时非法 JSON 回退为原始文本', () => {
    const result = parseJsonModeResponse('你好世界', 1);
    expect(result).toEqual({ translations: ['你好世界'] });
  });
});

describe('parseSeparatorModeResponse', () => {
  it('解析正确的分隔符响应', () => {
    const raw = '你好世界\n∥NT∥\n早上好';
    const result = parseSeparatorModeResponse(raw, 2);
    expect(result).toEqual({ translations: ['你好世界', '早上好'] });
  });

  it('宽松模式（分隔符两侧无换行）', () => {
    const raw = '你好世界∥NT∥早上好';
    const result = parseSeparatorModeResponse(raw, 2);
    expect(result).toEqual({ translations: ['你好世界', '早上好'] });
  });

  it('数量不匹配时返回 null', () => {
    const raw = '你好世界\n∥NT∥\n早上好\n∥NT∥\n下午好';
    const result = parseSeparatorModeResponse(raw, 2);
    expect(result).toBeNull();
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/prompt.test.ts`
Expected: FAIL

**Step 3: 实现 prompt.ts**

`src/shared/prompt.ts`:
```typescript
export const NT_SEPARATOR = '∥NT∥';

interface TranslateRequestParams {
  texts: string[];
  targetLanguage: string;
  model: string;
  mode: 'json' | 'separator';
  glossary?: string[];
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature: number;
  response_format?: { type: 'json_object' };
}

const GLOSSARY_BLOCK = (glossary: string[]) =>
  `\nGlossary — translate these terms consistently across all paragraphs:\n${glossary.join(', ')}`;

function buildSystemPrompt(targetLanguage: string, mode: 'json' | 'separator', glossary?: string[]): string {
  const glossaryStr = glossary && glossary.length > 0 ? GLOSSARY_BLOCK(glossary) : '';

  if (mode === 'json') {
    return `You are a translation engine. Translate the following text into ${targetLanguage}.
Rules:
- You will receive a JSON object with a "texts" array containing paragraphs to translate.
- Return a JSON object with a "translations" array containing the translated paragraphs.
- The "translations" array MUST have the same length as the "texts" array.
- Output plain text only in each translation. Do not use any markdown formatting.
- Keep proper nouns, brand names, and technical terms in their original form when appropriate.
- Preserve placeholders like ⟨NT_CODE_N⟩ exactly as-is. Do not translate, modify, or remove them.
- Auto-detect the source language. If a paragraph is already in ${targetLanguage}, return it as-is.${glossaryStr}`;
  }

  return `You are a translation engine. Translate the following text into ${targetLanguage}.
Rules:
- Preserve the original paragraph structure.
- Output plain text only. Do not use any markdown formatting (no **, no ##, no \`, no - lists).
- Paragraphs are separated by "${NT_SEPARATOR}". You MUST return the same number of "${NT_SEPARATOR}" separated sections.
- Only output the translated text. Do not add explanations, notes, or extra content.
- Keep proper nouns, brand names, and technical terms in their original form when appropriate.
- Preserve placeholders like ⟨NT_CODE_N⟩ exactly as-is. Do not translate, modify, or remove them.
- Auto-detect the source language. If a paragraph is already in ${targetLanguage}, return it as-is.${glossaryStr}`;
}

export function buildTranslateRequest(params: TranslateRequestParams): ChatCompletionRequest {
  const { texts, targetLanguage, model, mode, glossary } = params;
  const systemPrompt = buildSystemPrompt(targetLanguage, mode, glossary);

  const userContent = mode === 'json'
    ? JSON.stringify({ texts })
    : texts.join(`\n${NT_SEPARATOR}\n`);

  const request: ChatCompletionRequest = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
  };

  if (mode === 'json') {
    request.response_format = { type: 'json_object' };
  }

  return request;
}

// --- 响应解析 ---

interface ParsedTranslation {
  translations: string[];
}

export function parseJsonModeResponse(raw: string, expectedCount: number): ParsedTranslation | null {
  let text = raw.trim();

  // 尝试直接解析
  let parsed = tryParseJson(text);

  // 剥离 markdown 代码块
  if (!parsed) {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      parsed = tryParseJson(codeBlockMatch[1].trim());
    }
  }

  if (parsed && Array.isArray(parsed.translations)) {
    if (parsed.translations.length === expectedCount) {
      return { translations: parsed.translations.map((t: unknown) => String(t).trim()) };
    }
    return null; // 数量不匹配
  }

  // 单段场景：直接使用原始文本作为译文
  if (expectedCount === 1) {
    return { translations: [text] };
  }

  return null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseSeparatorModeResponse(raw: string, expectedCount: number): ParsedTranslation | null {
  const text = raw.trim();

  // 严格模式：按 \n∥NT∥\n 分割
  let parts = text.split(`\n${NT_SEPARATOR}\n`).map(s => s.trim());
  if (parts.length === expectedCount) {
    return { translations: parts };
  }

  // 宽松模式：按 ∥NT∥ 分割
  parts = text.split(NT_SEPARATOR).map(s => s.trim());
  if (parts.length === expectedCount) {
    return { translations: parts };
  }

  return null;
}
```

**Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/prompt.test.ts`
Expected: PASS

---

### Task 15: 实现 Background Service Worker

**Files:**
- Modify: `src/background/index.ts`

**Step 1: 实现完整 Background**

`src/background/index.ts`:
```typescript
import { loadProviderConfig, saveProviderConfig } from '@shared/storage';
import { buildTranslateRequest, parseJsonModeResponse, parseSeparatorModeResponse } from '@shared/prompt';
import type {
  TranslateBatchMsg,
  TranslateBatchResult,
  CancelTranslateMsg,
  TranslateStatusMsg,
  QueryStatusMsg,
  TestConnectionMsg,
  TestConnectionResult,
} from '@shared/messages';

// --- 类型 ---

interface TabState {
  abortControllers: Map<string, AbortController>;
  completedBatches: number;
  totalBatches: number;
  status: 'translating' | 'done' | 'cancelled' | 'error';
  error?: string;
}

// --- 状态 ---

const tabStates = new Map<number, TabState>();

// --- 请求队列（全局并发控制 + round-robin 调度） ---

const MAX_CONCURRENT = 3;
const REQUEST_INTERVAL_MS = 200;
let activeFetches = 0;

interface QueueItem {
  tabId: number;
  message: TranslateBatchMsg;
  sender: chrome.runtime.MessageSender;
  sendResponse: (result: TranslateBatchResult) => void;
}

const tabQueues = new Map<number, QueueItem[]>();
const activeTabIds: number[] = [];
let roundRobinIndex = 0;
let drainScheduled = false;

// 退避状态
let backoffUntil = 0;
let currentBackoffDelay = 2000;
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_MAX = 60000;

function enqueue(item: QueueItem) {
  const { tabId } = item;
  if (!tabQueues.has(tabId)) {
    tabQueues.set(tabId, []);
    activeTabIds.push(tabId);
  }
  tabQueues.get(tabId)!.push(item);
  scheduleDrain();
}

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;

  const now = Date.now();
  const delay = backoffUntil > now ? backoffUntil - now : 0;
  setTimeout(() => {
    drainScheduled = false;
    drain();
  }, delay);
}

function drain() {
  while (activeFetches < MAX_CONCURRENT && activeTabIds.length > 0) {
    // Round-robin: 从下一个 tab 取任务
    if (roundRobinIndex >= activeTabIds.length) {
      roundRobinIndex = 0;
    }

    const tabId = activeTabIds[roundRobinIndex];
    const queue = tabQueues.get(tabId);

    if (!queue || queue.length === 0) {
      activeTabIds.splice(roundRobinIndex, 1);
      tabQueues.delete(tabId);
      continue;
    }

    const item = queue.shift()!;
    roundRobinIndex++;
    activeFetches++;

    processItem(item).finally(() => {
      activeFetches--;
      if (activeTabIds.length > 0) {
        setTimeout(scheduleDrain, REQUEST_INTERVAL_MS);
      }
    });
  }
}

async function processItem(item: QueueItem) {
  const { tabId, message, sendResponse } = item;
  const state = getOrCreateTabState(tabId);
  const controller = new AbortController();
  state.abortControllers.set(message.batchId, controller);

  try {
    const config = await loadProviderConfig();
    const mode = config.jsonMode === 'disabled' ? 'separator' as const : 'json' as const;

    const requestBody = buildTranslateRequest({
      texts: message.texts,
      targetLanguage: config.targetLanguage,
      model: config.model,
      mode,
    });

    const url = `${config.endpoint}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    // 429 退避
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      const jitter = currentBackoffDelay * (0.8 + Math.random() * 0.4);
      const delay = retryAfter ?? jitter;
      currentBackoffDelay = Math.min(currentBackoffDelay * BACKOFF_MULTIPLIER, BACKOFF_MAX);
      backoffUntil = Date.now() + delay;

      // 保存退避状态
      chrome.storage.session?.set?.({
        'nt:backoffUntil': backoffUntil,
        'nt:backoffDelay': currentBackoffDelay,
      }).catch(() => {});

      // 重新入队
      enqueue(item);
      return;
    }

    // JSON mode 自动探测失败
    if ((response.status === 400 || response.status === 422) && config.jsonMode === 'auto' && mode === 'json') {
      await saveProviderConfig({ jsonMode: 'disabled' });
      // 以分隔符模式重新入队
      enqueue(item);
      return;
    }

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content ?? '';

    // JSON mode 首次成功，持久化
    if (config.jsonMode === 'auto' && mode === 'json') {
      const parsed = parseJsonModeResponse(rawContent, message.texts.length);
      if (parsed) {
        await saveProviderConfig({ jsonMode: 'enabled' });
        sendResponse({ batchId: message.batchId, translations: parsed.translations });
      } else {
        sendResponse({ batchId: message.batchId, translations: [], error: 'JSON parse failed' });
      }
    } else if (mode === 'json') {
      const parsed = parseJsonModeResponse(rawContent, message.texts.length);
      if (parsed) {
        sendResponse({ batchId: message.batchId, translations: parsed.translations });
      } else {
        sendResponse({ batchId: message.batchId, translations: [], error: 'JSON parse failed' });
      }
    } else {
      const parsed = parseSeparatorModeResponse(rawContent, message.texts.length);
      if (parsed) {
        sendResponse({ batchId: message.batchId, translations: parsed.translations });
      } else {
        sendResponse({ batchId: message.batchId, translations: [], error: 'Separator parse failed' });
      }
    }

    // 成功后重置退避
    currentBackoffDelay = 2000;

    // 更新进度
    state.completedBatches++;
    broadcastProgress(tabId, state);

  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      // 被取消，不发送响应
      return;
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    sendResponse({ batchId: message.batchId, translations: [], error: errorMsg });
  } finally {
    state.abortControllers.delete(message.batchId);
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// --- Tab 状态管理 ---

function getOrCreateTabState(tabId: number): TabState {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      abortControllers: new Map(),
      completedBatches: 0,
      totalBatches: 0,
      status: 'translating',
    });
  }
  return tabStates.get(tabId)!;
}

function clearTabState(tabId: number) {
  const state = tabStates.get(tabId);
  if (state) {
    for (const controller of state.abortControllers.values()) {
      controller.abort();
    }
  }
  tabStates.delete(tabId);

  // 清除队列
  tabQueues.delete(tabId);
  const idx = activeTabIds.indexOf(tabId);
  if (idx !== -1) activeTabIds.splice(idx, 1);

  // 清除 Badge
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
}

function broadcastProgress(tabId: number, state: TabState) {
  const progress = { completed: state.completedBatches, total: state.totalBatches };
  const pct = state.totalBatches > 0 ? Math.round((state.completedBatches / state.totalBatches) * 100) : 0;

  // Badge
  chrome.action.setBadgeText({ text: `${pct}%`, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#4A90D9', tabId }).catch(() => {});

  // 广播给 Popup
  const msg: TranslateStatusMsg = {
    type: 'TRANSLATE_STATUS',
    status: state.completedBatches >= state.totalBatches ? 'done' : 'translating',
    progress,
  };

  if (msg.status === 'done') {
    state.status = 'done';
    chrome.action.setBadgeText({ text: '✓', tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 3000);
  }

  chrome.runtime.sendMessage(msg).catch(() => {});
}

// --- 消息路由 ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'TRANSLATE_BATCH': {
      if (!tabId) return;
      const state = getOrCreateTabState(tabId);
      state.totalBatches = Math.max(state.totalBatches, message.totalBatches);
      enqueue({
        tabId,
        message: message as TranslateBatchMsg,
        sender,
        sendResponse: sendResponse as (result: TranslateBatchResult) => void,
      });
      return true; // 保持消息通道
    }

    case 'CANCEL_TRANSLATE': {
      if (!tabId) return;
      clearTabState(tabId);
      chrome.action.setBadgeText({ text: '—', tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E', tabId }).catch(() => {});
      setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 3000);
      chrome.runtime.sendMessage({
        type: 'TRANSLATE_STATUS',
        status: 'cancelled',
      } satisfies TranslateStatusMsg).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    case 'QUERY_STATUS': {
      const queryMsg = message as QueryStatusMsg;
      const state = tabStates.get(queryMsg.tabId);
      if (state) {
        sendResponse({
          type: 'TRANSLATE_STATUS',
          status: state.status,
          progress: { completed: state.completedBatches, total: state.totalBatches },
          error: state.error,
        } satisfies TranslateStatusMsg);
      } else {
        sendResponse(null);
      }
      return;
    }

    case 'TEST_CONNECTION': {
      handleTestConnection().then(sendResponse);
      return true; // 异步
    }

    case 'KEEPALIVE': {
      sendResponse(true);
      return;
    }
  }
});

async function handleTestConnection(): Promise<TestConnectionResult> {
  try {
    const config = await loadProviderConfig();
    if (!config.endpoint || !config.apiKey || !config.model) {
      return { success: false, error: '请先完成配置' };
    }

    const requestBody = buildTranslateRequest({
      texts: ['hello'],
      targetLanguage: config.targetLanguage,
      model: config.model,
      mode: 'separator',
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) return { success: true };
    if (response.status === 401 || response.status === 403) return { success: false, error: 'API Key 无效' };
    if (response.status === 404) return { success: false, error: '端点地址错误' };
    return { success: false, error: `服务器返回错误: ${response.status}` };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { success: false, error: '连接超时' };
    }
    return { success: false, error: '无法连接到服务器' };
  }
}

// --- Tab 生命周期 ---

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    clearTabState(tabId);
  }
});

// --- 右键菜单 ---

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'next-translate-page',
    title: '翻译此页面',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'next-translate-page' && tab?.id) {
    sendToggleToTab(tab.id);
  }
});

// --- 快捷键 ---

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-translate') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) sendToggleToTab(tab.id);
    });
  }
});

async function sendToggleToTab(tabId: number) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_TRANSLATE' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/index.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/style.css'] });
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_TRANSLATE' });
  }
}

// --- 退避状态恢复 ---

(async () => {
  try {
    const data = await chrome.storage.session?.get?.(['nt:backoffUntil', 'nt:backoffDelay']);
    if (data?.['nt:backoffUntil']) {
      backoffUntil = data['nt:backoffUntil'];
      currentBackoffDelay = data['nt:backoffDelay'] ?? 2000;
    }
  } catch { /* session storage 可能不可用 */ }
})();

console.log('[NextTranslate] Background service worker started');
```

---

### Task 16: 实现 Content Script 翻译调度（translator.ts）

**Files:**
- Create: `src/content/translator.ts`

**Step 1: 实现 translator.ts**

`src/content/translator.ts`:
```typescript
import type { TranslateBatchResult } from '@shared/messages';
import { collectParagraphs, splitIntoBatches, extractGlossaryTerms, restoreCodePlaceholders, splitLongText, type ExtractedParagraph } from './extractor';

const MAX_BATCHES_PER_TAB = 100;
const KEEPALIVE_INTERVAL_MS = 25000;
const SW_RETRY_MAX = 5;
const SW_RETRY_BASE_MS = 1000;

// FNV-1a hash
function fnv1a(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(36);
}

export interface TranslatorCallbacks {
  onBatchTranslated: (batchSeq: number, elements: Element[], translations: string[]) => void;
  onProgress: (completed: number, total: number) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onCancelled: () => void;
}

export class Translator {
  private cache = new Map<string, string>(); // fnv1a(text+lang) → translation
  private translatedSet = new Set<Element>();
  private batchMap = new Map<string, { seq: number; elements: Element[]; codeMaps: Map<string, string>[] }>();
  private nextRenderSeq = 0;
  private pendingRenders = new Map<number, { elements: Element[]; translations: string[] }>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;
  private glossary: string[] = [];
  private targetLanguage = 'Simplified Chinese';

  constructor(private callbacks: TranslatorCallbacks) {}

  async start(container: Element, targetLanguage: string) {
    this.cancelled = false;
    this.targetLanguage = targetLanguage;
    this.nextRenderSeq = 0;
    this.pendingRenders.clear();

    // 收集段落
    const paragraphs = collectParagraphs(container, this.translatedSet);
    if (paragraphs.length === 0) {
      this.callbacks.onComplete();
      return;
    }

    // 处理超长段落拆分
    const processedParagraphs: ExtractedParagraph[] = [];
    for (const p of paragraphs) {
      const subTexts = splitLongText(p.text);
      if (subTexts.length === 1) {
        processedParagraphs.push(p);
      } else {
        // 超长段落拆分后，每个子段共享同一个 element
        for (const subText of subTexts) {
          processedParagraphs.push({ element: p.element, text: subText, codeMap: p.codeMap });
        }
      }
    }

    // 提取术语表
    const texts = processedParagraphs.map(p => p.text);
    this.glossary = extractGlossaryTerms(texts);

    // 检查缓存命中
    const uncachedIndices: number[] = [];
    const cachedResults = new Map<number, string>();

    for (let i = 0; i < texts.length; i++) {
      const cacheKey = fnv1a(texts[i] + '\0' + targetLanguage);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        cachedResults.set(i, cached);
      } else {
        uncachedIndices.push(i);
      }
    }

    // 立即渲染缓存命中的翻译
    for (const [idx, translation] of cachedResults) {
      const p = processedParagraphs[idx];
      const restored = restoreCodePlaceholders(translation, p.codeMap);
      this.callbacks.onBatchTranslated(-1, [p.element], [restored]);
      this.translatedSet.add(p.element);
    }

    if (uncachedIndices.length === 0) {
      this.callbacks.onComplete();
      return;
    }

    // 分批
    const uncachedTexts = uncachedIndices.map(i => texts[i]);
    const batchIndices = splitIntoBatches(uncachedTexts);

    const totalBatches = Math.min(batchIndices.length, MAX_BATCHES_PER_TAB);

    // 启动心跳
    this.startKeepalive();

    // 发送批次
    for (let seq = 0; seq < totalBatches; seq++) {
      if (this.cancelled) break;

      const localIndices = batchIndices[seq]; // indices into uncachedTexts
      const batchTexts = localIndices.map(i => uncachedTexts[i]);
      const batchElements = localIndices.map(i => processedParagraphs[uncachedIndices[i]].element);
      const batchCodeMaps = localIndices.map(i => processedParagraphs[uncachedIndices[i]].codeMap);
      const batchId = crypto.randomUUID();

      this.batchMap.set(batchId, { seq, elements: batchElements, codeMaps: batchCodeMaps });

      this.sendBatch(batchId, batchTexts, totalBatches, seq, uncachedTexts, localIndices);
    }
  }

  private async sendBatch(
    batchId: string,
    texts: string[],
    totalBatches: number,
    seq: number,
    allTexts: string[],
    localIndices: number[],
  ) {
    let retries = 0;
    while (retries < SW_RETRY_MAX && !this.cancelled) {
      try {
        // 检测扩展孤立
        if (chrome.runtime.id === undefined) {
          this.handleOrphaned();
          return;
        }

        const result: TranslateBatchResult = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_BATCH',
          batchId,
          texts,
          totalBatches,
        });

        if (!this.batchMap.has(batchId)) return; // 已取消，孤立响应

        if (result.error) {
          this.callbacks.onError(result.error);
          return;
        }

        // 缓存结果
        for (let i = 0; i < result.translations.length; i++) {
          const originalIdx = localIndices[i];
          const cacheKey = fnv1a(allTexts[originalIdx] + '\0' + this.targetLanguage);
          this.cache.set(cacheKey, result.translations[i]);
        }

        // 还原代码占位符
        const batchInfo = this.batchMap.get(batchId)!;
        const restoredTranslations = result.translations.map((t, i) =>
          restoreCodePlaceholders(t, batchInfo.codeMaps[i])
        );

        // 按序渲染
        this.queueRender(seq, batchInfo.elements, restoredTranslations, totalBatches);
        return;

      } catch (err: unknown) {
        if (chrome.runtime.id === undefined) {
          this.handleOrphaned();
          return;
        }

        retries++;
        if (retries >= SW_RETRY_MAX) {
          this.callbacks.onError('Service Worker 连接失败，翻译中止');
          return;
        }
        const jitter = 1 + (Math.random() * 0.4 - 0.2);
        const delay = SW_RETRY_BASE_MS * Math.pow(2, retries - 1) * jitter;
        await new Promise(r => setTimeout(r, Math.min(delay, 30000)));
      }
    }
  }

  private queueRender(seq: number, elements: Element[], translations: string[], totalBatches: number) {
    this.pendingRenders.set(seq, { elements, translations });

    // 按序渲染
    while (this.pendingRenders.has(this.nextRenderSeq)) {
      const batch = this.pendingRenders.get(this.nextRenderSeq)!;
      this.pendingRenders.delete(this.nextRenderSeq);

      // 跳过已脱离文档的节点
      const validElements: Element[] = [];
      const validTranslations: string[] = [];
      for (let i = 0; i < batch.elements.length; i++) {
        if (batch.elements[i].isConnected) {
          validElements.push(batch.elements[i]);
          validTranslations.push(batch.translations[i]);
          this.translatedSet.add(batch.elements[i]);
        }
      }

      if (validElements.length > 0) {
        this.callbacks.onBatchTranslated(this.nextRenderSeq, validElements, validTranslations);
      }

      this.nextRenderSeq++;
      this.callbacks.onProgress(this.nextRenderSeq, totalBatches);
    }

    if (this.nextRenderSeq >= totalBatches) {
      this.stopKeepalive();
      this.callbacks.onComplete();
    }
  }

  cancel() {
    this.cancelled = true;
    this.batchMap.clear();
    this.pendingRenders.clear();
    this.stopKeepalive();

    try {
      chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATE' }).catch(() => {});
    } catch { /* 可能已孤立 */ }

    this.callbacks.onCancelled();
  }

  getTranslatedSet(): Set<Element> {
    return this.translatedSet;
  }

  resetState() {
    this.translatedSet.clear();
    this.batchMap.clear();
    this.pendingRenders.clear();
    this.nextRenderSeq = 0;
    this.cancelled = false;
    this.glossary = [];
  }

  // --- Keepalive ---

  private startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'KEEPALIVE' }).catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // --- 扩展孤立处理 ---

  private handleOrphaned() {
    this.cancel();
    const banner = document.createElement('div');
    banner.className = 'nt-orphan-banner';
    banner.textContent = '扩展已更新，请刷新页面以继续使用翻译功能 ';
    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = '刷新页面';
    reloadBtn.className = 'nt-orphan-reload';
    reloadBtn.addEventListener('click', () => location.reload());
    banner.appendChild(reloadBtn);
    document.body.appendChild(banner);
  }
}
```

---

### Task 17: 实现 Content Script 入口（整合提取与翻译）

**Files:**
- Modify: `src/content/index.ts`

**Step 1: 实现 Content Script 入口**

`src/content/index.ts`:
```typescript
import type { ToggleTranslateResponse, TranslateStatusMsg } from '@shared/messages';
import { loadProviderConfig } from '@shared/storage';
import { findMainContainer } from './extractor';
import { Translator } from './translator';
import { Injector } from './injector';
import { ProgressBar } from './progress';

// --- 状态 ---

type TranslateState = 'idle' | 'translating' | 'done';

let state: TranslateState = 'idle';
let translationsVisible = true;
let toggleBusy = false;
let mutationObserver: MutationObserver | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let mainContainer: Element | null = null;

const injector = new Injector();
const progressBar = new ProgressBar();

const translator = new Translator({
  onBatchTranslated: (_, elements, translations) => {
    for (let i = 0; i < elements.length; i++) {
      injector.insertTranslation(elements[i], translations[i]);
    }
  },
  onProgress: (completed, total) => {
    progressBar.update(completed, total);
  },
  onComplete: () => {
    state = 'done';
    progressBar.complete();
  },
  onError: (error) => {
    progressBar.error(error);
  },
  onCancelled: () => {
    state = 'idle';
    progressBar.hide();
  },
});

// --- 消息监听 ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TOGGLE_TRANSLATE') {
    const response = handleToggle();
    sendResponse(response);
  }
});

function handleToggle(): ToggleTranslateResponse {
  if (toggleBusy) return { action: 'busy' };

  toggleBusy = true;
  try {
    switch (state) {
      case 'idle':
        startTranslation();
        return { action: 'started' };

      case 'translating':
        cancelTranslation();
        return { action: 'cancelled' };

      case 'done':
        translationsVisible = !translationsVisible;
        injector.setVisibility(translationsVisible);
        return { action: translationsVisible ? 'toggled_visible' : 'toggled_hidden' };
    }
  } finally {
    toggleBusy = false;
  }
}

// --- 翻译流程 ---

async function startTranslation() {
  state = 'translating';
  translationsVisible = true;

  const config = await loadProviderConfig();
  mainContainer = await findMainContainer();

  progressBar.show();
  await translator.start(mainContainer, config.targetLanguage);

  // 启动 MutationObserver
  startObserver();
}

function cancelTranslation() {
  state = 'idle';
  translator.cancel();
  injector.hideAll();
  stopObserver();
}

// --- MutationObserver ---

function startObserver() {
  if (!mainContainer || mutationObserver) return;

  mutationObserver = new MutationObserver((mutations) => {
    // 过滤掉扩展自身的节点
    const hasNewContent = mutations.some(m =>
      Array.from(m.addedNodes).some(node =>
        node instanceof Element &&
        !node.className?.split?.(' ').some((c: string) => c.startsWith('nt-'))
      )
    );

    if (!hasNewContent) return;

    // Debounce 300ms
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (state !== 'done' && state !== 'translating') return;
      const config = await loadProviderConfig();
      await translator.start(mainContainer!, config.targetLanguage);
    }, 300);
  });

  mutationObserver.observe(mainContainer, { childList: true, subtree: true });
}

function stopObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// --- SPA 导航处理 ---

let currentUrl = location.href;

function handleSpaNavigation() {
  if (location.href === currentUrl) return;
  currentUrl = location.href;

  if (state === 'translating') {
    cancelTranslation();
  }

  // 重置状态
  state = 'idle';
  injector.removeAll();
  translator.resetState();
  stopObserver();
  mainContainer = null;
}

window.addEventListener('popstate', handleSpaNavigation);
window.addEventListener('hashchange', handleSpaNavigation);

// 劫持 History API
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

history.pushState = function (...args) {
  originalPushState.apply(this, args);
  handleSpaNavigation();
};

history.replaceState = function (...args) {
  originalReplaceState.apply(this, args);
  handleSpaNavigation();
};

// --- 关键样式注入请求 ---

chrome.runtime.sendMessage({ type: 'INJECT_CRITICAL_CSS' }).catch(() => {});

console.log('[NextTranslate] Content script injected');
```

---

### Task 18: 提交 P3

Run: `git add -A && git commit -m "P3: background API calls, request queue, JSON/separator modes, translation pipeline"`

---

## P4: 译文注入 + 样式 + 进度条 + Badge

### Task 19: 实现译文注入器（injector.ts）

**Files:**
- Create: `src/content/injector.ts`
- Create: `tests/unit/injector.test.ts`

**Step 1: 编写注入器测试**

`tests/unit/injector.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '../../src/content/injector';

describe('Injector', () => {
  let injector: Injector;

  beforeEach(() => {
    document.body.innerHTML = '<div id="content"><p id="p1">Hello world</p><p id="p2">Good morning</p></div>';
    injector = new Injector();
  });

  it('在段落下方插入译文', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    const translation = p1.nextElementSibling;
    expect(translation).not.toBeNull();
    expect(translation!.classList.contains('nt-translation')).toBe(true);
    expect(translation!.textContent).toBe('你好世界');
  });

  it('译文使用 textContent 赋值（防 XSS）', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '<script>alert("xss")</script>');
    const translation = p1.nextElementSibling;
    expect(translation!.innerHTML).not.toContain('<script>');
    expect(translation!.textContent).toBe('<script>alert("xss")</script>');
  });

  it('source 和 translation 通过 data-nt-id 关联', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    const ntId = p1.getAttribute('data-nt-id');
    expect(ntId).not.toBeNull();
    const translation = p1.nextElementSibling;
    expect(translation!.getAttribute('data-nt-id')).toBe(ntId);
  });

  it('切换显示/隐藏', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    injector.setVisibility(false);
    const translation = p1.nextElementSibling as HTMLElement;
    expect(translation.style.display).toBe('none');
    injector.setVisibility(true);
    expect(translation.style.display).toBe('');
  });

  it('removeAll 移除所有译文', () => {
    const p1 = document.getElementById('p1')!;
    const p2 = document.getElementById('p2')!;
    injector.insertTranslation(p1, '你好世界');
    injector.insertTranslation(p2, '早上好');
    injector.removeAll();
    expect(document.querySelectorAll('.nt-translation').length).toBe(0);
  });

  it('不重复插入同一元素的译文', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    injector.insertTranslation(p1, '你好世界 v2');
    // 应该更新而不是创建新的
    const translations = document.querySelectorAll('.nt-translation');
    expect(translations.length).toBe(1);
    expect(translations[0].textContent).toBe('你好世界 v2');
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/injector.test.ts`
Expected: FAIL

**Step 3: 实现 injector.ts**

`src/content/injector.ts`:
```typescript
const LANG_MAP: Record<string, string> = {
  'Simplified Chinese': 'zh-CN',
  'Traditional Chinese': 'zh-TW',
  'Japanese': 'ja',
  'Korean': 'ko',
  'English': 'en',
};

export class Injector {
  private ntIdCounter = 0;
  private translationMap = new Map<string, { sourceEl: WeakRef<Element>; translatedText: string }>();
  private translationElements = new Set<HTMLElement>();
  private theme: 'light' | 'dark' = 'light';
  private targetLanguage = 'Simplified Chinese';

  setTargetLanguage(lang: string) {
    this.targetLanguage = lang;
  }

  detectTheme(container: Element) {
    let el: Element | null = container;
    while (el) {
      const style = getComputedStyle(el);
      const bg = style.backgroundColor;
      const alpha = parseAlpha(bg);
      if (alpha > 0) {
        const luminance = computeLuminance(bg);
        this.theme = luminance > 0.5 ? 'light' : 'dark';
        return;
      }
      el = el.parentElement;
    }
    this.theme = 'light'; // 默认亮色
  }

  insertTranslation(sourceEl: Element, translatedText: string) {
    // 获取或分配 nt-id
    let ntId = sourceEl.getAttribute('data-nt-id');
    if (!ntId) {
      ntId = String(this.ntIdCounter++);
      sourceEl.setAttribute('data-nt-id', ntId);
    }

    // 检查是否已有译文节点（更新而不是重复插入）
    let translationDiv: HTMLElement | null = null;
    const nextSibling = sourceEl.nextElementSibling;
    if (nextSibling?.classList.contains('nt-translation') &&
        nextSibling.getAttribute('data-nt-id') === ntId) {
      translationDiv = nextSibling as HTMLElement;
    }

    if (!translationDiv) {
      translationDiv = document.createElement('div');
      translationDiv.className = 'nt-translation';
      translationDiv.setAttribute('data-nt', '');
      translationDiv.setAttribute('data-nt-id', ntId);
      translationDiv.setAttribute('data-nt-theme', this.theme);
      translationDiv.setAttribute('lang', LANG_MAP[this.targetLanguage] ?? 'zh-CN');
      sourceEl.parentNode?.insertBefore(translationDiv, sourceEl.nextSibling);
      this.translationElements.add(translationDiv);
    }

    // 使用 textContent 赋值（防 XSS）
    translationDiv.textContent = translatedText;

    // 缓存引用
    this.translationMap.set(ntId, {
      sourceEl: new WeakRef(sourceEl),
      translatedText,
    });
  }

  setVisibility(visible: boolean) {
    for (const el of this.translationElements) {
      el.style.display = visible ? '' : 'none';
    }
  }

  hideAll() {
    this.setVisibility(false);
  }

  removeAll() {
    for (const el of this.translationElements) {
      el.remove();
    }
    this.translationElements.clear();
    this.translationMap.clear();
    // 清除所有 data-nt-id
    document.querySelectorAll('[data-nt-id]').forEach(el => {
      if (!el.classList.contains('nt-translation')) {
        el.removeAttribute('data-nt-id');
      }
    });
  }

  // 恢复被框架移除的译文节点
  restoreRemovedTranslations() {
    for (const [ntId, data] of this.translationMap) {
      const sourceEl = data.sourceEl.deref();
      if (!sourceEl || !sourceEl.isConnected) continue;

      // 检查译文节点是否还在
      const existing = sourceEl.nextElementSibling;
      if (existing?.classList.contains('nt-translation') &&
          existing.getAttribute('data-nt-id') === ntId) {
        continue;
      }

      // 重新注入
      this.insertTranslation(sourceEl, data.translatedText);
    }
  }
}

// --- 颜色工具函数 ---

function parseAlpha(color: string): number {
  if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return 0;
  const match = color.match(/rgba?\([\d.]+,\s*[\d.]+,\s*[\d.]+(?:,\s*([\d.]+))?\)/);
  if (match) return match[1] !== undefined ? parseFloat(match[1]) : 1;
  return 1;
}

function computeLuminance(color: string): number {
  const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!match) return 1; // 默认亮色
  const [r, g, b] = [parseFloat(match[1]) / 255, parseFloat(match[2]) / 255, parseFloat(match[3]) / 255];
  // 相对亮度公式
  const linearize = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}
```

**Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/injector.test.ts`
Expected: PASS

---

### Task 20: 实现页面内进度条（progress.ts）

**Files:**
- Create: `src/content/progress.ts`

**Step 1: 实现 progress.ts**

`src/content/progress.ts`:
```typescript
export class ProgressBar {
  private container: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private label: HTMLElement | null = null;

  show() {
    if (this.container) this.container.remove();

    this.container = document.createElement('div');
    this.container.className = 'nt-progress-container';

    this.bar = document.createElement('div');
    this.bar.className = 'nt-progress-bar';

    this.label = document.createElement('span');
    this.label.className = 'nt-progress-label';
    this.label.textContent = '翻译中... 0%';

    this.container.appendChild(this.bar);
    this.container.appendChild(this.label);
    document.body.appendChild(this.container);
  }

  update(completed: number, total: number) {
    if (!this.bar || !this.label) return;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    this.bar.style.width = `${pct}%`;
    this.label.textContent = `翻译中... ${pct}%`;
  }

  complete() {
    if (!this.bar || !this.label || !this.container) return;
    this.bar.style.width = '100%';
    this.label.textContent = '翻译完成';
    this.container.classList.add('nt-progress-done');
    setTimeout(() => this.hide(), 1000);
  }

  error(message: string) {
    if (!this.label || !this.container) return;
    this.label.textContent = message;
    this.container.classList.add('nt-progress-error');
    setTimeout(() => this.hide(), 3000);
  }

  hide() {
    if (this.container) {
      this.container.classList.add('nt-progress-fadeout');
      setTimeout(() => {
        this.container?.remove();
        this.container = null;
        this.bar = null;
        this.label = null;
      }, 300);
    }
  }
}
```

---

### Task 21: 创建 Content Script 样式

**Files:**
- Create: `src/content/style.css`

**Step 1: 创建完整样式文件**

`src/content/style.css`:
```css
/* === 译文样式 === */

div.nt-translation[data-nt] {
  border-left: 3px solid var(--nt-border-color, #4A90D9) !important;
  padding: 6px 10px !important;
  margin: 4px 0 8px 0 !important;
  font-size: 0.92em !important;
  line-height: 1.6 !important;
  color: var(--nt-text-color, #555) !important;
  background: var(--nt-bg-color, rgba(0, 0, 0, 0.02)) !important;
  border-radius: 0 4px 4px 0 !important;
  user-select: none !important;
  position: relative !important;
}

/* 明色主题 */
div.nt-translation[data-nt-theme="light"] {
  --nt-border-color: #4A90D9;
  --nt-text-color: #555;
  --nt-bg-color: rgba(0, 0, 0, 0.02);
}

/* 暗色主题 */
div.nt-translation[data-nt-theme="dark"] {
  --nt-border-color: #5BA0E0;
  --nt-text-color: #bbb;
  --nt-bg-color: rgba(255, 255, 255, 0.05);
}

/* 复制按钮 */
div.nt-translation[data-nt]:hover .nt-copy-btn {
  opacity: 1;
}

.nt-copy-btn {
  position: absolute !important;
  top: 4px !important;
  right: 4px !important;
  opacity: 0 !important;
  background: var(--nt-bg-color, #f0f0f0) !important;
  border: 1px solid var(--nt-border-color, #ddd) !important;
  border-radius: 3px !important;
  padding: 2px 6px !important;
  font-size: 11px !important;
  cursor: pointer !important;
  color: var(--nt-text-color, #666) !important;
  transition: opacity 0.2s !important;
}

/* === 进度条样式 === */

.nt-progress-container {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  height: 28px !important;
  background: rgba(74, 144, 217, 0.1) !important;
  z-index: 2147483647 !important;
  display: flex !important;
  align-items: center !important;
  transition: opacity 0.3s !important;
}

.nt-progress-bar {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  height: 3px !important;
  background: #4A90D9 !important;
  transition: width 0.3s ease !important;
  width: 0 !important;
}

.nt-progress-label {
  margin-left: 12px !important;
  font-size: 12px !important;
  color: #4A90D9 !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
  position: relative !important;
  z-index: 1 !important;
}

.nt-progress-done .nt-progress-bar {
  background: #4CAF50 !important;
}

.nt-progress-done .nt-progress-label {
  color: #4CAF50 !important;
}

.nt-progress-error .nt-progress-bar {
  background: #f44336 !important;
}

.nt-progress-error .nt-progress-label {
  color: #f44336 !important;
}

.nt-progress-fadeout {
  opacity: 0 !important;
}

/* === 孤立扩展横幅 === */

.nt-orphan-banner {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  padding: 10px 16px !important;
  background: #fff3e0 !important;
  color: #e65100 !important;
  font-size: 14px !important;
  text-align: center !important;
  z-index: 2147483647 !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
}

.nt-orphan-reload {
  margin-left: 8px !important;
  padding: 4px 12px !important;
  background: #e65100 !important;
  color: white !important;
  border: none !important;
  border-radius: 4px !important;
  cursor: pointer !important;
  font-size: 13px !important;
}
```

---

### Task 22: 提交 P4

Run: `git add -A && git commit -m "P4: translation injector, page progress bar, badge status, content styles"`

---

## P5: 多 Tab 队列 + Tab 生命周期 + SW Keepalive + 快捷键/菜单

> 注意：P5 的大部分功能已在 Task 15（Background Service Worker）中实现，包括：
> - 多 Tab round-robin 队列调度
> - Tab 生命周期管理（`onRemoved`、`onUpdated`）
> - `AbortController` 取消
> - 快捷键（`chrome.commands`）和右键菜单（`chrome.contextMenus`）
> - Badge 状态（per-tab `setBadgeText`/`setBadgeBackgroundColor`）
>
> 以下任务补充 keepalive alarm 和集成测试。

### Task 23: 补充 Service Worker Keepalive Alarm

**Files:**
- Modify: `src/background/index.ts`

**Step 1: 在 Background 中添加 alarm keepalive**

在 `src/background/index.ts` 中的 `broadcastProgress` 函数附近添加 alarm 管理：

```typescript
// --- Alarm Keepalive (次要策略) ---

function startAlarmKeepalive() {
  chrome.alarms.create('nt-keepalive', { periodInMinutes: 1 });
}

function stopAlarmKeepalive() {
  chrome.alarms.clear('nt-keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nt-keepalive') {
    // 仅起到唤醒 SW 的作用，无额外逻辑
    console.log('[NextTranslate] Alarm keepalive tick');
  }
});
```

在 `TRANSLATE_BATCH` 处理分支中，首次收到某 tab 的翻译请求时调用 `startAlarmKeepalive()`。在 `clearTabState` 中，当所有 tab 状态清除后调用 `stopAlarmKeepalive()`。

---

### Task 24: 创建 Mock API Server（用于手动和 E2E 测试）

**Files:**
- Create: `tests/e2e/mock-server.ts`

**Step 1: 创建 Mock Server**

```typescript
import http from 'node:http';

const PORT = 3456;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      const parsed = JSON.parse(body);
      const userContent = parsed.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '';

      let translations: string[];

      // JSON mode
      if (userContent.startsWith('{')) {
        const input = JSON.parse(userContent);
        translations = (input.texts as string[]).map((t: string) => `[翻译] ${t}`);
        res.writeHead(200);
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ translations }),
            },
          }],
        }));
      } else {
        // 分隔符模式
        const parts = userContent.split('∥NT∥').map((s: string) => s.trim());
        const translated = parts.map((t: string) => `[翻译] ${t}`);
        res.writeHead(200);
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: translated.join('\n∥NT∥\n'),
            },
          }],
        }));
      }
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Mock API] Listening on http://localhost:${PORT}`);
});

export { server, PORT };
```

**Step 2: 添加 scripts**

在 `package.json` 中添加：
```json
{
  "scripts": {
    "mock-api": "npx tsx tests/e2e/mock-server.ts"
  }
}
```

---

### Task 25: 提交 P5

Run: `git add -A && git commit -m "P5: alarm keepalive, mock API server for testing"`

---

## P6: 增强功能

### Task 26: 完善会话内翻译缓存

> 已在 Task 16 的 `Translator` 类中实现了基于 FNV-1a 的会话内缓存。此任务验证缓存行为。

**Files:**
- Create: `tests/unit/translator.test.ts`

**Step 1: 编写缓存测试**

`tests/unit/translator.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

// FNV-1a hash 测试（从 translator.ts 中提取为可导出函数后测试）
describe('fnv1a hash', () => {
  // 导入时需要将 fnv1a 导出，或者直接在这里复制测试
  it('相同输入产生相同 hash', () => {
    const hash = fnv1a('hello\0Simplified Chinese');
    const hash2 = fnv1a('hello\0Simplified Chinese');
    expect(hash).toBe(hash2);
  });

  it('不同语言产生不同 hash', () => {
    const hash1 = fnv1a('hello\0Simplified Chinese');
    const hash2 = fnv1a('hello\0Japanese');
    expect(hash1).not.toBe(hash2);
  });
});

function fnv1a(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(36);
}
```

**Step 2: 运行测试**

Run: `npx vitest run tests/unit/translator.test.ts`
Expected: PASS

---

### Task 27: 完善 MutationObserver 与框架重渲染恢复

> MutationObserver 已在 Task 17 的 Content Script 入口实现。框架重渲染恢复需要 Injector 的 `restoreRemovedTranslations` 配合 MutationObserver。

**Files:**
- Modify: `src/content/index.ts`

**Step 1: 增强 MutationObserver 以检测译文节点被移除**

在 Content Script 的 MutationObserver 回调中增加对 `removedNodes` 的检测：

```typescript
// 在 startObserver() 中增加：
mutationObserver = new MutationObserver((mutations) => {
  let hasNewContent = false;
  let hasRemovedTranslation = false;

  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node instanceof Element && !node.className?.split?.(' ').some((c: string) => c.startsWith('nt-'))) {
        hasNewContent = true;
      }
    }
    for (const node of m.removedNodes) {
      if (node instanceof Element && node.classList?.contains('nt-translation')) {
        hasRemovedTranslation = true;
      }
    }
  }

  // 恢复被框架移除的译文
  if (hasRemovedTranslation) {
    injector.restoreRemovedTranslations();
  }

  // 新内容增量翻译
  if (hasNewContent) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (state !== 'done' && state !== 'translating') return;
      const config = await loadProviderConfig();
      await translator.start(mainContainer!, config.targetLanguage);
    }, 300);
  }
});
```

---

### Task 28: 实现安全上限与重试预算

> 安全上限（MAX_BATCHES_PER_TAB = 100）已在 Task 16 的 Translator 中实现。
> 重试预算需要在 Background 中实现。

**Files:**
- Modify: `src/background/index.ts`

**Step 1: 在 TabState 中添加重试预算**

```typescript
interface TabState {
  // ...existing fields...
  retryBudget: number; // 默认 20
}
```

在 `getOrCreateTabState` 中初始化 `retryBudget: 20`。在 `processItem` 的错误处理中（非 429 错误），检查 `retryBudget > 0`，消耗后入队重试，否则返回错误。

---

### Task 29: 最终验证与提交

**Step 1: 运行全部单元测试**

Run: `npm test`
Expected: 所有测试通过

**Step 2: 构建项目**

Run: `npm run build`
Expected: `dist/` 目录生成完整扩展文件

**Step 3: 手动加载测试**

1. 启动 mock API server: `npm run mock-api`
2. 在 Chrome 中打开 `chrome://extensions/`，启用开发者模式
3. 点击"加载已解压的扩展程序"，选择 `dist/` 目录
4. 打开任意英文页面（如 Hacker News）
5. 在 Popup 中配置 endpoint 为 `http://localhost:3456`，API Key 任意，Model 任意
6. 点击"测试连接"确认成功
7. 点击"翻译全文"验证：
   - 进度条出现
   - 译文逐批出现在英文段落下方
   - Badge 显示进度百分比
   - 完成后 Badge 显示绿色 ✓
8. 再次点击切换显示/隐藏
9. 使用 `Alt+T` 快捷键测试
10. 右键菜单"翻译此页面"测试

**Step 4: 提交 P6**

Run: `git add -A && git commit -m "P6: mutation observer recovery, retry budget, safety limits"`

---

## 完整任务清单

| 编号 | 阶段 | 任务 | 预计时间 |
|------|------|------|----------|
| 1 | P0 | 初始化 npm 项目 | 2 min |
| 2 | P0 | 安装依赖 | 3 min |
| 3 | P0 | 创建 TypeScript 配置 | 3 min |
| 4 | P0 | 创建 Vite 构建配置 | 5 min |
| 5 | P0 | 创建 Manifest V3 配置 | 3 min |
| 6 | P0 | 创建最小源文件骨架 | 5 min |
| 7 | P0 | 配置 Vitest | 3 min |
| 8 | P0 | 创建 CLAUDE.md | 2 min |
| 9 | P1 | 实现存储工具 | 5 min |
| 10 | P1 | 实现 Popup 完整功能 | 5 min |
| 11 | P1 | 提交 P1 | 1 min |
| 12 | P2 | 实现内容提取器 | 5 min |
| 13 | P2 | 提交 P2 | 1 min |
| 14 | P3 | 实现 Prompt 构建与解析 | 5 min |
| 15 | P3 | 实现 Background Service Worker | 5 min |
| 16 | P3 | 实现翻译调度器 | 5 min |
| 17 | P3 | 实现 Content Script 入口 | 5 min |
| 18 | P3 | 提交 P3 | 1 min |
| 19 | P4 | 实现译文注入器 | 5 min |
| 20 | P4 | 实现页面内进度条 | 3 min |
| 21 | P4 | 创建 Content Script 样式 | 3 min |
| 22 | P4 | 提交 P4 | 1 min |
| 23 | P5 | 补充 Alarm Keepalive | 3 min |
| 24 | P5 | 创建 Mock API Server | 5 min |
| 25 | P5 | 提交 P5 | 1 min |
| 26 | P6 | 验证翻译缓存 | 3 min |
| 27 | P6 | MutationObserver + 框架恢复 | 5 min |
| 28 | P6 | 安全上限与重试预算 | 3 min |
| 29 | P6 | 最终验证与提交 | 5 min |
