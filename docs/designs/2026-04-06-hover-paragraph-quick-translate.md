# Hover Ctrl/Cmd Paragraph Translation

**Date:** 2026-04-06

## Context
The feature idea is to let users translate a single paragraph or paragraph-like text block on demand by hovering it and pressing a modifier key, instead of always starting full-page translation. The intended interaction was clarified as: hover a text block first, then press the shortcut to translate that block immediately.

The motivation is to support a faster "translate just this part" workflow while keeping the existing full-page translation experience intact. A key product requirement is that paragraph translation should not become a separate system. Instead, it should fit naturally into the current architecture so a user can translate one block first and later continue to full-page translation without losing consistency in cache behavior, UI, or state handling.

Platform-specific shortcut behavior was also agreed:
- Windows / Linux: `Ctrl`
- macOS: `Command`

## Discussion
Several solution directions were considered:

1. **Separate paragraph-translation subsystem**
   - Pros: isolation and simpler mental separation.
   - Cons: duplicated logic for translation requests, caching, insertion, error handling, and state; awkward upgrade path from paragraph to full page.

2. **Treat paragraph translation as a special entry to the existing full-page flow**
   - Pros: strong reuse of existing translator, injector, and background queue.
   - Cons: page-level state semantics would become unclear, especially when only one paragraph is translated.

3. **Unified translation engine with explicit scope**
   - Reuse the existing translation pipeline.
   - Add a scope layer to distinguish paragraph-level and page-level work.
   - This was selected as the final direction.

The following interaction decisions were confirmed during discussion:
- Trigger style: **hover first, then press shortcut once**.
- Functional scope: **translate the current text block first, with a seamless upgrade path to full-page translation**.
- Priority: **consistency with the current full-page translation experience**.
- Mis-trigger prevention is important, so the design avoids continuous "hold modifier and sweep across paragraphs" behavior.

The following UI and product decisions were also agreed:
- Hover should be **invisible by default in v1**. Do not show hover outlines, hover hints, or persistent affordances before the user presses the shortcut.
- Paragraph translation should not make the UI look like the whole page is finished.
- Segment translation should not drive a separate floating-action-button state in v1.
- During full-page translation, the floating action button may show only the compact `...` activity badge without a text tip.
- Failures should be quiet and local, not disruptive to the entire page.
- A future entry for paragraph-level re-translation after full-page translation should be structurally possible, but not exposed in the first version.

## Approach
The agreed direction is to keep a single translation engine and introduce a translation **scope** model:
- `segment`: translate only the currently hovered paragraph or paragraph-like text block.
- `page`: translate the full page.

This avoids building a second translation system while preserving a clean user mental model:
- A user can quickly translate one block.
- The page can later be upgraded to full-page translation.
- Already translated paragraphs are reused and skipped when appropriate.
- Display/hide behavior remains global for all injected translations.

To support this, the content script state is conceptually split into two dimensions:

1. **Run state**
   - `idle`
   - `translating`
   - `done`
   - errors are handled as transient local feedback rather than a persistent segment-level state in v1

2. **Scope**
   - `none`
   - `segment`
   - `page`

This enables clearer semantics such as:
- `idle + none`: no translation yet.
- `done + segment`: one or more local translations exist, but the page is not fully translated.
- `translating + page`: full-page translation is in progress.
- `done + page`: full-page translation is complete.

The first version should support:
- Hover candidate detection.
- Modifier-key paragraph translation.
- Upgrade from paragraph translation to full-page translation.
- Quiet local error handling.
- Reuse of the existing cache, injection, queueing, and visibility behavior.

The first version should explicitly avoid:
- Continuous translation while holding the modifier key and moving the mouse.
- A visible "re-translate this paragraph" action after full-page translation.
- User-configurable shortcut mapping.
- Heavy or persistent hover affordances.
- Segment-specific floating action button status messaging.

## Architecture
### State Model
The current content-script flow should be extended with explicit scope semantics.

Suggested logical model:
- `runState`: `idle | translating | done`
- `scope`: `none | segment | page`
- segment and page failures use transient UI recovery rather than a persistent `error` runState in v1

Important behavior:
- Segment translation moves the page into `translating + segment`, then `done + segment` internally.
- Clicking the floating action button after segment completion upgrades to `page` scope and starts remaining page translation.
- Full-page completion moves to `done + page`.
- Full-page translation in progress blocks new segment triggers.
- The floating action button should remain in its normal idle semantics for segment-only translation in v1.
- The design should leave room for future paragraph re-translation after `done + page`, but this should not be enabled in v1.

### Components
#### 1. Hover Controller (new)
A new content-side controller should be introduced to manage hover-triggered paragraph translation.

Responsibilities:
- Listen to `mousemove` or `pointermove` and track the current DOM hover target.
- Resolve the hovered DOM node upward to the nearest translatable text block.
- Listen to `keydown` / `keyup` and detect the platform-specific shortcut.
- Trigger only on the transition from "not pressed" to "pressed".
- Maintain cooldown / deduplication so the same block is not repeatedly triggered.
- Ignore triggers in inputs, editors, and `contenteditable` regions.
- Keep hover handling internal; do not render visible hover outlines or hover hints in v1.
- Apply processing feedback only after the trigger is accepted, using the existing inline loading dots and loading placeholder.

#### 2. Translation Orchestrator (existing content-script state machine, enhanced)
The current stateful logic in `src/content/index.ts` should remain the main coordinator and gain scope awareness.

Responsibilities:
- Decide whether a segment translation is allowed.
- Move between `segment` and `page` scopes.
- Preserve current logic for cancellation, visibility toggling, SPA navigation reset, and integration with the floating action button.
- Ensure UI semantics differ between "some paragraphs translated" and "whole page translated".
- Do not surface a separate floating action button state for segment translation in v1.
- Reject segment triggers when the user is currently focused inside an editable region, even if the hovered target itself is outside that region.

#### 3. Translator (existing, reused)
The existing `Translator` remains the shared translation engine.

Implementation direction:
- For segment translation, allow the orchestrator to pass an explicitly extracted paragraph / text-block payload derived from the hovered element.
- For page translation, continue using the existing page-level collection logic.
- Reuse current cache behavior so a block translated in `segment` scope does not need to be re-requested during `page` scope if the source text has not changed.
- If the source text of a previously translated block changes, treat it as new content and allow segment translation again.

#### 4. Injector (existing, reused)
The existing injector should remain responsible for:
- Loading placeholders.
- Translation insertion.
- Global visibility toggling.

Implementation notes:
- Segment translation should use the same inline pending dots and loading placeholder as page translation.
- On segment failure or cancel, loading placeholders must be removed completely rather than left behind as empty translation shells.
- It is acceptable to attach lightweight internal metadata to injected translations indicating their origin scope (`segment` or `page`) if helpful for orchestration, debugging, or future upgrades.
- This metadata does not need to be visible to users.

#### 5. Background Queue (existing, reused)
No major architectural change is needed in the background service worker.

From the queue's perspective:
- Segment translation is simply a smaller request set.
- Page translation remains the normal multi-batch process.

### Candidate Paragraph Detection
Segment quick-translate should use a **lighter, interaction-oriented candidate rule** than full-page extraction.

Rules:
- The system should climb from the hovered node to the nearest valid translatable text block.
- Eligible candidates may be standard paragraph elements or paragraph-like container blocks such as `div`, `article`, `section`, `main`, `aside`, or `label`, as long as they contain meaningful text.
- The candidate does **not** need to belong to the current full-page main container.
- The candidate does **not** need to satisfy page-only restrictions such as `paragraphSelectorOnly`.
- Code, navigation-like blocks, hidden content, already injected translation UI, editable regions, and similar non-content areas remain excluded.
- If a generic container has a more specific translatable descendant block, prefer the nearer descendant rather than translating an overly large ancestor.

This keeps quick translate intuitive: hover the text you want, then press the shortcut. Full-page extraction remains stricter and page-oriented; quick translate is intentionally more local and direct.

### Interaction Flow
#### Flow 1: Hover + Ctrl/Cmd for paragraph translation
1. Hover Controller tracks the current candidate text block.
2. User presses the platform shortcut.
3. Orchestrator validates that:
   - a candidate exists,
   - the page is not already performing full-page translation,
   - the block is not in cooldown,
   - the text is not already translated with the same source content,
   - the user is not focused in an editable region.
4. The page enters `translating + segment` internally.
5. The unified translator runs against only that explicitly extracted block.
6. Injector shows the existing loading dots and loading placeholder, then inserts the translation.
7. The page enters `done + segment` internally, while the floating action button remains in its normal idle semantics.

#### Flow 2: Upgrade from paragraph translation to page translation
1. The page is in `done + segment`.
2. The user clicks the floating action button to translate the full page.
3. Scope upgrades to `page`.
4. Full-page collection runs, skipping paragraphs already translated with unchanged source text.
5. Only remaining content is sent for translation.
6. Completion moves the page to `done + page`.

#### Flow 3: Full page already translated
Default v1 behavior:
- Keep the main user action focused on show/hide behavior.
- Do not expose paragraph re-translation yet.

Structural reservation:
- The architecture should not prevent a future enhancement where hover + modifier triggers a paragraph re-translation in `done + page` state.

### UI Semantics
#### Hover feedback
- Do not show visible hover feedback in v1.
- Do not show pre-trigger shortcut hints.
- Keep hover state entirely internal until the user actually presses the shortcut.

#### Segment processing state
- Once the shortcut is accepted, the target block should show the same inline loading dots and loading placeholder style used elsewhere in the extension.
- The floating action button should not switch into a special segment state in v1.

#### Segment-complete state
- The block should use the same translation rendering style as the existing full-page experience.
- The floating action button should remain in its normal page-level idle semantics rather than implying that the page is translated or that segment translation has its own mode.

#### Page-translating state
- During full-page translation, the floating action button may show only the compact `...` activity badge.
- A text tip is not required in v1.

#### Page-complete state
- Only `done + page` should map to the existing "translated / toggle visibility" completed semantics for the page.

### Error Handling
The agreed preference is for quiet, local failure handling.

For segment translation failure:
- Remove the block loading state completely.
- Since hover has no visible state in v1, simply return to the normal non-hover UI.
- Use only lightweight local feedback or a brief low-noise floating action button message.
- Avoid loud global errors for a single block failure.

State recovery after failure should depend on existing translated content:
- No previous translations: return to `idle + none`.
- Existing segment translations: return to `done + segment`.
- Existing page translations: remain in `done + page`.

### Boundary Conditions
Do not trigger segment translation when:
- Full-page translation is already in progress.
- No valid candidate text block exists.
- The hovered target is inside an input, editor, or editable surface.
- The currently focused element is an input, editor, or editable surface.
- Translation configuration is incomplete.
- The current tab or page cannot accept content-script interaction.

DOM and navigation handling:
- If a candidate block is removed before insertion, the result should be discarded.
- If block source text changes, treat it as new source content.
- On SPA navigation, clear hover candidate state, cooldown state, and `segment` scope state.

### Visibility and Cache Behavior
Visibility remains global:
- Show/hide actions apply to all injected translations regardless of whether they originated from `segment` or `page` scope.

Cache reuse remains unchanged:
- Cache keying should continue to use source text and target language.
- Previously translated blocks should be reused when the full-page translation later includes the same content.
- Segment translation should not be blocked by a stale rendered node if the underlying source text has changed.

### Testing Notes
Recommended coverage includes:
- Candidate resolution from nested DOM nodes.
- Candidate resolution for paragraph-like container blocks.
- Segment quick-translate behavior outside page-only selectors or page-only extraction limits.
- Platform-specific key mapping (`Ctrl` vs `Command`).
- One-shot keydown triggering and cooldown behavior.
- Cooldown should start only after a trigger is actually accepted.
- Segment translation completion and page-scope upgrade.
- Blocking segment triggers while full-page translation is active.
- Blocking segment triggers while editable focus is active.
- Quiet failure handling and state recovery.
- Placeholder cleanup after segment failure or cancel.
- Source-text-change handling for re-translation.
- SPA resets and detached-node safety.
