const COOLDOWN_MS = 1500;

export interface HoverControllerOptions {
  onTrigger: (element: Element) => boolean | Promise<boolean>;
  resolveCandidate: (target: EventTarget | null) => Element | null;
  isTranslatable: (element: Element) => boolean;
}

export class HoverController {
  private options: HoverControllerOptions;
  private currentCandidate: Element | null = null;
  private modifierDown = false;
  private modifierCandidate: Element | null = null;
  private modifierCancelled = false;
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
      if (this.modifierDown) {
        if (!this.isPlainControlKey(ke)) {
          this.modifierCancelled = true;
        }
        return;
      }
      if (!this.isPlainControlKey(ke)) return;
      this.modifierDown = true;
      this.modifierCancelled = false;
      this.modifierCandidate = this.currentCandidate;
    };

    this.handleKeyUp = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (!this.isControlKey(ke)) {
        if (this.modifierDown) {
          this.modifierCancelled = true;
        }
        return;
      }

      const el = this.modifierCancelled ? null : this.modifierCandidate;
      this.modifierDown = false;
      this.modifierCandidate = null;
      this.modifierCancelled = false;

      if (!el) return;
      this.triggerCandidate(el);
    };
  }

  private triggerCandidate(el: Element): void {
    if (this.cooldownSet.has(el) || this.pendingSet.has(el)) return;
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
    this.modifierCandidate = null;
    this.modifierCancelled = false;
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

  private isPlainControlKey(e: KeyboardEvent): boolean {
    return e.key === 'Control' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  }

  private isControlKey(e: KeyboardEvent): boolean {
    return e.key === 'Control';
  }
}
