// Policy for adding and removing strings and languages.
//
// Both sides need these answers: the webview to enable or grey out the "+" /
// "−" buttons and explain why, the host to refuse an edit that slipped through.
// Keeping the rules here means the tooltip and the guard can never disagree.

import type { Catalog, CatalogEntry } from "./xcstrings";

/** Whether a key can be deleted, and — when it can't — why not. */
export interface Removability {
  canRemove: boolean;
  /** One-line explanation for the disabled control. Empty when removable. */
  reason: string;
}

export interface RemovabilityContext {
  /** Code-reference counts from the last usage scan; null = never scanned. */
  usage: Record<string, number> | null;
  /** Whether the format tracks extraction state (true for `.xcstrings`). */
  tracksExtractionState: boolean;
  /** Escape hatch: let automatically managed keys be deleted anyway. */
  allowManaged: boolean;
}

/** True when the key has a non-empty value in any language. */
function hasTranslations(entry: CatalogEntry): boolean {
  for (const row of entry.rows) {
    for (const cell of Object.values(row.cells)) {
      if (cell && cell.value.trim() !== "") return true;
    }
  }
  return false;
}

/**
 * Can this key be removed from the catalog?
 *
 * A String Catalog is mostly a projection of your source code, so most keys are
 * not the editor's to delete — Xcode re-extracts them on the next build. Three
 * things hold a key in place:
 *   • it is still referenced in your source code (per the last usage scan),
 *   • it is automatically managed — extracted from code rather than added by
 *     hand, so deleting it here only postpones it,
 *   • it is marked stale but still carries translations, which is exactly the
 *     case Xcode keeps out of automatic clean-up so the work isn't lost.
 * Anything hand-added (`extractionState: "manual"`) is always yours to delete.
 */
export function keyRemovability(
  entry: CatalogEntry,
  ctx: RemovabilityContext
): Removability {
  const refs = ctx.usage ? ctx.usage[entry.key] : undefined;
  if (refs !== undefined && refs > 0) {
    return {
      canRemove: false,
      reason: `Still referenced in your source code (${refs} ${
        refs === 1 ? "match" : "matches"
      } in the last scan). Remove the code reference first.`,
    };
  }

  if (!ctx.tracksExtractionState) return { canRemove: true, reason: "" };

  const state = entry.extractionState ?? "";
  if (state === "manual") return { canRemove: true, reason: "" };

  if (state === "stale") {
    if (hasTranslations(entry)) {
      return {
        canRemove: false,
        reason:
          "Marked stale but still has translations, which keeps it out of automatic clean-up. Clear its translations first.",
      };
    }
    return { canRemove: true, reason: "" };
  }

  if (ctx.allowManaged) return { canRemove: true, reason: "" };
  return {
    canRemove: false,
    reason: `Automatically managed${
      state ? ` (extraction state: ${state})` : ""
    } — it is extracted from your source code and would come back on the next build.`,
  };
}

/**
 * True when nothing is translated in `lang` — the precondition for removing a
 * language, so no translation work is ever thrown away by a column disappearing.
 */
export function languageIsEmpty(catalog: Catalog, lang: string): boolean {
  for (const entry of catalog.entries) {
    for (const row of entry.rows) {
      const cell = row.cells[lang];
      if (cell && cell.value.trim() !== "") return false;
    }
  }
  return true;
}

/** How many cells `lang` has a non-empty value for (for the refusal message). */
export function languageFilledCount(catalog: Catalog, lang: string): number {
  let n = 0;
  for (const entry of catalog.entries) {
    for (const row of entry.rows) {
      const cell = row.cells[lang];
      if (cell && cell.value.trim() !== "") n++;
    }
  }
  return n;
}

/**
 * Accept a language tag. Deliberately looser than a BCP 47 registry check so
 * project-specific tags like `en-Pseudo` or `en-US-POSIX` go through — Xcode
 * itself is happy with any well-formed subtag sequence.
 */
export function isValidLanguageTag(tag: string): boolean {
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(tag);
}
