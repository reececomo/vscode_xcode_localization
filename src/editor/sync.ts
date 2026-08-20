// "Sync with code": one sweep that reconciles a catalog with its source.
//
// It does three things in one pass over the project's source files, because
// they all need the same expensive read:
//   • extract  — keys found at a call site but missing from the catalog are
//                added, marked `extracted`, with a comment saying where from,
//   • stale    — keys the catalog says were extracted, but that no call site
//                references any more, are marked `stale`. Nothing is deleted:
//                a stale entry keeps its translations until someone decides,
//   • usage    — every key's reference count, which drives the Unused filter.
//
// Scope is deliberately narrow. The scan root defaults to one level above the
// catalog, so `client/lang/messages.xcstrings` sweeps `client/` — the module
// that owns the catalog — rather than the whole workspace.

import * as vscode from "vscode";
import type { Catalog, CatalogEntry, CatalogRow } from "../shared/xcstrings";
import { parseCatalog } from "../shared/xcstrings";
import type { NewString, TextReplace } from "../shared/edit";
import {
  addStrings,
  markNeedsReview,
  setComment,
  setExtractionState,
} from "../shared/edit";
import {
  findCallSites,
  extractionComments,
  isReplaceableComment,
  type KeyLocation,
} from "../shared/extract";
import { countKeyLiterals, maskComments } from "../shared/sourceScan";
import { getHeadText } from "./git";
import {
  autoMarkNeedsReview,
  extractionRoot,
  markMissingKeysStale,
  sourcePatterns,
  translationFunctions,
} from "./config";
import { findProjectFiles } from "./projectFiles";
import { applyEditResult } from "./manage";

/** States that mean "this key came from a code sweep", so a sweep may re-file it. */
const EXTRACTED_STATES = ["extracted", "extracted_with_value"];

export interface SyncResult {
  /** Source files read. */
  filesScanned: number;
  /** Reference count per catalog key, for the Unused filter. */
  counts: Record<string, number>;
  /** Keys to add, with the extraction metadata already resolved. */
  added: NewString[];
  /** Existing keys whose location comment is out of date. */
  recommented: { key: string; comment: string }[];
  /** Keys newly marked stale. */
  staled: string[];
  /** Cells to flag for review because their source moved since the last commit. */
  needsReview: ReviewTarget[];
  /** How many translations that flagging would touch. */
  reviewCells: number;
  /** Where the sweep looked. */
  root: vscode.Uri;
}

/** One cell (a key plus a variant path) whose source has moved. */
export interface ReviewTarget {
  key: string;
  segments: string[];
}

/** The source string for a row: the explicit source value, else the key. */
function sourceOf(catalog: Catalog, entry: CatalogEntry, row: CatalogRow): string {
  return row.cells[catalog.sourceLanguage]?.value ?? entry.key;
}

/**
 * Rows whose source has changed since the last commit — either the source text
 * itself was reworded, or the key's variant structure moved (a plural or device
 * variation added, removed, or renamed). Both mean the existing translations
 * were written against something that no longer exists.
 *
 * The comparison is against git HEAD rather than against the previous keystroke,
 * because that is what catches the changes this editor never saw: a reword
 * committed by a teammate, a "Vary by Plural" added in Xcode, a merge.
 */
function findSourceChanges(current: Catalog, baseline: Catalog): ReviewTarget[] {
  const before = new Map(baseline.entries.map((e) => [e.key, e]));
  const out: ReviewTarget[] = [];

  for (const entry of current.entries) {
    const was = before.get(entry.key);
    // A key that didn't exist at HEAD has nothing to have drifted from; its
    // translations are new, not stale.
    if (!was) continue;

    const wasRows = new Map(was.rows.map((r) => [r.variantKey, r]));
    const variantsChanged =
      was.rows.length !== entry.rows.length ||
      entry.rows.some((r) => !wasRows.has(r.variantKey));

    for (const row of entry.rows) {
      const oldRow = wasRows.get(row.variantKey);
      const now = sourceOf(current, entry, row);
      const then = oldRow ? sourceOf(baseline, was, oldRow) : undefined;
      if (variantsChanged || then === undefined || then !== now) {
        out.push({ key: entry.key, segments: row.segments });
      }
    }
  }
  return out;
}

/** Translations a review flag would actually land on (settled, non-empty ones). */
function countReviewable(catalog: Catalog, targets: ReviewTarget[]): number {
  const rowsByKey = new Map(
    catalog.entries.map((e) => [e.key, e.rows] as const)
  );
  let n = 0;
  for (const target of targets) {
    const rows = rowsByKey.get(target.key);
    const row = rows?.find(
      (r) => r.segments.join("/") === target.segments.join("/")
    );
    if (!row) continue;
    for (const lang of catalog.languages) {
      if (lang === catalog.sourceLanguage) continue;
      const cell = row.cells[lang];
      if (!cell || cell.value.trim() === "") continue;
      if ((cell.state ?? "translated") !== "translated") continue;
      n++;
    }
  }
  return n;
}

/** Read every source file under the catalog's root once. */
async function readSources(
  root: vscode.Uri
): Promise<{ uri: vscode.Uri; text: string }[]> {
  const pattern = new vscode.RelativePattern(root, sourceGlobFor());
  const uris = await findProjectFiles(pattern);
  const out: { uri: vscode.Uri; text: string }[] = [];
  for (const uri of uris) {
    try {
      out.push({
        uri,
        text: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"),
      });
    } catch {
      // Unreadable file — skip it rather than fail the whole sweep.
    }
  }
  return out;
}

/** The source glob, as a pattern relative to a root rather than the workspace. */
function sourceGlobFor(): string {
  const patterns = sourcePatterns().map((p) => (p.includes("/") ? p : `**/${p}`));
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

/**
 * Sweep the sources for `catalogUri` and report what changed — without writing.
 * The caller confirms, then calls {@link applySync}.
 */
export async function scanForSync(
  catalogUri: vscode.Uri,
  catalog: Catalog
): Promise<SyncResult> {
  // Source drift is measured against the last commit. No repo, or an untracked
  // file, simply means there is no "before" to compare with.
  let needsReview: ReviewTarget[] = [];
  if (autoMarkNeedsReview()) {
    const head = await getHeadText(catalogUri);
    if (head !== null) {
      const baseline = parseCatalog(head);
      if (!baseline.error) needsReview = findSourceChanges(catalog, baseline);
    }
  }
  const reviewCells = countReviewable(catalog, needsReview);

  const root = extractionRoot(catalogUri);
  const sources = await readSources(root);
  const fnNames = translationFunctions();

  const known = new Set(catalog.entries.map((e) => e.key));

  // References from CODE only. A mention inside a comment is not a reference:
  // the string is not in the app, so it neither keeps a key from going stale nor
  // counts towards the Unused filter. Both signals read the same number, so the
  // STALE chip and the "unused" badge can never contradict each other.
  const counts: Record<string, number> = {};
  for (const key of known) counts[key] = 0;

  // EVERY place a key is used, not just the first: a string that appears on
  // three screens gets all three in its comment. File order is sorted, so the
  // comment is stable across runs and a re-scan produces no diff.
  const locations = new Map<string, KeyLocation[]>();
  const ordered = [...sources].sort((a, b) =>
    a.uri.path < b.uri.path ? -1 : a.uri.path > b.uri.path ? 1 : 0
  );

  for (const { uri, text } of ordered) {
    const code = maskComments(text, uri.path);
    for (const site of findCallSites(code, uri.path, fnNames)) {
      const where: KeyLocation = {
        file: vscode.workspace.asRelativePath(uri, false),
        enclosing: site.enclosing,
      };
      const list = locations.get(site.key);
      if (list) list.push(where);
      else locations.set(site.key, [where]);
    }
    countKeyLiterals(text, known, counts, uri.path);
  }

  const added: NewString[] = [];
  for (const [key, where] of locations) {
    if (known.has(key)) continue;
    added.push({
      key,
      comment: extractionComments(where),
      extractionState: "extracted",
    });
  }

  // Keys already in the catalog get their location comment refreshed — code
  // moves, and a comment pointing at a file that no longer holds the string is
  // worse than none. Only a comment this tool wrote (leading `#`) or an empty
  // one is touched; a note written for translators is never overwritten.
  const recommented: { key: string; comment: string }[] = [];
  for (const entry of catalog.entries) {
    const where = locations.get(entry.key);
    if (!where || !isReplaceableComment(entry.comment)) continue;
    const comment = extractionComments(where);
    if (comment !== (entry.comment ?? "")) {
      recommented.push({ key: entry.key, comment });
    }
  }

  const staled: string[] = [];
  if (markMissingKeysStale()) {
    for (const entry of catalog.entries) {
      const state = entry.extractionState ?? "";
      // Only re-file what a sweep put there. Hand-added and migrated keys are
      // not ours to reclassify, and a key already stale stays as it is.
      if (!EXTRACTED_STATES.includes(state)) continue;
      if (locations.has(entry.key)) continue;
      // Referenced by real code in some way the call-site parser cannot see
      // (a constant, a wrapper we do not know about) — leave it alone.
      if ((counts[entry.key] ?? 0) > 0) continue;
      staled.push(entry.key);
    }
  }

  return {
    filesScanned: sources.length,
    counts,
    added,
    recommented,
    staled,
    needsReview,
    reviewCells,
    root,
  };
}

/**
 * Write a swept result: add the new keys, then re-file the stale ones. Both
 * land in a single undo step from the user's point of view (one command), and
 * the document stays dirty so nothing reaches disk without a save.
 */
export async function applySync(
  document: vscode.TextDocument,
  result: Pick<
    SyncResult,
    "added" | "recommented" | "staled" | "needsReview"
  >
): Promise<void> {
  const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";

  // Pass 1: every in-place change at once. Each edits a different key's object,
  // so the spans can't overlap and one WorkspaceEdit covers them all — which
  // also makes the whole sweep a single undo.
  const text = document.getText();
  const edits: TextReplace[] = [];
  for (const { key, comment } of result.recommented) {
    edits.push(...setComment(text, key, comment, { eol }).edits);
  }
  for (const key of result.staled) {
    edits.push(...setExtractionState(text, key, "stale", { eol }).edits);
  }
  const sourceLanguage = parseCatalog(text).sourceLanguage;
  for (const { key, segments } of result.needsReview) {
    edits.push(...markNeedsReview(text, key, sourceLanguage, segments, { eol }));
  }
  if (edits.length > 0) {
    await applyEditResult(document, { edits }, "catalog metadata");
  }

  // Pass 2: the new keys, computed against the now-updated text so the append
  // point is right.
  if (result.added.length > 0) {
    await applyEditResult(
      document,
      addStrings(document.getText(), result.added, { eol }),
      `${result.added.length} extracted ${
        result.added.length === 1 ? "string" : "strings"
      }`
    );
  }
}

/** Parse the catalog a document currently holds. */
export function catalogOf(document: vscode.TextDocument): Catalog {
  return parseCatalog(document.getText());
}

/** Human summary of what a sweep found, for the confirmation dialog. */
export function describeSync(result: SyncResult): string {
  const lines: string[] = [];
  lines.push(
    `Scanned ${result.filesScanned} source ${
      result.filesScanned === 1 ? "file" : "files"
    } under ${vscode.workspace.asRelativePath(result.root, false) || "."}.`
  );
  if (result.added.length > 0) {
    lines.push(
      "",
      `Add ${result.added.length} new ${
        result.added.length === 1 ? "string" : "strings"
      }:`,
      result.added.slice(0, 12).map((s) => `  • ${s.key}`).join("\n") +
        (result.added.length > 12
          ? `\n  … and ${result.added.length - 12} more`
          : "")
    );
  }
  if (result.recommented.length > 0) {
    lines.push(
      "",
      `Refresh the source comment on ${result.recommented.length} existing ${
        result.recommented.length === 1 ? "string" : "strings"
      }.`
    );
  }
  if (result.reviewCells > 0) {
    const keys = new Set(result.needsReview.map((t) => t.key));
    lines.push(
      "",
      `Flag ${result.reviewCells} ${
        result.reviewCells === 1 ? "translation" : "translations"
      } as needing review, across ${keys.size} ${
        keys.size === 1 ? "string" : "strings"
      } whose source text or variations changed since your last commit.`
    );
  }
  if (result.staled.length > 0) {
    lines.push(
      "",
      `Mark ${result.staled.length} previously extracted ${
        result.staled.length === 1 ? "string" : "strings"
      } stale (nothing is deleted):`,
      result.staled.slice(0, 8).map((k) => `  • ${k}`).join("\n") +
        (result.staled.length > 8
          ? `\n  … and ${result.staled.length - 8} more`
          : "")
    );
  }
  if (
    result.added.length === 0 &&
    result.staled.length === 0 &&
    result.recommented.length === 0 &&
    result.reviewCells === 0
  ) {
    lines.push("", "The catalog already matches your code — nothing to change.");
  }
  return lines.join("\n");
}
