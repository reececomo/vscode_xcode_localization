# Xcode Localization

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A fast, native-feeling visual editor for **Xcode String Catalogs** - localize your iOS, iPadOS, and macOS apps directly in VS Code, without opening Xcode.

Xcode Localization turns `.xcstrings` (and legacy `.strings`) files into a familiar spreadsheet-style grid: keys down the rows, languages across the columns, and your source language pinned for reference. Every edit is written back surgically, so your `git diff` stays as clean as if Xcode itself had saved the file.

![The Xcode Localization grid editor: keys as rows, a pinned source column, and translated target languages with per-language progress bars.](assets/screenshots/grid-overview.png)

## Quick start

1. Open any `.xcstrings` file in your workspace. It opens in the grid editor automatically.
2. Click a target-language cell, type a translation, and press **Enter**.
3. Save with **Ctrl/Cmd+S** - the file is rewritten byte-for-byte except for the value you changed.

> **Note:** Prefer to hand-edit the raw JSON? Use **Open as Text** from the editor toolbar to switch any catalog back to the plain-text editor at any time.

![A git diff after translating one value: only the changed string and its state are rewritten, with everything else byte-for-byte intact.](assets/screenshots/clean-diff.png)

## Features

- **Spreadsheet-style grid** - Keys (including plural and device variants) as rows, languages as columns. The header and source/key columns stay frozen as you scroll.
- **Inline editing** - Click a cell to edit, **Enter** to commit, **Esc** to cancel. Move through translations with **Tab**, **Shift+Tab**, and the arrow keys, just like a spreadsheet.
- **Clean, Xcode-compatible diffs** - Edits are applied surgically: only the changed value or state span is rewritten, preserving key order, indentation, and line endings. No more noisy reformatting in code review.
- **Translation progress** - A per-language progress bar (percent translated, excluding keys marked *Don't translate*) in the toolbar, the language picker, and the sidebar.
- **State tracking** - Cells carry their state - *translated*, *new*, *needs review*, or *stale* - as a colored badge, and you can flag a translation as **Reviewed** or **Needs review** from a per-cell menu.
- **Format specifier validation** - When a translation's `%@`, `%lld`, or `%1$@` placeholders drift from the source, the cell is flagged with a non-blocking warning. Reordering positional specifiers never raises a false positive.
- **Changed-since-commit markers** - The editor reads your git `HEAD` and highlights every value or state that has changed since your last commit, with a *"Changed since last commit · was: …"* tooltip. A **Changed** filter scopes the grid to just those edits.
- **Search and filter** - A search box matches across keys, developer notes, and translations in any visible language, with hits highlighted. Filter rows by **All**, **Untranslated**, **Needs review**, **Warnings**, **Orphaned** (legacy `.strings` only: keys present in the target file but missing from the source language), **Unused** (after running a code scan - see *Find unused keys*), or **Changed** - search and filter compose.
- **Hybrid columns** - By default the grid shows your source plus one target language. A language picker lets you toggle additional columns on and off, complete with each language's progress; your selection is remembered per file.
- **Translator notes** - Add, edit, or remove a developer note for any key from the key's context menu (hover a row and click the **⋯** button at the end of the key, or click an existing note to edit it inline), and mark a key as *Don't translate* to exclude it from progress and filters.
  - **Legacy `.strings`:** a key's note lives in the *source-language* file, so notes are editable only when you open that file - e.g. `en.lproj/Localizable.strings`. While viewing a target language the source note is shown **read-only** (open the source file to change it).
- **Find in code** - From any key's context menu, **Find in code** opens VS Code's search scoped to your source files (Swift / Objective-C by default, see `xcodeI18n.sourceFilePatterns`) and pre-filled with the key as a quoted string literal - jumping straight to the `Text("…")`, `Button("…")`, or `NSLocalizedString("…", …)` call sites so you can refactor the wording where it's used.
- **Find unused keys** - The **Scan code** button in the toolbar runs a one-shot pass over your source files and flags every key with no quoted-literal reference as *unused*, with an **Unused** filter to list them. It's a hint, not a verdict - keys built by string interpolation or referenced from storyboards/XIBs aren't detected, so verify before deleting. Nothing is indexed in the background and nothing is deleted automatically; re-run the scan whenever you want fresh results.
- **Add and remove strings** - The **+** and **−** buttons at the top left of the grid add a key or delete the selected one. **−** stays greyed out, with the reason in its tooltip, whenever a key isn't yours to delete: it is still referenced in your source code, Xcode manages it automatically (it would be re-extracted on the next build), or it is marked stale but still carries translations. Hand-added keys (`extractionState: "manual"`) can always be deleted, and a delete always re-scans your code first. Set `xcodeI18n.allowRemovingManagedStrings` if you want the automatically-managed rule lifted.
- **Add and remove languages** - Add a language from the language picker, the toolbar's **⋯** menu, or the Localizations sidebar's context menu. The catalog gets an empty `new` entry for every key, exactly as Xcode writes it. Removing a language is only offered once nothing is translated in it, so a disappearing column can never take work with it. For legacy `.strings`, adding a language creates the `<lang>.lproj` file seeded from the source language; removing one moves it to the trash.
- **Comment and State columns** - Xcode's two metadata columns, on by default. **Comment** shows each key's developer note in its own column, rendered a step fainter than the translations, and stays editable in place. **State** shows a green checkmark when a string is translated, an orange **NEW** square when it isn't, and a labelled chip for *needs review* and *stale*; it reports on the first target language shown. Toggle either from the **⋯** menu.
- **Resizable columns** - Drag a column divider to resize, double-click it to reset. Widths are persisted per file.
- **Built for large catalogs** - Rows are virtualized with measured heights, so catalogs with thousands of entries scroll smoothly while the frozen header and columns stay put.
- **Theme-aware** - The grid follows your active VS Code color theme and contrast settings.

![Editing a target cell inline, with a state badge, a format-specifier warning, and a changed-since-commit marker.](assets/screenshots/editing-cell.png)

![The language picker popover, showing each target language with a checkbox and its translation progress.](assets/screenshots/language-picker.png)

## Keyboard shortcuts

The grid is designed to be driven entirely from the keyboard.

| Action | Shortcut |
| --- | --- |
| Move between cells | **↑ ↓ ← →** |
| Edit the active cell | **Enter**, **F2**, or **Space** |
| Start editing with a character | Just start typing |
| Commit and move down | **Enter** |
| Commit and move to the next / previous language | **Tab** / **Shift+Tab** |
| Cancel an edit | **Esc** |
| Clear the search box | **Esc** (while focused) |
| Save | **Ctrl/Cmd+S** |
| Undo / Redo | **Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** |

## The Localizations view

![The Localizations panel in the Activity Bar, listing catalogs and `.strings` tables with their languages and translation progress.](assets/screenshots/localizations-view.png)

An **Xcode Localization** panel in the Activity Bar gives you a workspace-wide overview of your localization files:

- `.xcstrings` catalogs, each showing its language count and overall translation percentage (with a checkmark when fully translated).
- `.strings` tables grouped by `<lang>.lproj`, expandable to list every language with its name, code, and progress.

Select any entry to open it in the grid editor. Right-click a catalog, a table, or any language for **Add Language…**, and a target language for **Remove Language…** — the same rules apply as in the grid, so a language with translations in it can't be removed. Vendor directories such as `Pods/`, `Carthage/`, `DerivedData/`, `build/`, and `node_modules/` are skipped. Use the **Refresh** button in the view's title bar if you reorganize files outside VS Code.

## Commands

| Command | Description |
| --- | --- |
| **Xcode Localization: Open as Text** | Reopen the active catalog in VS Code's plain-text JSON editor. |
| **Xcode Localization: Refresh** | Rescan the workspace and refresh the Localizations view. |
| **Xcode Localization: Add Language…** | Add a language to the catalog or `.strings` table selected in the Localizations view. |
| **Xcode Localization: Remove Language…** | Remove the selected target language, once nothing is translated in it. |

## Settings and customization

All settings live under the `xcodeI18n.*` namespace and can be changed from **Settings** or directly from the grid toolbar.

- **`xcodeI18n.displayMode`** - Row density for the grid.
  - Default: `comfortable`
  - Available values: `comfortable` (roomier rows with more padding), `compact` (tighter rows so more fit on screen)

- **`xcodeI18n.mergeKeySource`** - Merge the **Key** and source columns into one. The key appears as a secondary line only when it differs from the source value; uncheck to show Key and source as separate columns.
  - Default: `true`

- **`xcodeI18n.doubleClickToEdit`** - Require a double-click to open a cell for editing, so a single click only selects it. Uncheck to open the editor with a single click.
  - Default: `true`
  - **Note:** Keyboard activation (**Enter**, **F2**, or type-to-edit) always opens the editor regardless of this setting.

- **`xcodeI18n.showCommentColumn`** - Show the developer note as its own column, the way Xcode does. When off, the note appears under the key instead.
  - Default: `true`

- **`xcodeI18n.showStateColumn`** - Show the State column (green checkmark / orange **NEW** square / state label). It reports on the first target language shown.
  - Default: `true`

- **`xcodeI18n.allowRemovingManagedStrings`** - Let the **−** button delete keys Xcode manages automatically. Off by default, because such a key is extracted from your source and returns on the next build.
  - Default: `false`

- **`xcodeI18n.catalogFilePatterns`** - File name patterns opened as String Catalogs.
  - Default: `["*.xcstrings"]`
  - Any pattern beyond the built-in `*.xcstrings` — say `*.strings.json` — is registered in `workbench.editorAssociations` so VS Code routes it here, along with `git:` / `gitlens:` entries that keep diffs on the plain-text editor. Removing a pattern removes the associations again; associations you wrote by hand are left alone.

- **`xcodeI18n.sourceFilePatterns`** - File name patterns treated as source code by **Find in code** and **Find unused keys**.
  - Default: `["*.swift", "*.m", "*.mm"]`
  - Add `*.ts`, `*.tsx`, `*.js`, `*.kt` or anything else to use the grid outside an Xcode project. Quoted literals are matched in double, single, and backtick quotes, so JavaScript and TypeScript call sites are found as readily as Swift ones.

- **`xcodeI18n.languageNames`** - Display names for language tags `Intl` doesn't recognise.
  - Default: `{}`
  - Example: `{ "en-Pseudo": "English (Pseudo)" }`. Custom tags work everywhere a language appears — the grid header, the language picker, and the sidebar — and are accepted when adding a language.

## Supported file formats

| | `.xcstrings` (String Catalog) | `.strings` (legacy) |
| --- | --- | --- |
| Inline editing | ✅ | ✅ |
| Translation progress | ✅ | ✅ |
| Clean surgical diffs | ✅ | ✅ |
| Changed-since-commit markers | ✅ | ✅ |
| Review state & badges | ✅ | - |
| Translator notes | ✅ | ✅ (source file) |
| Orphaned-key detection | - (single file) | ✅ |
| *Don't translate* flag | ✅ | - |
| Language picker (hybrid columns) | ✅ | - (one language per file) |
| Find in code (configurable file types) | ✅ | ✅ |
| Find unused keys (one-shot scan) | ✅ | ✅ |
| Add / remove strings | ✅ | ✅ |
| Add / remove languages | ✅ (in the file) | ✅ (`.lproj` files, from the sidebar) |
| Comment column | ✅ | ✅ (source file) |
| State column | ✅ | ✅ (derived: filled or empty) |

Source-language cells and plural/device variant cells are read-only in this release.

## Troubleshooting

- **A catalog won't open in the grid.** Use **Open as Text** to inspect the raw JSON - a malformed file (for example, an invalid trailing comma) will surface as a normal JSON error you can fix by hand.
- **Changed-since-commit markers are missing.** They require the file to be tracked in a git repository. Untracked files or folders outside a repo show no baseline.
- **A language is missing from the grid.** Open the language picker and enable its column, or use **Refresh** in the Localizations view if the file was added outside VS Code.

## Development

```bash
npm install          # install dependencies (requires Node.js)
npm run build        # bundle the extension + webview
```

Press **F5** in VS Code to launch the Extension Development Host. The bundled **Run Extension (sample workspace)** configuration builds first and opens `sample/`, a small workspace with a String Catalog covering every state the grid draws, a legacy `.strings` table, and Swift + TypeScript files that reference some of the keys. Use `npm run watch` for incremental builds and `npm run typecheck` to type-check without emitting.

## Feedback

Issues and feature requests are welcome on the project's [GitHub repository](https://github.com/dphans/vscode_xcode_localization).

## License

[MIT](LICENSE) © Bao Phan
