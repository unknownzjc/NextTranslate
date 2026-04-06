import { afterEach, describe, expect, it } from 'vitest';
import { FloatingBall } from '../../src/content/floating-ball';

describe('FloatingBall', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('翻译中时右下角只显示省略号呼吸徽标，不显示 tips', () => {
    const floatingBall = new FloatingBall(() => {});
    floatingBall.setState({ mode: 'translating' });

    const button = document.querySelector('.nt-fab-button') as HTMLButtonElement;
    const hint = document.querySelector('.nt-fab-hint') as HTMLSpanElement;
    const badge = document.querySelector('.nt-fab-badge') as HTMLSpanElement;

    expect(button.getAttribute('data-badge')).toBe('loading');
    expect(hint.textContent).toBe('');
    expect(badge.textContent).toBe('...');

    floatingBall.destroy();
  });

  it('翻译完成后右下角显示打勾徽标', () => {
    const floatingBall = new FloatingBall(() => {});
    floatingBall.setState({ mode: 'translated', visible: true });

    const button = document.querySelector('.nt-fab-button') as HTMLButtonElement;
    const badge = document.querySelector('.nt-fab-badge') as HTMLSpanElement;

    expect(button.getAttribute('data-badge')).toBe('success');
    expect(badge.textContent).toBe('✓');

    floatingBall.destroy();
  });
});
