// Human-readable language names from BCP 47 codes via the built-in
// Intl.DisplayNames — no dependency, no hardcoded table. Names are shown in
// English to match the UI; the code is always kept nearby (the catalog files
// and developers work in codes). Falls back to the code if unknown/unsupported.
//
// Lives in shared/ (no DOM use) so both the webview grid and the host-side
// localization tree can use it.

const cache = new Map<string, string>();

/** User-supplied names for tags `Intl` doesn't know — project conventions like
 * "en-Pseudo" or a private-use tag. Set from the `xcodeI18n.languageNames`
 * setting on both sides (see `setLanguageNameOverrides`). */
let overrides: Record<string, string> = {};

/**
 * Replace the display-name overrides. Clears the memo, since a tag's name may
 * have just changed. Lookup is case-insensitive on the tag, because language
 * tags are conventionally cased ("zh-Hans") but not case-sensitive.
 */
export function setLanguageNameOverrides(map: Record<string, string>): void {
  overrides = {};
  for (const [tag, name] of Object.entries(map ?? {})) {
    if (typeof name === "string" && name.trim() !== "") {
      overrides[tag.toLowerCase()] = name;
    }
  }
  cache.clear();
}

let displayNames: Intl.DisplayNames | undefined;
try {
  // languageDisplay:"standard" → "Chinese (Simplified)" / "Portuguese (Brazil)"
  // (the alternative "dialect" gives "Simplified Chinese" / "Brazilian
  // Portuguese"). Unknown options are ignored by older engines, so this is safe.
  displayNames = new Intl.DisplayNames(["en"], {
    type: "language",
    languageDisplay: "standard",
  });
} catch {
  displayNames = undefined;
}

/** e.g. "zh-Hans" → "Chinese (Simplified)", "pt-BR" → "Portuguese (Brazil)". */
export function langName(code: string): string {
  const hit = cache.get(code);
  if (hit !== undefined) return hit;

  const override = overrides[code.toLowerCase()];
  if (override !== undefined) {
    cache.set(code, override);
    return override;
  }

  let name = code;
  if (displayNames) {
    try {
      name = displayNames.of(code) ?? code;
    } catch {
      name = code;
    }
  }
  cache.set(code, name);
  return name;
}
