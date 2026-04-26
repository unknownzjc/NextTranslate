import type { TranslateBatchResult } from '@shared/messages';
import { isProviderConfigured } from '@shared/storage';
import type { ProviderConfig } from '@shared/types';
import { analyzeMixedLanguageText } from './text-skip';
import { detectElementTheme } from './injector';

const DOT_SIZE_PX = 10;
const DOT_OFFSET_PX = 4;
const POPUP_SHOW_DELAY_MS = 150;
const POPUP_HIDE_DELAY_MS = 300;
const MAX_ORIGINAL_TEXT_LENGTH = 150;
const MAX_SELECTION_LENGTH = 5000;
const MIN_SELECTION_LENGTH = 2;

export class SelectionTranslator {
  private dot: HTMLDivElement | null = null;
  private popup: HTMLDivElement | null = null;
  private selectedText: string | null = null;
  private isTranslating = false;
  private currentRequestId: string | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private isMouseSelecting = false;
  private selectionChangeHandler: (() => void) | null = null;
  private mouseDownHandler: (() => void) | null = null;
  private mouseUpHandler: (() => void) | null = null;
  private dotEnterHandler: (() => void) | null = null;
  private dotLeaveHandler: (() => void) | null = null;

  constructor(
    private getConfig: () => Promise<ProviderConfig>,
    private signal: AbortSignal,
  ) {}

  enable(): void {
    this.ensureDot();

    this.selectionChangeHandler = () => this.handleSelectionChange();
    document.addEventListener('selectionchange', this.selectionChangeHandler, { signal: this.signal });

    this.mouseDownHandler = () => this.handleMouseDown();
    this.mouseUpHandler = () => this.handleMouseUp();
    document.addEventListener('mousedown', this.mouseDownHandler, { signal: this.signal });
    document.addEventListener('mouseup', this.mouseUpHandler, { signal: this.signal });

    // Hide dot/popup on scroll (capture: true needed because scroll events don't bubble)
    document.addEventListener('scroll', () => this.reset(), { capture: true, signal: this.signal });

    // Auto-cleanup on abort
    this.signal.addEventListener('abort', () => this.destroy(), { once: true });
  }

  reset(): void {
    this.hidePopup();
    this.hideDot();
    this.selectedText = null;
    this.currentRequestId = null;
    this.isTranslating = false;
    this.clearTimers();
  }

  destroy(): void {
    this.reset();

    if (this.dot) {
      this.dot.remove();
      this.dot = null;
    }

    // Event listeners are removed via AbortSignal
  }

  // --- Private: dot element ---

  private ensureDot(): void {
    if (this.dot) return;

    const dot = document.createElement('div');
    dot.className = 'nt-sel-dot';
    dot.setAttribute('data-nt', '');
    dot.style.setProperty('display', 'none', 'important');

    this.dotEnterHandler = () => this.handleDotEnter();
    this.dotLeaveHandler = () => this.handleDotLeave();
    dot.addEventListener('mouseenter', this.dotEnterHandler);
    dot.addEventListener('mouseleave', this.dotLeaveHandler);

    (document.body || document.documentElement).appendChild(dot);
    this.dot = dot;
  }

  private positionDot(): void {
    if (!this.dot) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      this.hideDot();
      return;
    }

    // Use a collapsed range at the selection end to get the exact end position,
    // not the bounding box of the entire multi-line selection.
    const endRange = sel.getRangeAt(0).cloneRange();
    endRange.collapse(false); // false = collapse to end
    const endRect = endRange.getBoundingClientRect();
    if (endRect.width === 0 && endRect.height === 0) {
      this.hideDot();
      return;
    }

    let dotX = endRect.right + DOT_OFFSET_PX;
    let dotY = endRect.bottom + DOT_OFFSET_PX;

    // Clamp to viewport
    dotX = Math.min(dotX, window.innerWidth - DOT_SIZE_PX - DOT_OFFSET_PX);
    dotY = Math.min(dotY, window.innerHeight - DOT_SIZE_PX - DOT_OFFSET_PX);
    dotX = Math.max(dotX, DOT_OFFSET_PX);
    dotY = Math.max(dotY, DOT_OFFSET_PX);

    this.dot.style.left = dotX + 'px';
    this.dot.style.top = dotY + 'px';
    this.dot.style.setProperty('display', 'block', 'important');
  }

  private hideDot(): void {
    if (!this.dot) return;
    this.dot.style.setProperty('display', 'none', 'important');
  }

  // --- Private: popup element ---

  private createPopup(): void {
    if (this.popup) return;

    const container = document.createElement('div');
    container.className = 'nt-sel-popup';
    container.setAttribute('data-nt', '');

    // Close button
    const closeBtn = document.createElement('span');
    closeBtn.className = 'nt-sel-popup-close';
    closeBtn.setAttribute('role', 'button');
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hidePopup();
    });
    container.appendChild(closeBtn);

    const originalDiv = document.createElement('div');
    originalDiv.className = 'nt-sel-popup-original';

    const resultDiv = document.createElement('div');
    resultDiv.className = 'nt-sel-popup-result';

    container.appendChild(originalDiv);
    container.appendChild(resultDiv);

    // Clear hide timer on popup enter (from dot leave)
    container.addEventListener('mouseenter', () => this.handlePopupEnter());

    (document.body || document.documentElement).appendChild(container);
    this.popup = container;
  }

  private positionPopup(): void {
    if (!this.popup || !this.dot) return;

    const dotRect = this.dot.getBoundingClientRect();
    const popupWidth = this.popup.offsetWidth || 320;
    const popupHeight = this.popup.offsetHeight || 100;

    // Try left of dot first
    let left = dotRect.left - popupWidth - 8;
    if (left < 8) {
      // Not enough space on left, position to the right
      left = dotRect.right + 8;
    }

    // Center vertically on dot
    let top = dotRect.top + (DOT_SIZE_PX - popupHeight) / 2;

    // Clamp to viewport
    top = Math.max(8, top);
    if (top + popupHeight > window.innerHeight - 8) {
      top = window.innerHeight - popupHeight - 8;
    }

    this.popup.style.left = left + 'px';
    this.popup.style.top = top + 'px';
  }

  private hidePopup(): void {
    this.clearTimers();

    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }

    // Discard in-flight translation
    this.currentRequestId = null;
    this.isTranslating = false;
  }

  // --- Private: event handlers ---

  private handleMouseDown(): void {
    this.isMouseSelecting = true;
    this.hideDot();
    this.hidePopup();
  }

  private handleMouseUp(): void {
    this.isMouseSelecting = false;
    // Let the browser finalize the selection, then check
    setTimeout(() => this.handleSelectionChange(), 0);
  }

  private handleSelectionChange(): void {
    // Suppress dot during mouse selection — only show after mouseup
    if (this.isMouseSelecting) {
      this.hideDot();
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      this.hideDot();
      this.hidePopup();
      this.selectedText = null;
      return;
    }

    const text = sel.toString().trim();
    if (text.length < MIN_SELECTION_LENGTH) {
      this.hideDot();
      this.hidePopup();
      this.selectedText = null;
      return;
    }

    // Skip selections inside our own injected UI
    const range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const ancestorEl = ancestor.nodeType === Node.ELEMENT_NODE
      ? ancestor as Element
      : ancestor.parentElement;
    if (ancestorEl?.closest('[data-nt]')) {
      this.hideDot();
      this.hidePopup();
      this.selectedText = null;
      return;
    }

    // Skip CJK-dominant text
    const analysis = analyzeMixedLanguageText(text);
    if (analysis.cjkRatio > 0.5) {
      this.hideDot();
      this.hidePopup();
      this.selectedText = null;
      return;
    }

    // Selection changed: hide popup if open
    if (this.popup) {
      this.hidePopup();
    }

    this.selectedText = text;
    this.positionDot();
  }

  private handleDotEnter(): void {
    this.clearTimer(this.hideTimer);
    this.hideTimer = null;

    if (this.popup) return; // Already open

    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      this.openPopup();
    }, POPUP_SHOW_DELAY_MS);
  }

  private handleDotLeave(): void {
    this.clearTimer(this.showTimer);
    this.showTimer = null;

    // Don't hide immediately — popup enter may clear this timer
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.popup) {
        this.hidePopup();
      }
    }, POPUP_HIDE_DELAY_MS);
  }

  private handlePopupEnter(): void {
    this.clearTimer(this.hideTimer);
    this.hideTimer = null;
  }

  // --- Private: translation ---

  private openPopup(): void {
    if (!this.selectedText) return;

    this.createPopup();
    if (!this.popup) return;

    // Set original text
    const originalDiv = this.popup.querySelector('.nt-sel-popup-original');
    if (originalDiv) {
      originalDiv.textContent = truncateText(this.selectedText, MAX_ORIGINAL_TEXT_LENGTH);
    }

    // Detect theme from selection ancestor
    this.applyTheme();

    this.positionPopup();
    this.startTranslation();
  }

  private applyTheme(): void {
    if (!this.popup) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const ancestorEl = ancestor.nodeType === Node.ELEMENT_NODE
      ? ancestor as Element
      : ancestor.parentElement;

    if (ancestorEl) {
      const theme = detectElementTheme(ancestorEl);
      if (theme === 'dark') {
        this.popup.classList.add('nt-sel-theme-dark');
      } else {
        this.popup.classList.remove('nt-sel-theme-dark');
      }
    }
  }

  private async startTranslation(): Promise<void> {
    if (this.isTranslating || !this.selectedText || !this.popup) return;

    this.isTranslating = true;
    const requestId = crypto.randomUUID();
    this.currentRequestId = requestId;

    const resultDiv = this.popup.querySelector('.nt-sel-popup-result');
    if (!resultDiv) {
      this.isTranslating = false;
      return;
    }

    // Show loading skeleton
    resultDiv.textContent = '';
    resultDiv.classList.add('nt-sel-loading');
    resultDiv.classList.remove('nt-sel-error');

    try {
      const config = await this.getConfig();
      if (!isProviderConfigured(config)) {
        if (this.currentRequestId !== requestId) return;
        resultDiv.classList.remove('nt-sel-loading');
        resultDiv.classList.add('nt-sel-error');
        resultDiv.textContent = '请先在扩展弹窗中完成翻译配置';
        return;
      }

      const truncatedText = truncateText(this.selectedText, MAX_SELECTION_LENGTH);

      const result: TranslateBatchResult = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCH',
        batchId: requestId,
        texts: [truncatedText],
        totalBatches: 0,
      });

      // Discard stale responses
      if (this.currentRequestId !== requestId) return;

      resultDiv.classList.remove('nt-sel-loading');

      if (result.error) {
        resultDiv.classList.add('nt-sel-error');
        resultDiv.textContent = result.error;
        return;
      }

      if (result.translations?.[0]) {
        resultDiv.textContent = result.translations[0];
      } else {
        resultDiv.classList.add('nt-sel-error');
        resultDiv.textContent = '翻译结果为空';
      }
    } catch (err) {
      if (this.currentRequestId !== requestId) return;

      resultDiv.classList.remove('nt-sel-loading');
      resultDiv.classList.add('nt-sel-error');

      // Check if extension context was invalidated
      try {
        if (!chrome.runtime?.id) {
          resultDiv.textContent = '扩展已更新，请刷新页面';
          return;
        }
      } catch {
        resultDiv.textContent = '扩展已更新，请刷新页面';
        return;
      }

      resultDiv.textContent = '翻译失败，请重试';
    } finally {
      if (this.currentRequestId === requestId) {
        this.isTranslating = false;
      }
    }
  }

  // --- Private: helpers ---

  private clearTimers(): void {
    this.clearTimer(this.showTimer);
    this.showTimer = null;
    this.clearTimer(this.hideTimer);
    this.hideTimer = null;
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}
