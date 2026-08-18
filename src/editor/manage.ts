// Adding and removing strings and languages, driven either from the grid's
// toolbar or from the Localizations sidebar.
//
// Everything here works from a URI rather than an open editor, so the sidebar
// can manage a catalog that isn't open. Writes go through a WorkspaceEdit on the
// TextDocument (never the filesystem) so undo, dirty state and the custom editor
// all stay in sync; only `.strings` language files — which are whole files
// rather than text spans — are created and deleted directly, and deletions go to
// the trash so they can be recovered.

import * as vscode from "vscode";
import type { EditResult } from "../shared/edit";
import {
  addString,
  addLanguage,
  removeLanguage,
  removeStrings,
} from "../shared/edit";
import { addStringEntry, removeStringEntries } from "./editStrings";
import { parseCatalog } from "../shared/xcstrings";
import { parseStrings, escapeStringsValue } from "../shared/strings";
import {
  isValidLanguageTag,
  languageFilledCount,
  languageIsEmpty,
} from "../shared/manage";
import { langName } from "../shared/langName";
import type { LprojGroup } from "./lproj";

function eolOf(document: vscode.TextDocument): string {
  return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

/**
 * Apply a surgical {@link EditResult} to a document. Only the computed spans are
 * replaced ⇒ minimal git diff. Returns whether anything was written.
 */
export async function applyEditResult(
  document: vscode.TextDocument,
  { edits, reason }: EditResult,
  label: string
): Promise<boolean> {
  if (edits.length === 0) {
    if (reason) {
      console.warn(`[xcode-i18n] could not edit ${label}: ${reason}`);
      void vscode.window.showWarningMessage(`Couldn't update ${label}: ${reason}`);
    }
    return false;
  }
  const wsEdit = new vscode.WorkspaceEdit();
  for (const e of edits) {
    const start = document.positionAt(e.offset);
    const end = document.positionAt(e.offset + e.length);
    wsEdit.replace(document.uri, new vscode.Range(start, end), e.newText);
  }
  return vscode.workspace.applyEdit(wsEdit);
}

// ---- Strings ----

/** Keys already in the file, for the "already exists" check while typing. */
function existingKeys(text: string, isCatalog: boolean): Set<string> {
  const keys = isCatalog
    ? parseCatalog(text).entries.map((e) => e.key)
    : parseStrings(text).entries.map((e) => e.key);
  return new Set(keys);
}

/**
 * Prompt for a key and add it. Returns the key that was added, so the caller can
 * scroll to it. In a String Catalog the key IS the source-language string, which
 * is why the prompt asks for the English text rather than an identifier.
 */
export async function promptAddString(
  document: vscode.TextDocument,
  isCatalog: boolean
): Promise<string | undefined> {
  const taken = existingKeys(document.getText(), isCatalog);
  const key = await vscode.window.showInputBox({
    title: "Add String",
    prompt: isCatalog
      ? "The key doubles as the source-language string, the same way Xcode uses it."
      : "The key you reference from code.",
    placeHolder: isCatalog ? "e.g. Continue" : "e.g. onboarding.continue",
    ignoreFocusOut: false,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Enter a key.";
      if (taken.has(trimmed)) return "That key is already in this file.";
      return null;
    },
  });
  if (key === undefined) return undefined;

  const trimmed = key.trim();
  // Re-read: the document may have moved on while the input box was open.
  const text = document.getText();
  const ctx = { eol: eolOf(document) };
  const result = isCatalog
    ? addString(text, trimmed, ctx)
    : addStringEntry(text, trimmed, ctx);
  const ok = await applyEditResult(document, result, `"${trimmed}"`);
  return ok ? trimmed : undefined;
}

/**
 * Confirm and delete keys. `blocked` carries the reasons the caller already
 * knows about (the same rules that grey out the "−" button) so a key that
 * slipped through — say the catalog changed since the grid last rendered — is
 * refused here with the same explanation rather than silently deleted.
 */
export async function confirmRemoveStrings(
  document: vscode.TextDocument,
  keys: string[],
  isCatalog: boolean,
  blocked: Map<string, string>
): Promise<boolean> {
  if (keys.length === 0) return false;

  const stopper = keys.find((k) => blocked.has(k));
  if (stopper !== undefined) {
    void vscode.window.showWarningMessage(
      `Can't delete "${stopper}": ${blocked.get(stopper)}`
    );
    return false;
  }

  const what =
    keys.length === 1 ? `"${keys[0]}"` : `${keys.length} strings`;
  const confirmed = await vscode.window.showWarningMessage(
    `Delete ${what}?`,
    {
      modal: true,
      detail:
        keys.length === 1
          ? "The key and all of its translations are removed from this file. You can undo this."
          : `${keys.join("\n")}\n\nEach key and all of its translations are removed from this file. You can undo this.`,
    },
    "Delete"
  );
  if (confirmed !== "Delete") return false;

  const text = document.getText();
  const ctx = { eol: eolOf(document) };
  const result = isCatalog
    ? removeStrings(text, keys, ctx)
    : removeStringEntries(text, keys);
  return applyEditResult(document, result, what);
}

// ---- Languages in a String Catalog ----

/** Prompt for a tag and add the language to every key in the catalog. */
export async function promptAddCatalogLanguage(
  uri: vscode.Uri
): Promise<string | undefined> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showErrorMessage(`Couldn't open ${uri.fsPath}.`);
    return undefined;
  }

  const catalog = parseCatalog(document.getText());
  if (catalog.error) {
    void vscode.window.showWarningMessage(
      "This catalog isn't valid JSON, so a language can't be added to it."
    );
    return undefined;
  }
  const present = new Set(catalog.languages);

  const tag = await vscode.window.showInputBox({
    title: "Add Language",
    prompt:
      "Language tag, e.g. fr, pt-BR or zh-Hans-CN.",
    placeHolder: "e.g. de",
    ignoreFocusOut: false,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Enter a language tag.";
      if (!isValidLanguageTag(trimmed)) {
        return "That isn't a well-formed language tag.";
      }
      if (present.has(trimmed)) return `${trimmed} is already in this catalog.`;
      return null;
    },
  });
  if (tag === undefined) return undefined;

  const trimmed = tag.trim();
  const ok = await applyEditResult(
    document,
    addLanguage(document.getText(), trimmed, { eol: eolOf(document) }),
    `${langName(trimmed)} (${trimmed})`
  );
  return ok ? trimmed : undefined;
}

/**
 * Remove a language from every key in the catalog. Refused while anything is
 * translated in it — a column disappearing should never take work with it.
 */
export async function removeCatalogLanguage(
  uri: vscode.Uri,
  lang: string
): Promise<boolean> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showErrorMessage(`Couldn't open ${uri.fsPath}.`);
    return false;
  }

  const catalog = parseCatalog(document.getText());
  const label = `${langName(lang)} (${lang})`;

  if (lang === catalog.sourceLanguage) {
    void vscode.window.showWarningMessage(
      `${label} is this catalog's source language, so it can't be removed.`
    );
    return false;
  }
  if (!languageIsEmpty(catalog, lang)) {
    const filled = languageFilledCount(catalog, lang);
    void vscode.window.showWarningMessage(
      `${label} still has ${filled} translated ${
        filled === 1 ? "string" : "strings"
      }, so it can't be removed. Clear them first if you really want the language gone.`
    );
    return false;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Remove ${label} from this catalog?`,
    {
      modal: true,
      detail:
        "Nothing is translated in this language, so no work is lost. You can undo this.",
    },
    "Remove"
  );
  if (confirmed !== "Remove") return false;

  return applyEditResult(
    document,
    removeLanguage(document.getText(), lang, { eol: eolOf(document) }),
    label
  );
}

// ---- Languages in a legacy `.strings` table ----

/** Render a new `.strings` file seeded from the source language's keys. */
function seedStringsFile(sourceText: string, eol: string): string {
  const entries = parseStrings(sourceText).entries;
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.comment) {
      lines.push(`/* ${entry.comment.replace(/\*\//g, "* /")} */`);
    }
    lines.push(`${escapeStringsValue(entry.key)} = ${escapeStringsValue("")};`);
    lines.push("");
  }
  return lines.join(eol);
}

/**
 * Add a language to a `.strings` table by creating its `<lang>.lproj` file,
 * pre-seeded with the source language's keys and comments and empty values —
 * the shape Xcode's own export produces.
 */
export async function promptAddStringsLanguage(
  group: LprojGroup,
  sourceLang: string
): Promise<string | undefined> {
  const present = new Set(group.files.map((f) => f.lang));

  const tag = await vscode.window.showInputBox({
    title: "Add Language",
    prompt: `Creates <tag>.lproj/${group.basename}.strings next to the existing languages.`,
    placeHolder: "e.g. de",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Enter a language tag.";
      if (!isValidLanguageTag(trimmed)) {
        return "That isn't a well-formed language tag.";
      }
      if (present.has(trimmed)) return `${trimmed} already exists here.`;
      return null;
    },
  });
  if (tag === undefined) return undefined;
  const lang = tag.trim();

  const target = vscode.Uri.joinPath(
    group.groupDir,
    `${lang}.lproj`,
    `${group.basename}.strings`
  );

  let seed = "";
  const source = group.files.find((f) => f.lang === sourceLang);
  if (source) {
    try {
      const doc = await vscode.workspace.openTextDocument(source.uri);
      seed = seedStringsFile(doc.getText(), "\n");
    } catch {
      seed = "";
    }
  }

  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(seed, "utf8"));
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Couldn't create ${target.fsPath}: ${(e as Error).message}`
    );
    return undefined;
  }
  return lang;
}

/**
 * Delete a language's `.strings` file. Refused while anything is translated in
 * it. The file goes to the trash rather than being erased, and an emptied
 * `.lproj` directory goes with it.
 */
export async function removeStringsLanguage(
  uri: vscode.Uri,
  lang: string
): Promise<boolean> {
  const label = `${langName(lang)} (${lang})`;
  let text: string;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    text = doc.getText();
  } catch {
    void vscode.window.showErrorMessage(`Couldn't open ${uri.fsPath}.`);
    return false;
  }

  const filled = parseStrings(text).entries.filter(
    (e) => e.value.trim() !== ""
  ).length;
  if (filled > 0) {
    void vscode.window.showWarningMessage(
      `${label} still has ${filled} translated ${
        filled === 1 ? "string" : "strings"
      }, so it can't be removed. Clear them first if you really want the language gone.`
    );
    return false;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Remove ${label}?`,
    {
      modal: true,
      detail: `${vscode.workspace.asRelativePath(
        uri
      )} is moved to the trash. Nothing is translated in it, so no work is lost.`,
    },
    "Remove"
  );
  if (confirmed !== "Remove") return false;

  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Couldn't remove ${uri.fsPath}: ${(e as Error).message}`
    );
    return false;
  }

  // Drop the `.lproj` wrapper too once it holds nothing else.
  const lproj = vscode.Uri.joinPath(uri, "..");
  try {
    const rest = await vscode.workspace.fs.readDirectory(lproj);
    if (rest.length === 0) {
      await vscode.workspace.fs.delete(lproj, { useTrash: true });
    }
  } catch {
    // Leaving an empty .lproj behind is harmless.
  }
  return true;
}
