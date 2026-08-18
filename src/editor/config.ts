// Reading the `xcodeI18n.*` configuration.
//
// Everything the extension scans for — which files are String Catalogs, which
// files count as "source code" when looking for a key — is configurable, so it
// is read through here rather than from hard-coded globs. Defaults reproduce the
// original Xcode-only behaviour.

import * as vscode from "vscode";

/** File name patterns treated as String Catalogs. */
export const DEFAULT_CATALOG_PATTERNS = ["*.xcstrings"];
/** File name patterns searched when looking for a key in code. */
export const DEFAULT_SOURCE_PATTERNS = ["*.swift", "*.m", "*.mm"];

/** Vendor dirs never scanned — framework / Pods code would skew every count. */
export const EXCLUDE_GLOB =
  "{**/Pods/**,**/*.xcframework/**,**/Carthage/**,**/build/**,**/DerivedData/**,**/node_modules/**,**/.build/**}";

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
  "xcodeI18n.languageNames",
];
