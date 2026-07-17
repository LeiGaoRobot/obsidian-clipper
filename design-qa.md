# Reader transcript layouts — design QA

## Scope

Three switchable YouTube Reader layouts were checked against the selected concept images:

- **Reading**: video above a centered transcript with a floating explanation card.
- **Notebook**: video above a two-column study surface with controls in a left rail.
- **Split view**: pinned video beside the transcript and its controls.

The production Reader DOM and generated `dist/reader.css` were rendered in a local Chrome preview at 1536 × 1024. The check used bilingual text, Japanese ruby readings, an active transcript row, and an open explanation card. The concept images are directional; the implementation deliberately preserves the existing Reader shell, 16:9 YouTube player, plain-text model response, and current Obsidian theme tokens.

## Comparison inputs

| Layout | Reference + implementation comparison |
| --- | --- |
| Reading | `/Users/paulgao/.codex/visualizations/2026/07/17/019f6e2c-6392-74a3-ae73-cd204f9ebe65/comparison-reading.png` |
| Notebook | `/Users/paulgao/.codex/visualizations/2026/07/17/019f6e2c-6392-74a3-ae73-cd204f9ebe65/comparison-notebook.png` |
| Split view | `/Users/paulgao/.codex/visualizations/2026/07/17/019f6e2c-6392-74a3-ae73-cd204f9ebe65/comparison-focus.png` |

Responsive checks were also run at 900 × 900 and 700 × 900. Notebook and Split view returned to a single-column flow, the layout switcher stayed available, legacy compact toggles hid at the existing mobile breakpoint, and the page had no horizontal overflow.

## Iterations

1. Replaced settings-page-only CSS variables with Reader-native accent and surface tokens so active, hover, loading, and focus states render in every Reader theme.
2. Matched the actual Reader shell and player proportions, tightened transcript rhythm, timestamp gutters, active-row treatment, and explanation-card spacing.
3. Verified all three layout states and corrected the wide Notebook playback-scroll offset so its left control rail does not push the transcript below the visible area.

## Findings

- The same player, control bar, transcript segments, translations, ruby readings, and explanation state remain mounted while switching layouts.
- Selected mode is visible through `aria-pressed`, the root layout class, and the Reader document class.
- Reading, Notebook, and Split view are visually distinct without introducing a second transcript implementation.
- Focus outlines, switch semantics, and mobile fallback remain visible and usable.
- No clipping, horizontal overflow, broken borders, or invalid Reader theme tokens remain in the checked states.

## Final result

**Passed.**
