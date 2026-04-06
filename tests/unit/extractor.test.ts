import { describe, it, expect, beforeEach } from 'vitest';
import {
  isChineseDominant,
  shouldSkipElement,
  extractTextWithCodeProtection,
  restoreCodePlaceholders,
  estimateTokens,
  splitIntoBatches,
  collectParagraphs,
  extractQuickTranslateParagraph,
  findMainContainer,
  resolveHoverParagraphCandidate,
} from '../../src/content/extractor';

describe('isChineseDominant', () => {
  it('纯中文返回 true', () => {
    expect(isChineseDominant('这是一段中文文字')).toBe(true);
  });

  it('纯英文返回 false', () => {
    expect(isChineseDominant('This is English text')).toBe(false);
  });

  it('中文占比 > 50% 返回 true', () => {
    expect(isChineseDominant('这是一段中文测试文字加上少量English')).toBe(true);
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

  it('不把 display: contents 的包装元素误判为隐藏', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.textContent = 'Wrapper text that should remain visible to traversal';
    Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => null });
    const originalGetComputedStyle = globalThis.getComputedStyle;
    globalThis.getComputedStyle = ((node: Element) => {
      const style = originalGetComputedStyle(node);
      if (node === el) {
        return new Proxy(style, {
          get(target, prop, receiver) {
            if (prop === 'display') return 'contents';
            return Reflect.get(target, prop, receiver);
          },
        }) as CSSStyleDeclaration;
      }
      return style;
    }) as typeof getComputedStyle;

    try {
      expect(shouldSkipElement(el)).toBe(false);
    } finally {
      globalThis.getComputedStyle = originalGetComputedStyle;
    }
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

  it('提取时忽略已注入的译文节点', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Original text <span class="nt-translation" data-nt>翻译内容</span>';
    const { text, codeMap } = extractTextWithCodeProtection(p);
    expect(text.trim()).toBe('Original text');
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

describe('findMainContainer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('GitHub PR 详情页优先按 selector 顺序选择 turbo frame，而不是文档里更早出现的 diff viewer', async () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/pull/42');

    const diffViewer = document.createElement('div');
    diffViewer.id = 'diff-comparison-viewer-container';
    diffViewer.innerHTML = '<p>Header-only container that should not win.</p>';

    const turboFrame = document.createElement('turbo-frame');
    turboFrame.id = 'repo-content-turbo-frame';
    turboFrame.innerHTML = '<div class="js-discussion"><p>Real discussion container that should win.</p></div>';

    document.body.append(diffViewer, turboFrame);

    const container = await findMainContainer();
    expect(container).toBe(turboFrame);
  });
});

describe('collectParagraphs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('GitHub issue 列表页只收集 issue 标题', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/issues');

    const container = document.createElement('div');
    container.innerHTML = `
      <div class="repository-content">
        <h2>Search results</h2>
        <div data-listview-item-title-container="true">
          <h3>Issue title one with enough text</h3>
        </div>
        <div data-listview-item-title-container="true">
          <h3>Issue title two with enough text</h3>
        </div>
        <p>This issue metadata text should not be translated on the list page.</p>
      </div>
    `;
    document.body.appendChild(container);

    const paragraphs = collectParagraphs(container);
    expect(paragraphs.map(p => p.text)).toEqual([
      'Issue title one with enough text',
      'Issue title two with enough text',
    ]);
  });

  it('GitHub issue 详情页会收集标题和正文，但标题不带编号', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/issues/42');

    const container = document.createElement('div');
    container.innerHTML = `
      <div class="repository-content">
        <h1 data-component="PH_Title">
          <bdi data-testid="issue-title">Issue detail title with enough text</bdi>
          <span>#42</span>
        </h1>
        <div class="markdown-body">
          <p>This issue body should still be translated on the detail page.</p>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    const paragraphs = collectParagraphs(container);
    expect(paragraphs.map(p => p.text)).toEqual([
      'Issue detail title with enough text',
      'This issue body should still be translated on the detail page.',
    ]);
  });

  it('GitHub issue 详情页在标题已翻译后不会回退收集 h1 再翻一次，但正文仍会翻译', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/issues/42');

    const container = document.createElement('div');
    container.innerHTML = `
      <div class="repository-content">
        <h1 data-component="PH_Title">
          <bdi data-testid="issue-title">Issue detail title with enough text</bdi>
          <span>#42</span>
        </h1>
        <div class="markdown-body">
          <p>This issue body should still be translated on the detail page.</p>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    const paragraphs = collectParagraphs(
      container,
      (el) => el.matches('bdi[data-testid="issue-title"]'),
    );
    expect(paragraphs.map(p => p.text)).toEqual([
      'This issue body should still be translated on the detail page.',
    ]);
  });

  it('GitHub PR 列表页只收集 PR 标题', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/pulls');

    const container = document.createElement('div');
    container.innerHTML = `
      <div class="repository-content">
        <div class="js-issue-row">
          <div class="flex-auto min-width-0 p-2">
            <a class="markdown-title" href="/foo/bar/pull/1">First pull request title with enough text</a>
            <div class="d-flex mt-1 text-small color-fg-muted">#1 opened by alice</div>
          </div>
        </div>
        <div class="js-issue-row">
          <div class="flex-auto min-width-0 p-2">
            <a class="markdown-title" href="/foo/bar/pull/2">Second pull request title with enough text</a>
            <div class="d-flex mt-1 text-small color-fg-muted">#2 opened by bob</div>
          </div>
        </div>
        <p>This pull request metadata text should not be translated on the list page.</p>
      </div>
    `;
    document.body.appendChild(container);

    const paragraphs = collectParagraphs(container);
    expect(paragraphs.map(p => p.text)).toEqual([
      'First pull request title with enough text',
      'Second pull request title with enough text',
    ]);
  });

  it('GitHub PR 详情页会收集标题和正文，但跳过 header metadata、tab 和 sidebar', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/pull/42');

    const container = document.createElement('div');
    container.id = 'diff-comparison-viewer-container';
    container.innerHTML = `
      <header>
        <div class="prc-PageHeader-TitleArea-2n2J0">
          <h1 data-component="PH_Title">
            <span class="markdown-title">PR detail title with enough text</span>
            <span>#42</span>
          </h1>
        </div>
        <div class="prc-PageHeader-Description-w-ejP">
          <span>alice wants to merge 2 commits into main from feature/amazing-work</span>
        </div>
        <nav aria-label="Pull request navigation tabs">
          <h2>Conversation</h2>
        </nav>
      </header>
      <div class="js-discussion">
        <div class="comment-body markdown-body">
          <p>This PR body should still be translated on the detail page.</p>
        </div>
      </div>
      <aside class="prc-PageLayout-SidebarWrapper-kLG4B">
        <h3>Reviewers</h3>
        <p>This sidebar helper text should be skipped completely.</p>
      </aside>
      <div class="discussion-sidebar-item js-discussion-sidebar-item sidebar-assignee">
        <h3 class="discussion-sidebar-heading text-bold">Reviewers</h3>
        <p>gemini-code-assist[bot] left review comments</p>
      </div>
      <form class="js-issue-sidebar-form">
        <h3>Assignees</h3>
        <p>Sidebar form content should be skipped as well.</p>
      </form>
    `;
    document.body.appendChild(container);

    const paragraphs = collectParagraphs(container);
    expect(paragraphs.map(p => p.text)).toEqual([
      'PR detail title with enough text',
      'This PR body should still be translated on the detail page.',
    ]);
  });

  it('GitHub issue 评论中的 email fragment 会被收集，quoted reply 不会', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/issues/42');

    const container = document.createElement('div');
    container.innerHTML = `
      <div class="repository-content">
        <div class="markdown-body">
          <div class="markdown-body email-format">
            <div class="email-fragment">This comment arrived via email and should be translated as a comment body.</div>
            <span class="email-hidden-toggle">…</span>
            <div class="email-hidden-reply">
              <div class="email-quoted-reply">Quoted reply content should be skipped and not translated again.</div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    const paragraphs = collectParagraphs(container);
    expect(paragraphs.map(p => p.text)).toEqual([
      'This comment arrived via email and should be translated as a comment body.',
    ]);
  });

  it('GitHub issue 详情页会跳过附件、commit hash、版本信息和 reaction 通知', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/issues/42');

    const container = document.createElement('div');
    container.innerHTML = `
      <div class="repository-content">
        <div class="markdown-body">
          <p>Normal discussion text should still be translated for readers.</p>
          <p><a href="https://github.com/user-attachments/files/1/report.json">report.json</a></p>
          <ul>
            <li>Git Commit: 8b1e649</li>
            <li>CLI Version: 0.36.0</li>
          </ul>
          <div class="email-fragment">🧞 Richard reacted via Gmail</div>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    const paragraphs = collectParagraphs(container);
    expect(paragraphs.map(p => p.text)).toEqual([
      'Normal discussion text should still be translated for readers.',
    ]);
  });

  it('GitHub 仓库首页会跳过顶部 Watch/Fork/Star、folders-and-files 和 sidebar 非 About 区块，同时保留 README 与 About 简介', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar');

    const container = document.createElement('turbo-frame');
    container.id = 'repo-content-turbo-frame';
    container.innerHTML = `
      <ul class="pagehead-actions">
        <li>Watch</li>
        <li>Fork</li>
        <li>Star</li>
      </ul>
      <article class="markdown-body">
        <h1>Project README title with enough text</h1>
        <p>This README paragraph should still be translated for the repository home page.</p>
      </article>
      <table aria-labelledby="folders-and-files">
        <thead>
          <tr>
            <th>Last commit message</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>docs: reorganize getting started and quickstart sections</td>
          </tr>
        </tbody>
      </table>
      <rails-partial data-partial-name="codeViewRepoRoute.Sidebar">
        <div class="BorderGrid">
          <div class="BorderGrid-row">
            <div class="BorderGrid-cell">
              <h2>About</h2>
              <p class="f4">This sidebar about description should still be translated for repository readers.</p>
              <h3>Topics</h3>
            </div>
          </div>
          <div class="BorderGrid-row">
            <div class="BorderGrid-cell">
              <h2>Deployments</h2>
              <p>Production deployment status and environment metadata should be skipped.</p>
            </div>
          </div>
        </div>
      </rails-partial>
    `;
    document.body.appendChild(container);

    const paragraphs = collectParagraphs(container);
    expect(paragraphs.map(p => p.text)).toEqual([
      'Project README title with enough text',
      'This README paragraph should still be translated for the repository home page.',
      'This sidebar about description should still be translated for repository readers.',
    ]);
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
    const longText = 'A'.repeat(6000); // ~2000 tokens, exceeds threshold
    const texts = [shortText, longText, shortText];
    const batches = splitIntoBatches(texts, 2000);
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('resolveHoverParagraphCandidate', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('普通 <p> 能解析为自身', () => {
    const p = document.createElement('p');
    p.textContent = 'Hello world, this is a test paragraph with enough text';
    document.body.appendChild(p);
    expect(resolveHoverParagraphCandidate(p)).toBe(p);
  });

  it('子节点 hover 能向上解析到段落元素', () => {
    const p = document.createElement('p');
    p.textContent = 'Hello world, this is a test paragraph';
    const em = document.createElement('em');
    em.textContent = 'emphasized text inside paragraph';
    p.appendChild(em);
    document.body.appendChild(p);
    expect(resolveHoverParagraphCandidate(em)).toBe(p);
  });

  it('短文本不返回候选', () => {
    const p = document.createElement('p');
    p.textContent = 'Hi';
    document.body.appendChild(p);
    expect(resolveHoverParagraphCandidate(p)).toBeNull();
  });

  it('中文主导文本不返回候选', () => {
    const p = document.createElement('p');
    p.textContent = '这是一段中文文字测试内容';
    document.body.appendChild(p);
    expect(resolveHoverParagraphCandidate(p)).toBeNull();
  });

  it('已注入的 nt- 节点不返回候选', () => {
    const span = document.createElement('span');
    span.className = 'nt-translation';
    span.setAttribute('data-nt', '');
    span.textContent = 'This is translated text that should not be a candidate';
    document.body.appendChild(span);
    expect(resolveHoverParagraphCandidate(span)).toBeNull();
  });

  it('link-heavy 导航块不会被识别为候选', () => {
    const nav = document.createElement('p');
    nav.innerHTML = `
      <a href="/a">Link one text here</a>
      <a href="/b">Link two text here</a>
      <a href="/c">Link three text here</a>
    `;
    document.body.appendChild(nav);
    expect(resolveHoverParagraphCandidate(nav)).toBeNull();
  });

  it('含可独立 descendant paragraph 的父容器不会被误识别，但子段落仍可触发', () => {
    const div = document.createElement('div');
    const p1 = document.createElement('p');
    p1.textContent = 'First child paragraph with enough text for translation';
    const p2 = document.createElement('p');
    p2.textContent = 'Second child paragraph with enough text for translation';
    div.appendChild(p1);
    div.appendChild(p2);
    document.body.appendChild(div);
    expect(resolveHoverParagraphCandidate(div)).toBeNull();
    expect(resolveHoverParagraphCandidate(p1)).toBe(p1);
  });

  it('可编辑元素内不返回候选', () => {
    const p = document.createElement('p');
    p.textContent = 'This is a paragraph inside an editable area for testing';
    const textarea = document.createElement('textarea');
    textarea.textContent = 'This is a textarea with enough text';
    document.body.appendChild(textarea);
    expect(resolveHoverParagraphCandidate(textarea)).toBeNull();
  });

  it('input 元素不返回候选', () => {
    const input = document.createElement('input');
    input.value = 'Some input text content for testing';
    document.body.appendChild(input);
    expect(resolveHoverParagraphCandidate(input)).toBeNull();
  });

  it('[contenteditable] 区域内不返回候选', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    const p = document.createElement('p');
    p.textContent = 'This is a paragraph inside contenteditable area for testing';
    div.appendChild(p);
    document.body.appendChild(div);
    expect(resolveHoverParagraphCandidate(p)).toBeNull();
  });

  it('data-nt 属性节点内不返回候选', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-nt', '');
    const p = document.createElement('p');
    p.textContent = 'This text is inside a data-nt wrapper and should be skipped';
    wrapper.appendChild(p);
    document.body.appendChild(wrapper);
    expect(resolveHoverParagraphCandidate(p)).toBeNull();
  });

  it('hover quick translate 不再受 paragraphSelectorOnly 限制', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com/foo/bar/issues');

    const container = document.createElement('div');
    container.innerHTML = `
      <div class="repository-content">
        <div data-listview-item-title-container="true">
          <h3 id="issue-title">Issue title one with enough text</h3>
        </div>
        <p id="metadata">This issue metadata text can still be quick-translated when hovered.</p>
      </div>
    `;
    document.body.appendChild(container);

    const title = document.getElementById('issue-title')!;
    const metadata = document.getElementById('metadata')!;

    expect(resolveHoverParagraphCandidate(title)).toBe(title);
    expect(resolveHoverParagraphCandidate(metadata)).toBe(metadata);
  });

  it('GitHub feed/dashboard 的 h3 链接标题也能作为 hover quick translate 候选', () => {
    (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://github.com');

    const container = document.createElement('div');
    container.innerHTML = `
      <div id="feed-item-8111456486">
        <div>
          <div>
            <div>
              <div>
                <div>
                  <h3 id="feed-title">
                    <a href="/owner/repo/pull/123">Add enough descriptive title text for quick translation on dashboard feed</a>
                  </h3>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    const titleLink = container.querySelector('a')!;
    const title = document.getElementById('feed-title')!;

    expect(resolveHoverParagraphCandidate(titleLink)).toBe(title);
    expect(extractQuickTranslateParagraph(title)?.text).toBe('Add enough descriptive title text for quick translation on dashboard feed');
  });

  it('普通 div 文本块也可作为 quick translate 候选', () => {
    const div = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = 'A div based text block with enough content for quick translation.';
    div.appendChild(span);
    document.body.appendChild(div);

    expect(resolveHoverParagraphCandidate(span)).toBe(div);
    expect(extractQuickTranslateParagraph(div)?.text).toBe('A div based text block with enough content for quick translation.');
  });

  it('null target 返回 null', () => {
    expect(resolveHoverParagraphCandidate(null)).toBeNull();
  });

  it('skip tags (code/pre) 不返回候选', () => {
    const pre = document.createElement('pre');
    pre.textContent = 'This is a preformatted code block with enough text';
    document.body.appendChild(pre);
    expect(resolveHoverParagraphCandidate(pre)).toBeNull();
  });
});
