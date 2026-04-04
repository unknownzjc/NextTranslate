import type { TranslateBatchResult } from '@shared/messages';
import { collectParagraphs, splitIntoBatches, extractGlossaryTerms, restoreCodePlaceholders, splitLongText, type ExtractedParagraph } from './extractor';

const MAX_BATCHES_PER_TAB = 100;
const KEEPALIVE_INTERVAL_MS = 25000;
const SW_RETRY_MAX = 5;
const SW_RETRY_BASE_MS = 1000;

// FNV-1a hash
export function fnv1a(str: string): string {
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
  private cache = new Map<string, string>();
  private translatedSet = new Set<Element>();
  private batchMap = new Map<string, { seq: number; elements: Element[]; codeMaps: Map<string, string>[] }>();
  private nextRenderSeq = 0;
  private pendingRenders = new Map<number, { elements: Element[]; translations: string[] }>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;
  private glossary: string[] = [];
  private targetLanguage = 'Simplified Chinese';
  private completedBatches = 0;
  private totalBatches = 0;

  constructor(private callbacks: TranslatorCallbacks) {}

  async start(container: Element, targetLanguage: string) {
    this.cancelled = false;
    this.targetLanguage = targetLanguage;
    this.nextRenderSeq = 0;
    this.completedBatches = 0;
    this.totalBatches = 0;
    this.pendingRenders.clear();

    const paragraphs = collectParagraphs(container, this.translatedSet);
    if (paragraphs.length === 0) {
      this.callbacks.onComplete();
      return;
    }

    // Split long paragraphs
    const processedParagraphs: ExtractedParagraph[] = [];
    for (const p of paragraphs) {
      const subTexts = splitLongText(p.text);
      if (subTexts.length === 1) {
        processedParagraphs.push(p);
      } else {
        for (const subText of subTexts) {
          processedParagraphs.push({ element: p.element, text: subText, codeMap: p.codeMap });
        }
      }
    }

    // Extract glossary
    const texts = processedParagraphs.map(p => p.text);
    this.glossary = extractGlossaryTerms(texts);

    // Check cache hits
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

    // Render cached translations immediately
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

    // Split into batches
    const uncachedTexts = uncachedIndices.map(i => texts[i]);
    const batchIndices = splitIntoBatches(uncachedTexts);

    const totalBatches = Math.min(batchIndices.length, MAX_BATCHES_PER_TAB);
    this.totalBatches = totalBatches;

    this.callbacks.onProgress(0, totalBatches);
    this.startKeepalive();

    for (let seq = 0; seq < totalBatches; seq++) {
      if (this.cancelled) break;

      const localIndices = batchIndices[seq];
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

        if (!this.batchMap.has(batchId)) return;

        if (result.error) {
          this.callbacks.onError(result.error);
          return;
        }

        // Cache results
        for (let i = 0; i < result.translations.length; i++) {
          const originalIdx = localIndices[i];
          const cacheKey = fnv1a(allTexts[originalIdx] + '\0' + this.targetLanguage);
          this.cache.set(cacheKey, result.translations[i]);
        }

        // Restore code placeholders
        const batchInfo = this.batchMap.get(batchId)!;
        const restoredTranslations = result.translations.map((t, i) =>
          restoreCodePlaceholders(t, batchInfo.codeMaps[i])
        );

        this.completedBatches++;
        this.callbacks.onProgress(this.completedBatches, this.totalBatches);

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

    while (this.pendingRenders.has(this.nextRenderSeq)) {
      const batch = this.pendingRenders.get(this.nextRenderSeq)!;
      this.pendingRenders.delete(this.nextRenderSeq);

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
    } catch { /* may be orphaned */ }

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
    this.completedBatches = 0;
    this.totalBatches = 0;
    this.cancelled = false;
    this.glossary = [];
  }

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
