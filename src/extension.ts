import * as vscode from "vscode";
import { XcstringsEditorProvider } from "./editor/XcstringsEditorProvider";
import {
  LocalizationsTreeProvider,
  type LocalizationNode,
} from "./tree/LocalizationsTreeProvider";
import { catalogFindGlob, languageNameOverrides } from "./editor/config";
import { syncEditorAssociations } from "./editor/associations";
import { setLanguageNameOverrides } from "./shared/langName";
import { resolveLprojGroup, detectSourceLanguage } from "./editor/lproj";
import {
  promptAddCatalogLanguage,
  promptAddStringsLanguage,
  removeCatalogLanguage,
  removeStringsLanguage,
} from "./editor/manage";

export function activate(context: vscode.ExtensionContext) {
  const editorProvider = XcstringsEditorProvider.register(context);

  // Custom language tags ("en-Pseudo") get their names from the settings; apply
  // them before anything renders a language.
  setLanguageNameOverrides(languageNameOverrides());
  void syncEditorAssociations(context);

  // Sidebar → "open this language in the catalog grid", focused on a single
  // column (Key/source + that language). Stash the choice first so a freshly
  // opened editor applies it on ready; then open (or focus) the grid editor.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "xcodeI18n.openCatalogLanguage",
      async (uri: vscode.Uri, lang: string) => {
        editorProvider.selectCatalogLanguage(uri, lang);
        await vscode.commands.executeCommand(
          "vscode.openWith",
          uri,
          XcstringsEditorProvider.xcstringsViewType
        );
      }
    )
  );

  // Activity-bar "Localizations" view (native tree): lists .strings tables +
  // languages and .xcstrings catalogs with progress; clicking opens the file in
  // the grid editor.
  const tree = new LocalizationsTreeProvider();
  context.subscriptions.push(
    vscode.window.createTreeView("xcodeI18n.localizations", {
      treeDataProvider: tree,
    }),
    vscode.commands.registerCommand("xcodeI18n.refreshLocalizations", () =>
      tree.refresh()
    )
  );

  // ---- Add / remove a language, from the sidebar's context menu ----
  //
  // The two formats need different work: a catalog language is a set of entries
  // inside one JSON file, a `.strings` language is a whole `<lang>.lproj` file.
  // Both are reached from the row the user right-clicked, which VS Code hands to
  // the command as the tree node.

  /** Show the catalog afterwards: the edit is applied but unsaved, and the file
   * may not be open, so opening it is what makes the change visible + savable. */
  async function revealCatalog(uri: vscode.Uri, lang?: string): Promise<void> {
    if (lang) editorProvider.selectCatalogLanguage(uri, lang);
    await vscode.commands.executeCommand(
      "vscode.openWith",
      uri,
      XcstringsEditorProvider.xcstringsViewType
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "xcodeI18n.addLanguage",
      async (node?: LocalizationNode) => {
        if (!node) return;
        if (node.kind === "catalog" || node.kind === "catalogLanguage") {
          const uri = node.kind === "catalog" ? node.uri : node.catalogUri;
          const added = await promptAddCatalogLanguage(uri);
          if (added) await revealCatalog(uri, added);
        } else if (node.kind === "table") {
          await promptAddStringsLanguage(node.group, node.sourceLang);
        } else if (node.kind === "language") {
          // A language leaf: resolve its table so the new file lands beside it.
          const group = await resolveLprojGroup(node.uri);
          if (!group) return;
          await promptAddStringsLanguage(
            group,
            await detectSourceLanguage(group)
          );
        }
        tree.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "xcodeI18n.removeLanguage",
      async (node?: LocalizationNode) => {
        if (!node) return;
        if (node.kind === "catalogLanguage") {
          const removed = await removeCatalogLanguage(node.catalogUri, node.lang);
          if (removed) await revealCatalog(node.catalogUri);
        } else if (node.kind === "language") {
          await removeStringsLanguage(node.uri, node.lang);
        }
        tree.refresh();
      }
    )
  );

  // Keep the view in sync with the filesystem (saves, add/remove languages).
  // Debounced so a burst of changes triggers one refresh.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => tree.refresh(), 250);
  };

  // Which files to watch depends on the configured catalog patterns, so the
  // watchers are rebuilt whenever those change.
  let watchers: vscode.Disposable[] = [];
  const rebuildWatchers = () => {
    for (const w of watchers) w.dispose();
    watchers = [];
    for (const glob of ["**/*.lproj/*.strings", catalogFindGlob()]) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      watchers.push(watcher);
    }
  };
  rebuildWatchers();
  context.subscriptions.push({
    dispose: () => watchers.forEach((w) => w.dispose()),
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("xcodeI18n.languageNames")) {
        setLanguageNameOverrides(languageNameOverrides());
        tree.refresh();
      }
      if (e.affectsConfiguration("xcodeI18n.catalogFilePatterns")) {
        void syncEditorAssociations(context);
        rebuildWatchers();
        tree.refresh();
      }
    })
  );

  // Editor-title action: switch the active .xcstrings from the grid to the
  // built-in text editor (raw JSON). The editor/title menu passes the resource
  // URI; fall back to the active tab if it doesn't.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "xcodeI18n.openAsText",
      (uri?: vscode.Uri) => {
        const target = uri ?? activeResourceUri();
        if (target) {
          void vscode.commands.executeCommand(
            "vscode.openWith",
            target,
            "default"
          );
        }
      }
    )
  );
}

/** URI of the resource in the active editor tab (custom or text). */
function activeResourceUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputText) return input.uri;
  return undefined;
}

export function deactivate() {}
