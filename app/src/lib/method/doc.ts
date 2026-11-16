// Pure helpers for rendering docs/METHOD.md on the method page (#22).

export const DOCS_GITHUB_BASE = "https://github.com/atontalapur/fireline/blob/main/docs/";

/** Drop HTML comments (the generator banner at the top of METHOD.md). */
export function prepareMethodMarkdown(md: string): string {
  return md.replace(/<!--[\s\S]*?-->\s*/g, "").trimStart();
}

/**
 * Links in METHOD.md are relative to docs/ (e.g. `sentinel3.md`). On /method they would 404,
 * so point them at the file on GitHub. Absolute URLs, root paths and anchors pass through.
 */
export function resolveDocHref(href: string | undefined): string | undefined {
  if (!href) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return href;
  return DOCS_GITHUB_BASE + href.replace(/^\.\//, "");
}

/** Shown when docs/METHOD.md is not available. Source: issue #1, "Harmonization method". */
export const FALLBACK_METHOD_MARKDOWN = `# How Fireline harmonizes MODIS and VIIRS

1. **Clean.** Keep vegetation fires (\`type = 0\`), MODIS confidence 30 or higher, VIIRS nominal or high confidence. Each detection is dated by local solar day (UTC + longitude / 15 hours).
2. **Common unit: fire cell-days.** Unique H3 resolution-8 cells (about 0.74 km², roughly one MODIS pixel) per satellite per local day. MODIS = Terra + Aqua; VIIRS = mean across the VIIRS satellites flying that day.
3. **Calibrate.** k(region, calendar month) = sum(MODIS) / sum(VIIRS) over 2012 to 2019, shrunk toward the region-wide k, with 90% bands from a year bootstrap.
4. **Splice.** Observed MODIS through December 2019, k x VIIRS from January 2020. Terra-only months (Nov 2000 to Jun 2002) are scaled to the Terra + Aqua level.
5. **Store** at H3 resolution 6 x month. Baselines and anomalies are computed at query time for whatever area is picked.
6. **Validate.** Leave-one-year-out error, overlap bias before and after (about 3-6x down to about 1x), and no step at the splice.
`;
