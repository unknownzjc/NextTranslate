import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressBar } from '../../src/content/progress';

describe('ProgressBar', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('不再渲染右下角进度提示', () => {
    const progressBar = new ProgressBar();
    progressBar.show();
    progressBar.update(3, 10);
    progressBar.complete();
    progressBar.error('error');
    progressBar.hide();

    expect(document.querySelector('.nt-progress-container')).toBeNull();
    expect(document.querySelector('.nt-progress-label')).toBeNull();
  });
});
