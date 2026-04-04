export class ProgressBar {
  private container: HTMLElement | null = null;
  private label: HTMLElement | null = null;

  show() {
    if (this.container) this.container.remove();

    this.container = document.createElement('div');
    this.container.className = 'nt-progress-container';

    this.label = document.createElement('span');
    this.label.className = 'nt-progress-label';
    this.label.textContent = '0/0';

    this.container.appendChild(this.label);
    document.body.appendChild(this.container);
  }

  update(completed: number, total: number) {
    if (!this.label) return;
    this.label.textContent = `${completed}/${total}`;
  }

  complete() {
    if (!this.label || !this.container) return;
    this.label.textContent = '翻译完成';
    this.container.classList.add('nt-progress-done');
    setTimeout(() => this.hide(), 1000);
  }

  error(message: string) {
    if (!this.label || !this.container) return;
    this.label.textContent = message;
    this.container.classList.add('nt-progress-error');
    setTimeout(() => this.hide(), 3000);
  }

  hide() {
    if (this.container) {
      this.container.classList.add('nt-progress-fadeout');
      setTimeout(() => {
        this.container?.remove();
        this.container = null;
        this.label = null;
      }, 300);
    }
  }
}
