const COOLDOWN_MS = 1500;

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export interface HoverControllerOptions {
  onTrigger: (element: Element) => boolean | Promise<boolean>;
  resolveCandidate: (target: EventTarget | null) => Element | null;
  isTranslatable: (element: Element) => boolean;
}

export class HoverController {
  private options: HoverControllerOptions;
  private currentCandidate: Element | null = null;
  private modifierDown = false;
  private enabled = false;
  private cooldownSet = new Set<Element>();
  private pendingSet = new Set<Element>();
  private cooldownTimers = new Map<Element, ReturnType<typeof setTimeout>>();

  private handlePointerMove: (e: Event) => void;
  private handleKeyDown: (e: Event) => void;
  private handleKeyUp: (e: Event) => void;

  constructor(options: HoverControllerOptions) {
    this.options = options;

    this.handlePointerMove = (e: Event) => {
      const target = (e as PointerEvent).target;
      const candidate = this.options.resolveCandidate(target);

      const validCandidate = candidate && this.options.isTranslatable(candidate) ? candidate : null;

      if (validCandidate !== this.currentCandidate) {
        this.currentCandidate = validCandidate;
      }
    };

    this.handleKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (!this.isModifierKey(ke)) return;
      if (this.modifierDown) return; // already held down - one-shot

      this.modifierDown = true;

      if (!this.currentCandidate) return;
      if (this.cooldownSet.has(this.currentCandidate) || this.pendingSet.has(this.currentCandidate)) return;

      const el = this.currentCandidate;
      this.pendingSet.add(el);
      void Promise.resolve(this.options.onTrigger(el)).then((started) => {
        this.pendingSet.delete(el);
        if (!started) return;
        if (this.cooldownSet.has(el)) return;

        // Start cooldown only after the trigger is actually accepted.
        this.cooldownSet.add(el);
        const timer = setTimeout(() => {
          this.cooldownSet.delete(el);
          this.cooldownTimers.delete(el);
        }, COOLDOWN_MS);
        this.cooldownTimers.set(el, timer);
      }).catch(() => {
        this.pendingSet.delete(el);
        // Orchestrator handles its own error UI.
      });
    };

    this.handleKeyUp = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (!this.isModifierKeyUp(ke)) return;
      this.modifierDown = false;
    };
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    document.addEventListener('pointermove', this.handlePointerMove, { passive: true });
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    document.removeEventListener('pointermove', this.handlePointerMove);
    document.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('keyup', this.handleKeyUp);
    this.clearCandidate();
  }

  reset(): void {
    this.clearCandidate();
    this.modifierDown = false;
    for (const timer of this.cooldownTimers.values()) {
      clearTimeout(timer);
    }
    this.cooldownSet.clear();
    this.pendingSet.clear();
    this.cooldownTimers.clear();
  }

  destroy(): void {
    this.disable();
    this.reset();
  }

  private clearCandidate(): void {
    this.currentCandidate = null;
  }

  private isModifierKey(e: KeyboardEvent): boolean {
    return isMac() ? e.metaKey && e.key === 'Meta' : e.ctrlKey && e.key === 'Control';
  }

  private isModifierKeyUp(e: KeyboardEvent): boolean {
    return isMac() ? e.key === 'Meta' : e.key === 'Control';
  }
}
