// Teaching VS Code to open catalog patterns in the grid, by default.
//
// `contributes.customEditors` declares the grid as the default editor, but that
// only settles ties at install time: a pattern the user adds later (say
// `*.strings.json`) isn't in the manifest at all, and "Reopen with…" records a
// per-pattern override that outranks the manifest for good. Writing the
// association explicitly covers both — it is the same setting VS Code itself
// writes when you pick a default editor from "Reopen with…".
//
// Scope is global: which editor opens a file type is a preference about how you
// work, not about one project. We manage exactly the entries we wrote — tracked
// in globalState — so dropping a pattern from the setting takes its association
// with it, and an association written by hand is never touched.

import * as vscode from "vscode";
import { catalogPatterns } from "./config";

const MANAGED_KEY = "xcodeI18n.managedAssociations";
const GRID_VIEW_TYPE = "xcodeI18n.xcstringsEditor";

/**
 * The associations a set of extra patterns needs: the pattern itself opens in
 * the grid, and its `git:` / `gitlens:` counterparts stay on the plain text
 * editor so diffs and blame views remain readable (the same pairing
 * package.json ships for `*.xcstrings`).
 */
function desiredAssociations(patterns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pattern of patterns) {
    out[pattern] = GRID_VIEW_TYPE;
    out[`git:/**/${pattern}`] = "default";
    out[`gitlens:/**/${pattern}`] = "default";
  }
  return out;
}

/**
 * Reconcile `workbench.editorAssociations` with `xcodeI18n.catalogFilePatterns`.
 * Safe to call repeatedly — it only writes when something actually differs.
 */
export async function syncEditorAssociations(
  context: vscode.ExtensionContext
): Promise<void> {
  const desired = desiredAssociations(catalogPatterns());
  const previous = context.globalState.get<string[]>(MANAGED_KEY) ?? [];

  const config = vscode.workspace.getConfiguration();
  const inspected = config.inspect<Record<string, string>>(
    "workbench.editorAssociations"
  );
  const scope = vscode.ConfigurationTarget.Global;
  const existing = inspected?.globalValue ?? {};

  const next = { ...existing };
  let changed = false;

  // Retire entries we added for patterns that are no longer configured.
  for (const key of previous) {
    if (!(key in desired) && key in next) {
      delete next[key];
      changed = true;
    }
  }
  for (const [key, value] of Object.entries(desired)) {
    if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  }

  if (changed) {
    try {
      await config.update("workbench.editorAssociations", next, scope);
    } catch (e) {
      void vscode.window.showWarningMessage(
        `Xcode Localization couldn't register your catalog file patterns: ${
          (e as Error).message
        }`
      );
      return;
    }
  }
  await context.globalState.update(MANAGED_KEY, Object.keys(desired));
}
