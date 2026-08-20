// Reading the `xcodeI18n.*` configuration.
//
// Everything the extension scans for — which files are String Catalogs, which
// files count as "source code" when looking for a key — is configurable, so it
// is read through here rather than from hard-coded globs. Defaults reproduce the
// original Xcode-only behaviour.

import * as vscode from "vscode";
import { DEFAULT_TRANSLATION_FUNCTIONS } from "../shared/extract";

/** File name patterns treated as String Catalogs. */
export const DEFAULT_CATALOG_PATTERNS = ["*.xcstrings", "*.strings.json"];
/** File name patterns searched when looking for a key in code. */
export const DEFAULT_SOURCE_PATTERNS = ["*.swift", "*.m", "*.mm", "*.ts"];

/**
 * Files and folders never scanned.
 *
 * Two different reasons live here. `node_modules` and `.git` are listed so a
 * big tree isn't walked just to throw the results away — both are gitignored in
 * every project anyway, and gitignore is what does the real work (see
 * `projectFiles.ts`).
 *
 * Tests are the other reason, and they are NOT gitignored, so they have to be
 * named. A string in a test is an assertion about the app, not part of it:
 * extracting from one invents catalog entries nobody ships, and counting one as
 * a reference keeps a dead key alive for ever — the test would keep passing
 * long after the feature was deleted.
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/__mocks__/**",
];

/** The configured excludes as one glob for `findFiles`. */
export function excludeGlob(): string {
  const patterns = patternList("excludePatterns", DEFAULT_EXCLUDE_PATTERNS);
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

function config() {
  return vscode.workspace.getConfiguration("xcodeI18n");
}

/** Non-empty trimmed strings from a config array, or the fallback. */
function patternList(key: string, fallback: string[]): string[] {
  const raw = config().get<unknown>(key);
  if (!Array.isArray(raw)) return fallback;
  const out = raw
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return out.length > 0 ? out : fallback;
}

export function catalogPatterns(): string[] {
  return patternList("catalogFilePatterns", DEFAULT_CATALOG_PATTERNS);
}

export function sourcePatterns(): string[] {
  return patternList("sourceFilePatterns", DEFAULT_SOURCE_PATTERNS);
}

/**
 * A `findFiles` glob covering every pattern. A bare name pattern like
 * `*.swift` is anchored at any depth; a pattern that already carries path
 * structure (`src/**​/*.ts`) is used as written.
 */
function toFindGlob(patterns: string[]): string {
  const parts = patterns.map((p) =>
    p.includes("/") ? p : `**/${p}`
  );
  return parts.length === 1 ? parts[0] : `{${parts.join(",")}}`;
}

export function catalogFindGlob(): string {
  return toFindGlob(catalogPatterns());
}

export function sourceFindGlob(): string {
  return toFindGlob(sourcePatterns());
}

/** The comma-separated form `workbench.action.findInFiles` expects. */
export function sourceIncludeList(): string {
  return sourcePatterns().join(", ");
}

/**
 * Compile a glob-ish pattern to an anchored regex. Supports `*` (any run of
 * non-separator characters), `?` (one) and `**​/` (any number of leading path
 * segments) — enough for the file patterns this extension takes.
 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${body}$`, "i");
}

function baseName(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf("/");
  return slash === -1 ? uri.path : uri.path.slice(slash + 1);
}

/**
 * Whether this file should open as a String Catalog (JSON) rather than as a
 * legacy `.strings` table. A plain pattern (`*.xcstrings`) is matched against
 * the file name; one carrying path structure against the workspace-relative
 * path, so a project can scope catalogs to a folder.
 */
export function isCatalogFile(uri: vscode.Uri): boolean {
  const name = baseName(uri);
  const relative = vscode.workspace.asRelativePath(uri, false);
  return catalogPatterns().some((pattern) =>
    patternToRegExp(pattern).test(pattern.includes("/") ? relative : name)
  );
}

/** Function names treated as localization calls when extracting keys. */
export function translationFunctions(): string[] {
  return patternList("translationFunctions", DEFAULT_TRANSLATION_FUNCTIONS);
}

/**
 * Where to look for strings to extract, relative to the catalog file's own
 * folder. The default of ".." is deliberately tight: a catalog at
 * `client/lang/messages.xcstrings` describes `client/`, not the whole monorepo,
 * so extraction stays scoped to the module that owns it.
 */
export function extractionRoot(catalog: vscode.Uri): vscode.Uri {
  const configured =
    vscode.workspace.getConfiguration("xcodeI18n").get<string>("extractionRoot") ??
    "..";
  const folder = vscode.Uri.joinPath(catalog, "..");
  return vscode.Uri.joinPath(folder, configured.trim() || "..");
}

/** Whether changing a source string flags its translations for review. */
export function autoMarkNeedsReview(): boolean {
  return (
    vscode.workspace
      .getConfiguration("xcodeI18n")
      .get<boolean>("autoMarkNeedsReview") ?? true
  );
}

/** Whether a sweep marks previously extracted keys it no longer finds as stale. */
export function markMissingKeysStale(): boolean {
  return (
    vscode.workspace
      .getConfiguration("xcodeI18n")
      .get<boolean>("markMissingKeysStale") ?? true
  );
}

/** Display-name overrides for language tags `Intl` doesn't recognise. */
export function languageNameOverrides(): Record<string, string> {
  const raw = config().get<unknown>("languageNames");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [tag, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name === "string" && name.trim() !== "") out[tag] = name;
  }
  return out;
}

/** Every `xcodeI18n.*` key a change to which the open editors must react to. */
export const WATCHED_SETTINGS = [
  "xcodeI18n.displayMode",
  "xcodeI18n.mergeKeySource",
  "xcodeI18n.doubleClickToEdit",
  "xcodeI18n.showCommentColumn",
  "xcodeI18n.showStateColumn",
  "xcodeI18n.allowRemovingManagedStrings",
  "xcodeI18n.validateIcuMessages",
  "xcodeI18n.translationFunctions",
  "xcodeI18n.excludePatterns",
  "xcodeI18n.autoMarkNeedsReview",
  "xcodeI18n.languageNames",
];
