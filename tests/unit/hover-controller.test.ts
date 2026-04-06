import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HoverController } from '../../src/content/hover-controller';

function createParagraph(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  document.body.appendChild(p);
  return p;
}

function dispatch(target: EventTarget, type: string, init?: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  for (const [key, value] of Object.entries(init ?? {})) {
    Object.defineProperty(event, key, { value, writable: false });
  }
  target.dispatchEvent(event);
}

describe('HoverController', () => {
  let controller: HoverController;
  let onTrigger: ReturnType<typeof vi.fn<(element: Element) => boolean | Promise<boolean>>>;
  let resolveCandidate: ReturnType<typeof vi.fn<(target: EventTarget | null) => Element | null>>;
  let isTranslatable: ReturnType<typeof vi.fn<(element: Element) => boolean>>;

  beforeEach(() => {
    document.body.innerHTML = '';
    onTrigger = vi.fn<(element: Element) => boolean | Promise<boolean>>(() => true);
    resolveCandidate = vi.fn<(target: EventTarget | null) => Element | null>();
    isTranslatable = vi.fn<(element: Element) => boolean>(() => true);
    controller = new HoverController({
      onTrigger,
      resolveCandidate,
      isTranslatable,
    });
    controller.enable();
  });

  afterEach(() => {
    controller.destroy();
  });

  it('悬停时会更新当前候选，但不添加视觉 class', () => {
    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);

    dispatch(p, 'pointermove', { target: p });

    expect(resolveCandidate).toHaveBeenCalledWith(p);
    expect(p.classList.contains('nt-hover-candidate')).toBe(false);
  });

  it('移出候选时会清空当前候选，且不会残留视觉 class', () => {
    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValueOnce(p).mockReturnValueOnce(null);

    dispatch(p, 'pointermove', { target: p });
    dispatch(document.body, 'pointermove', { target: document.body });

    expect(p.classList.contains('nt-hover-candidate')).toBe(false);
  });

  it('嵌套节点能解析到父段落', () => {
    const p = createParagraph('Hello world test paragraph');
    const em = document.createElement('em');
    em.textContent = 'emphasis';
    p.appendChild(em);
    resolveCandidate.mockReturnValue(p);

    dispatch(em, 'pointermove', { target: em });
    expect(resolveCandidate).toHaveBeenCalledWith(em);
  });

  it('macOS 使用 Meta 触发', () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });

    // Recreate controller to pick up platform
    controller.destroy();
    controller = new HoverController({ onTrigger, resolveCandidate, isTranslatable });
    controller.enable();

    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);

    dispatch(p, 'pointermove', { target: p });
    dispatch(document, 'keydown', { key: 'Meta', metaKey: true, ctrlKey: false });

    expect(onTrigger).toHaveBeenCalledWith(p);

    Object.defineProperty(navigator, 'platform', { value: originalPlatform, configurable: true });
  });

  it('Windows/Linux 使用 Ctrl 触发', () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });

    controller.destroy();
    controller = new HoverController({ onTrigger, resolveCandidate, isTranslatable });
    controller.enable();

    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);

    dispatch(p, 'pointermove', { target: p });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });

    expect(onTrigger).toHaveBeenCalledWith(p);

    Object.defineProperty(navigator, 'platform', { value: originalPlatform, configurable: true });
  });

  it('one-shot 语义：按住不松手只触发一次', () => {
    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);

    dispatch(p, 'pointermove', { target: p });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('按住修饰键移动鼠标不会连续扫段翻译', () => {
    const p1 = createParagraph('First paragraph with enough text');
    const p2 = createParagraph('Second paragraph with enough text');

    resolveCandidate.mockReturnValue(p1);
    dispatch(p1, 'pointermove', { target: p1 });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Move to p2 while key is still held
    resolveCandidate.mockReturnValue(p2);
    dispatch(p2, 'pointermove', { target: p2 });

    // Should NOT trigger for p2 (key was already down)
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('冷却机制阻止同段重复触发', async () => {
    vi.useFakeTimers();
    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);

    // First trigger
    dispatch(p, 'pointermove', { target: p });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    dispatch(document, 'keyup', { key: 'Control', ctrlKey: false });
    expect(onTrigger).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    // Second attempt within cooldown
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    dispatch(document, 'keyup', { key: 'Control', ctrlKey: false });
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // After cooldown expires
    vi.advanceTimersByTime(1600);
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    expect(onTrigger).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('trigger 被拒绝时不会进入冷却', async () => {
    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);
    onTrigger.mockReturnValue(false);

    dispatch(p, 'pointermove', { target: p });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    dispatch(document, 'keyup', { key: 'Control', ctrlKey: false, metaKey: false });
    await Promise.resolve();

    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    await Promise.resolve();

    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it('disable() 后不再响应事件', () => {
    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);

    controller.disable();

    dispatch(p, 'pointermove', { target: p });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('reset() 清除候选和冷却', () => {
    vi.useFakeTimers();
    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);

    // Trigger once
    dispatch(p, 'pointermove', { target: p });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    dispatch(document, 'keyup', { key: 'Control', ctrlKey: false });
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Reset
    controller.reset();
    expect(p.classList.contains('nt-hover-candidate')).toBe(false);

    // Can trigger again immediately (cooldown cleared)
    dispatch(p, 'pointermove', { target: p });
    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    expect(onTrigger).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('isTranslatable 为 false 时不视为候选', () => {
    const p = createParagraph('Hello world test paragraph');
    resolveCandidate.mockReturnValue(p);
    isTranslatable.mockReturnValue(false);

    dispatch(p, 'pointermove', { target: p });
    expect(p.classList.contains('nt-hover-candidate')).toBe(false);

    dispatch(document, 'keydown', { key: 'Control', ctrlKey: true, metaKey: false });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('候选切换时不会残留 hover class', () => {
    const p1 = createParagraph('First paragraph text');
    const p2 = createParagraph('Second paragraph text');

    resolveCandidate.mockReturnValue(p1);
    dispatch(p1, 'pointermove', { target: p1 });

    resolveCandidate.mockReturnValue(p2);
    dispatch(p2, 'pointermove', { target: p2 });
    expect(p1.classList.contains('nt-hover-candidate')).toBe(false);
    expect(p2.classList.contains('nt-hover-candidate')).toBe(false);
  });
});
