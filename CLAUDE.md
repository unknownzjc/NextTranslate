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
