export type FloatingBallState =
  | { mode: 'idle' }
  | { mode: 'translating'; progress?: { completed: number; total: number } }
  | { mode: 'translated'; visible: boolean }
  | { mode: 'error'; message: string };

export class FloatingBall {
  private container: HTMLDivElement;
  private hint: HTMLSpanElement;
  private button: HTMLButtonElement;
  private label: HTMLSpanElement;
  private badge: HTMLSpanElement;

  constructor(onClick: () => void) {
    this.container = document.createElement('div');
    this.container.className = 'nt-fab-wrap';
    this.container.setAttribute('data-nt', '');
    this.container.setAttribute('data-state', 'idle');

    this.hint = document.createElement('span');
    this.hint.className = 'nt-fab-hint';
    this.hint.setAttribute('data-nt', '');

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'nt-fab-button';
    this.button.setAttribute('data-nt', '');
    this.button.setAttribute('data-state', 'idle');

    this.label = document.createElement('span');
    this.label.className = 'nt-fab-label';
    this.label.setAttribute('data-nt', '');

    this.badge = document.createElement('span');
    this.badge.className = 'nt-fab-badge';
    this.badge.setAttribute('data-nt', '');

    this.button.append(this.label, this.badge);
    this.container.append(this.hint, this.button);
    this.button.addEventListener('click', onClick);

    this.setState({ mode: 'idle' });
    this.mount();
  }

  setState(state: FloatingBallState) {
    let buttonText = '译';
    let hintText = '翻译全文';
    let title = '快速翻译全文';
    let badgeText = '';
    let badgeMode: 'none' | 'progress' | 'success' = 'none';
    let stateKey = 'idle';

    if (state.mode === 'translating') {
      buttonText = '停';
      hintText = '翻译中...';
      title = '取消翻译';
      stateKey = 'translating';

      if (state.progress && state.progress.total > 0) {
        const pct = Math.min(99, Math.max(0, Math.round((state.progress.completed / state.progress.total) * 100)));
        hintText = `翻译中 ${state.progress.completed}/${state.progress.total}`;
        badgeMode = 'progress';
        badgeText = String(pct);
      }
    }

    if (state.mode === 'translated') {
      buttonText = '译';
      hintText = state.visible ? '切换为原文' : '切换为译文';
      title = hintText;
      stateKey = state.visible ? 'translated-visible' : 'translated-hidden';
      badgeMode = 'success';
      badgeText = '✓';
    }

    if (state.mode === 'error') {
      buttonText = '!';
      hintText = state.message;
      title = `翻译失败：${state.message}`;
      stateKey = 'error';
    }

    this.container.setAttribute('data-state', stateKey);
    this.button.setAttribute('data-state', stateKey);
    this.button.setAttribute('data-badge', badgeMode);
    this.button.setAttribute('aria-label', title);
    this.button.title = title;
    this.label.textContent = buttonText;
    this.hint.textContent = hintText;
    this.badge.textContent = badgeText;
  }

  destroy() {
    this.container.remove();
  }

  private mount() {
    const parent = document.body ?? document.documentElement;
    parent.appendChild(this.container);
  }
}
