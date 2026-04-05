import { describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '../../src/content/injector';

describe('Injector', () => {
  let injector: Injector;

  beforeEach(() => {
    document.body.innerHTML = '<div id="content"><p id="p1">Hello world</p><p id="p2">Good morning</p></div>';
    injector = new Injector();
  });

  it('在段落内部插入位于原文下方的译文块', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    const translation = p1.querySelector('.nt-translation');
    expect(translation).not.toBeNull();
    expect(translation!.classList.contains('nt-translation')).toBe(true);
    expect(translation!.textContent).toBe('你好世界');
  });

  it('译文使用 textContent 赋值（防 XSS）', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '<script>alert("xss")</script>');
    const translation = p1.querySelector('.nt-translation');
    expect(translation!.innerHTML).not.toContain('<script>');
    expect(translation!.textContent).toBe('<script>alert("xss")</script>');
  });

  it('source 和 translation 通过 data-nt-id 关联', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    const ntId = p1.getAttribute('data-nt-id');
    expect(ntId).not.toBeNull();
    const translation = p1.querySelector('.nt-translation');
    expect(translation!.getAttribute('data-nt-id')).toBe(ntId);
  });

  it('切换显示/隐藏', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    injector.setVisibility(false);
    const translation = p1.querySelector('.nt-translation') as HTMLElement;
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
    const translations = document.querySelectorAll('.nt-translation');
    expect(translations.length).toBe(1);
    expect(translations[0].textContent).toBe('你好世界 v2');
  });

  it('hasTranslation 可识别译文是否仍挂载在源节点上', () => {
    const p1 = document.getElementById('p1')!;
    injector.insertTranslation(p1, '你好世界');
    expect(injector.hasTranslation(p1)).toBe(true);

    p1.querySelector('.nt-translation')?.remove();
    expect(injector.hasTranslation(p1)).toBe(false);
  });

  it('GitHub PR 列表标题在仅检查 hasTranslation 时不会提前创建 host wrapper', () => {
    document.body.innerHTML = `
      <div class="flex-auto min-width-0 p-2" id="pr-cell">
        <a id="pr-list-title" class="markdown-title" href="/foo/bar/pull/42">Pull request title with enough text</a>
        <span class="IssueLabel">priority/p1</span>
        <div class="d-flex mt-1 text-small color-fg-muted">#42 opened by alice</div>
      </div>
    `;

    const title = document.getElementById('pr-list-title')!;
    title.setAttribute('data-nt-id', '123');

    expect(injector.hasTranslation(title)).toBe(false);
    expect(document.querySelector('.nt-github-pr-title-line')).toBeNull();
  });

  it('GitHub issue 列表标题会把 dots 和译文挂到标题+label 容器上', () => {
    document.body.innerHTML = `
      <div data-listview-item-title-container="true">
        <h3 id="issue-title">Issue title with enough text</h3>
        <span class="Title-module__trailingBadgesContainer__INeSa"><span class="label">enhancement</span></span>
      </div>
    `;

    const title = document.getElementById('issue-title')!;
    const container = document.querySelector('[data-listview-item-title-container]')!;

    injector.showLoadingPlaceholder(title);
    expect(title.querySelector('.nt-pending-dots')).toBeNull();
    expect(title.querySelector('.nt-translation')).toBeNull();
    expect(container.querySelector(':scope > .nt-pending-dots')).not.toBeNull();
    expect(container.querySelector(':scope > .nt-translation')).not.toBeNull();

    injector.insertTranslation(title, '问题标题译文');
    expect(container.querySelector(':scope > .nt-pending-dots')).toBeNull();
    expect((container.querySelector(':scope > .nt-translation') as HTMLElement).textContent).toBe('问题标题译文');
    expect(injector.hasTranslation(title)).toBe(true);
  });

  it('GitHub issue 详情标题会把译文挂到整个 h1 下方', () => {
    document.body.innerHTML = `
      <h1 data-component="PH_Title">
        <bdi id="issue-detail-title" data-testid="issue-title">Issue detail title with enough text</bdi>
        <span>#42</span>
      </h1>
    `;

    const title = document.getElementById('issue-detail-title')!;
    const heading = document.querySelector('h1[data-component="PH_Title"]')!;

    injector.showLoadingPlaceholder(title);
    expect(title.querySelector('.nt-pending-dots')).toBeNull();
    expect(title.querySelector('.nt-translation')).toBeNull();
    expect(heading.querySelector(':scope > .nt-pending-dots')).not.toBeNull();
    expect(heading.querySelector(':scope > .nt-translation')).not.toBeNull();

    injector.insertTranslation(title, '详情标题译文');
    expect((heading.querySelector(':scope > .nt-translation') as HTMLElement).textContent).toBe('详情标题译文');
    expect(injector.hasTranslation(title)).toBe(true);
  });

  it('GitHub PR 列表标题会把标题与 label 保持同一行，dots 在 label 后，译文在下方', () => {
    document.body.innerHTML = `
      <div class="flex-auto min-width-0 p-2" id="pr-cell">
        <a id="pr-list-title" class="markdown-title" href="/foo/bar/pull/42">Pull request title with enough text</a>
        <span class="IssueLabel">priority/p1</span>
        <div class="d-flex mt-1 text-small color-fg-muted">#42 opened by alice</div>
      </div>
    `;

    const title = document.getElementById('pr-list-title')!;
    const cell = document.getElementById('pr-cell')!;

    injector.showLoadingPlaceholder(title);

    const titleLine = cell.querySelector(':scope > .nt-github-pr-title-line');
    expect(titleLine).not.toBeNull();
    expect(titleLine?.querySelector('#pr-list-title')).toBe(title);
    expect(titleLine?.querySelector('.IssueLabel')?.textContent).toBe('priority/p1');
    expect(titleLine?.querySelector('.nt-pending-dots')).not.toBeNull();
    expect(titleLine?.querySelector('.nt-translation')).not.toBeNull();
    expect(cell.querySelector(':scope > .d-flex.mt-1.text-small.color-fg-muted')).not.toBeNull();

    injector.insertTranslation(title, 'PR 标题译文');
    expect(titleLine?.querySelector('.nt-pending-dots')).toBeNull();
    expect((titleLine?.querySelector(':scope > .nt-translation') as HTMLElement).textContent).toBe('PR 标题译文');
    expect(injector.hasTranslation(title)).toBe(true);
  });

  it('GitHub PR 详情标题会把译文挂到整个 h1 下方', () => {
    document.body.innerHTML = `
      <h1 data-component="PH_Title">
        <span id="pr-detail-title" class="markdown-title">Pull request detail title with enough text</span>
        <span>#42</span>
      </h1>
    `;

    const title = document.getElementById('pr-detail-title')!;
    const heading = document.querySelector('h1[data-component="PH_Title"]')!;

    injector.showLoadingPlaceholder(title);
    expect(title.querySelector('.nt-pending-dots')).toBeNull();
    expect(title.querySelector('.nt-translation')).toBeNull();
    expect(heading.querySelector(':scope > .nt-pending-dots')).not.toBeNull();
    expect(heading.querySelector(':scope > .nt-translation')).not.toBeNull();

    injector.insertTranslation(title, 'PR 详情标题译文');
    expect((heading.querySelector(':scope > .nt-translation') as HTMLElement).textContent).toBe('PR 详情标题译文');
    expect(injector.hasTranslation(title)).toBe(true);
  });
});
