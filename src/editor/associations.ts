// Teaching VS Code to open custom catalog patterns in the grid.
//
// `contributes.customEditors` is fixed at install time, so a pattern the user
// adds later (say `*.strings.json`) can only be routed through the
// `workbench.editorAssociations` setting. We manage exactly the entries we
// wrote — tracked in globalState — so dropping a pattern from the setting takes
// its association with it, and an association the user wrote by hand is never
// touched.

import * as vscode from "vscode";
import { catalogPatterns, DEFAULT_CATALOG_PATTERNS } from "./config";

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
  // `*.xcstrings` is already claimed by package.json; only the extras need an
  // association.
  const extras = catalogPatterns().filter(
    (p) => !DEFAULT_CATALOG_PATTERNS.includes(p)
  );
  const desired = desiredAssociations(extras);
  const previous = context.globalState.get<string[]>(MANAGED_KEY) ?? [];

  const config = vscode.workspace.getConfiguration();
  const inspected = config.inspect<Record<string, string>>(
    "workbench.editorAssociations"
  );
  const scope = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  const existing =
    (scope === vscode.ConfigurationTarget.Workspace
      ? inspected?.workspaceValue
      : inspected?.globalValue) ?? {};

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
