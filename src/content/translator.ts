import type { TranslateBatchResult } from '@shared/messages';
import {
  collectParagraphs,
  splitIntoBatches,
  extractGlossaryTerms,
  restoreCodePlaceholders,
  splitLongText,
  type ExtractedParagraph,
} from './extractor';

const MAX_BATCHES_PER_TAB = 100;
const KEEPALIVE_INTERVAL_MS = 25000;
const SW_RETRY_MAX = 5;
const SW_RETRY_BASE_MS = 1000;

interface ChunkJob {
  text: string;
  blockIndex: number;
  chunkIndex: number;
}

interface BlockState {
  element: Element;
  sourceText: string;
  codeMap: Map<string, string>;
  translatedChunks: Array<string | undefined>;
  remainingChunks: number;
  rendered: boolean;
  failed: boolean;
  failureMessage?: string;
}

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
  onBlocksQueued?: (elements: Element[]) => void;
  onBlockFailed?: (element: Element, error: string) => void;
}

export interface TranslatorStartOptions {
  includeElement?: (el: Element) => boolean;
  shouldSkipElement?: (el: Element, text: string) => boolean;
  paragraphs?: ExtractedParagraph[];
  retryFailed?: boolean;
}

export class Translator {
  private cache = new Map<string, string>();
  private translatedSet = new Set<Element>();
  private translatedSourceText = new WeakMap<Element, string>();
  private failedSourceText = new WeakMap<Element, string>();
  private batchMap = new Map<string, ChunkJob[]>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;
  private glossary: string[] = [];
  private targetLanguage = 'Simplified Chinese';
  private completedBlocks = 0;
  private totalBlocks = 0;
  private runId = 0;
  private blockStates: BlockState[] = [];

  constructor(private callbacks: TranslatorCallbacks) {}

  hasPendingWork(container: Element, options: TranslatorStartOptions = {}): boolean {
    return this.resolveParagraphs(container, options).length > 0;
  }

  async start(container: Element, targetLanguage: string, options: TranslatorStartOptions = {}) {
    const runId = ++this.runId;
    this.cancelled = false;
    this.targetLanguage = targetLanguage;
    this.completedBlocks = 0;
    this.totalBlocks = 0;
    this.blockStates = [];
    this.batchMap.clear();
    this.stopKeepalive();

    const paragraphs = this.resolveParagraphs(container, options);
    if (paragraphs.length === 0) {
      this.callbacks.onComplete();
      return;
    }

    this.totalBlocks = paragraphs.length;
    this.callbacks.onProgress(0, this.totalBlocks);

    // Extract glossary from original block text.
    this.glossary = extractGlossaryTerms(paragraphs.map(p => p.text));

    const uncachedJobs: ChunkJob[] = [];

    paragraphs.forEach((paragraph, blockIndex) => {
      const chunks = splitLongText(paragraph.text);
      const blockState: BlockState = {
        element: paragraph.element,
        sourceText: paragraph.text,
        codeMap: paragraph.codeMap,
        translatedChunks: new Array(chunks.length),
        remainingChunks: chunks.length,
        rendered: false,
        failed: false,
      };

      this.blockStates.push(blockState);

      chunks.forEach((chunkText, chunkIndex) => {
        const cacheKey = fnv1a(chunkText + '\0' + targetLanguage);
        const cached = this.cache.get(cacheKey);

        if (cached !== undefined) {
          blockState.translatedChunks[chunkIndex] = cached;
          blockState.remainingChunks--;
        } else {
          uncachedJobs.push({ text: chunkText, blockIndex, chunkIndex });
        }
      });
    });

    for (let blockIndex = 0; blockIndex < this.blockStates.length; blockIndex++) {
      this.tryRenderBlock(blockIndex, runId);
    }

    if (this.callbacks.onBlocksQueued) {
      const pendingEls = this.blockStates
        .filter(bs => !bs.rendered && !bs.failed)
        .map(bs => bs.element);
      if (pendingEls.length > 0) {
        this.callbacks.onBlocksQueued(pendingEls);
      }
    }

    if (this.completedBlocks >= this.totalBlocks) {
      this.finishRun(runId);
      return;
    }

    const batchJobs = capBatchCount(splitIntoBatches(uncachedJobs.map(job => job.text)), MAX_BATCHES_PER_TAB)
      .map(indices => indices.map(index => uncachedJobs[index]));

    if (batchJobs.length === 0) {
      this.finishRun(runId);
      return;
    }

    this.startKeepalive();

    for (let seq = 0; seq < batchJobs.length; seq++) {
      if (this.cancelled || runId !== this.runId) break;

      const jobs = batchJobs[seq];
      const batchId = crypto.randomUUID();
      this.batchMap.set(batchId, jobs);

      void this.sendBatch(batchId, jobs, runId);
    }
  }

  private async sendBatch(batchId: string, jobs: ChunkJob[], runId: number) {
    const texts = jobs.map(job => job.text);
    let retries = 0;

    while (retries < SW_RETRY_MAX && !this.cancelled && runId === this.runId) {
      try {
        if (chrome.runtime.id === undefined) {
          this.handleOrphaned();
          return;
        }

        const result: TranslateBatchResult = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_BATCH',
          batchId,
          texts,
          totalBatches: 0,
        });

        if (runId !== this.runId || !this.batchMap.has(batchId)) return;

        if (result.cancelled) {
          retries++;
          if (retries >= SW_RETRY_MAX) {
            this.stopKeepalive();
            this.callbacks.onError('页面仍在加载中，翻译已中止，请稍后重试');
            return;
          }
          const jitter = 1 + (Math.random() * 0.4 - 0.2);
          const delay = Math.min(400 * Math.pow(2, retries - 1) * jitter, 5000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        const batchJobs = this.batchMap.get(batchId);
        if (!batchJobs) return;
        this.batchMap.delete(batchId);

        if (result.error) {
          this.markBatchFailed(batchJobs, result.error, runId);
          return;
        }

        if (result.translations.length !== batchJobs.length) {
          this.markBatchFailed(batchJobs, '翻译结果数量不匹配，请重试', runId);
          return;
        }

        for (let i = 0; i < result.translations.length; i++) {
          const job = batchJobs[i];
          if (!job) continue;

          const cacheKey = fnv1a(job.text + '\0' + this.targetLanguage);
          this.cache.set(cacheKey, result.translations[i]);

          const blockState = this.blockStates[job.blockIndex];
          if (!blockState || blockState.rendered || blockState.failed || blockState.translatedChunks[job.chunkIndex] !== undefined) {
            continue;
          }

          blockState.translatedChunks[job.chunkIndex] = result.translations[i];
          blockState.remainingChunks--;
          this.tryRenderBlock(job.blockIndex, runId);
        }
        return;

      } catch (err: unknown) {
        if (chrome.runtime.id === undefined) {
          this.handleOrphaned();
          return;
        }

        retries++;
        if (retries >= SW_RETRY_MAX) {
          this.stopKeepalive();
          this.callbacks.onError('Service Worker 连接失败，翻译中止');
          return;
        }
        const jitter = 1 + (Math.random() * 0.4 - 0.2);
        const delay = SW_RETRY_BASE_MS * Math.pow(2, retries - 1) * jitter;
        await new Promise(r => setTimeout(r, Math.min(delay, 30000)));
      }
    }
  }

  private resolveParagraphs(container: Element, options: TranslatorStartOptions): ExtractedParagraph[] {
    if (options.paragraphs) {
      return options.paragraphs.filter(({ element, text }) => !this.shouldSkipBlock(element, text, options));
    }

    return collectParagraphs(
      container,
      (el, text) => this.shouldSkipBlock(el, text, options),
      options.includeElement,
    );
  }

  private shouldSkipBlock(el: Element, text: string, options: TranslatorStartOptions): boolean {
    if (this.translatedSet.has(el) && this.translatedSourceText.get(el) === text) {
      return options.shouldSkipElement ? options.shouldSkipElement(el, text) : true;
    }

    if (!options.retryFailed && this.failedSourceText.get(el) === text) {
      return true;
    }

    return false;
  }

  private tryRenderBlock(blockIndex: number, runId: number) {
    if (this.cancelled || runId !== this.runId) return;

    const blockState = this.blockStates[blockIndex];
    if (!blockState || blockState.rendered || blockState.failed || blockState.remainingChunks > 0) return;

    const translatedText = joinTranslatedChunks(
      blockState.translatedChunks.map(chunk => restoreCodePlaceholders(chunk ?? '', blockState.codeMap)),
      this.targetLanguage,
    );

    blockState.rendered = true;
    blockState.failureMessage = undefined;

    if (blockState.element.isConnected) {
      this.callbacks.onBatchTranslated(blockIndex, [blockState.element], [translatedText]);
      this.translatedSet.add(blockState.element);
      this.translatedSourceText.set(blockState.element, blockState.sourceText);
      this.failedSourceText.delete(blockState.element);
    }

    this.completeBlock(runId);
  }

  private markBatchFailed(batchJobs: ChunkJob[], error: string, runId: number) {
    const failedBlockIndexes = new Set(batchJobs.map(job => job.blockIndex));
    for (const blockIndex of failedBlockIndexes) {
      this.markBlockFailed(blockIndex, error, runId);
    }
  }

  private markBlockFailed(blockIndex: number, error: string, runId: number) {
    if (this.cancelled || runId !== this.runId) return;

    const blockState = this.blockStates[blockIndex];
    if (!blockState || blockState.rendered || blockState.failed) return;

    blockState.failed = true;
    blockState.failureMessage = error;
    this.failedSourceText.set(blockState.element, blockState.sourceText);

    if (blockState.element.isConnected) {
      this.callbacks.onBlockFailed?.(blockState.element, error);
    }

    this.completeBlock(runId);
  }

  private completeBlock(runId: number) {
    this.completedBlocks++;
    this.callbacks.onProgress(this.completedBlocks, this.totalBlocks);

    if (this.completedBlocks >= this.totalBlocks) {
      this.finishRun(runId);
    }
  }

  private finishRun(runId: number) {
    if (runId !== this.runId || this.cancelled) return;
    this.batchMap.clear();
    this.stopKeepalive();
    this.callbacks.onComplete();
  }

  cancel() {
    this.cancelled = true;
    this.runId++;
    this.batchMap.clear();
    this.blockStates = [];
    this.stopKeepalive();

    try {
      chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATE' }).catch(() => {});
    } catch { /* may be orphaned */ }

    this.callbacks.onCancelled();
  }

  hasUpToDateTranslation(el: Element, text: string): boolean {
    return this.translatedSet.has(el) && this.translatedSourceText.get(el) === text;
  }

  hasUpToDateFailure(el: Element, text: string): boolean {
    return this.failedSourceText.get(el) === text;
  }


  getTranslatedSet(): Set<Element> {
    return this.translatedSet;
  }

  resetState() {
    this.translatedSet.clear();
    this.translatedSourceText = new WeakMap();
    this.failedSourceText = new WeakMap();
    this.batchMap.clear();
    this.blockStates = [];
    this.completedBlocks = 0;
    this.totalBlocks = 0;
    this.runId++;
    this.cancelled = false;
    this.glossary = [];
    this.stopKeepalive();
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

function joinTranslatedChunks(chunks: string[], targetLanguage: string): string {
  const separator = isCjkTargetLanguage(targetLanguage) ? '' : ' ';
  return chunks.map(chunk => chunk.trim()).filter(Boolean).join(separator).trim();
}

function isCjkTargetLanguage(targetLanguage: string): boolean {
  return targetLanguage === 'Simplified Chinese'
    || targetLanguage === 'Traditional Chinese'
    || targetLanguage === 'Japanese'
    || targetLanguage === 'Korean';
}

function capBatchCount(batchIndices: number[][], limit: number): number[][] {
  if (batchIndices.length <= limit) return batchIndices;

  const kept = batchIndices.slice(0, limit);
  const overflow = batchIndices.slice(limit).flat();
  kept[kept.length - 1] = [...kept[kept.length - 1], ...overflow];
  return kept;
}
