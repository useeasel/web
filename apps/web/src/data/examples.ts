/**
 * Example portfolios shown on the landing page.
 *
 * To feature a REAL artist: add an entry with `url` (their live site) and ideally
 * `image` (a screenshot/cover in apps/web/public/examples/). Entries with a `url`
 * render as clickable cards with the thumbnail; entries without one fall back to the
 * Bauhaus placeholder motif. Swap the placeholders out as soon as a few sites are
 * live — real portfolios are the best marketing, and fake names read as untrustworthy.
 */
export interface Example {
  name: string;
  medium: string;
  /** Live site URL. When set, the card links out and is treated as a real example. */
  url?: string;
  /** Path under /public (e.g. /examples/mira.jpg) for a real cover screenshot. */
  image?: string;
  /** Placeholder visuals (used only when there's no image). */
  shape: 'square' | 'circle' | 'triangle';
  tint: string;
}

export const examples: Example[] = [
  // Placeholders — replace with real artists (add `url` + `image`). See file header.
  { name: 'Mira Okonkwo', medium: 'Oil painting', shape: 'square', tint: 'var(--c-red)' },
  { name: 'Leon Vance', medium: 'Ceramics', shape: 'circle', tint: 'var(--c-blue)' },
  { name: 'Saoirse Bell', medium: 'Printmaking', shape: 'triangle', tint: 'var(--c-yellow)' },
];

/** True once at least one real (linked) example exists — drives the copy below the grid. */
export const hasRealExamples = examples.some((e) => !!e.url);
