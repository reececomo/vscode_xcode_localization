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
- **Inline editing** - Click an empty cell to start typing straight away (a filled one takes a double-click, so you can still select its text). **Enter** to commit, **Esc** to cancel. Move through translations with **Tab**, **Shift+Tab**, and the arrow keys, just like a spreadsheet.
- **Clean, Xcode-compatible diffs** - Edits are applied surgically: only the changed value or state span is rewritten, preserving key order, indentation, and line endings. No more noisy reformatting in code review.
- **Translation progress** - A per-language progress bar (percent translated, excluding keys marked *Don't translate*) in the toolbar, the language picker, and the sidebar.
- **State tracking** - Cells carry their state - *translated*, *new*, *needs review*, or *stale* - as a colored badge, and you can flag a translation as **Reviewed** or **Needs review** from a per-cell menu.
- **Automatic *needs review*** - A translation is only correct with respect to the source it was made from, so when that source moves the translations are flagged. Editing a source-language cell marks every translation of it **needs review** in the same edit (one undo puts both back), and a **sync** catches the changes this editor never saw - a reword committed by a teammate, a *Vary by Plural* added in Xcode - by comparing against git `HEAD`. Only settled translations are flagged: an empty cell stays *new*, and one already *needs review* or *stale* is left alone. Turn it off with `xcodeI18n.autoMarkNeedsReview`.
- **ICU MessageFormat highlighting and validation** - Values written as ICU messages (`{count, plural, one {# item} other {# items}}`) are syntax-highlighted in the grid: placeholder names, argument types, branch selectors, and `#` each get their own colour, with braces tinted by nesting depth so a pair reads as a pair. They are validated as you go, and the mistakes that throw at format time are caught before they ship - an unbalanced brace, a `plural` or `select` with no `other` fallback, a misspelled branch (`ones`), a duplicate branch, an unknown argument type, a malformed `offset:`. Placeholders a translation dropped, invented, or quietly flattened (`{count, plural, …}` becoming a bare `{count}`) are flagged against the source too. Only values containing braces are parsed, `'{escaped}'` runs are respected, and the whole check is one setting away (`xcodeI18n.validateIcuMessages`) if your strings use braces as literal text.
- **Format specifier validation** - When a translation's `%@`, `%lld`, or `%1$@` placeholders drift from the source, the cell is flagged with a non-blocking warning. Reordering positional specifiers never raises a false positive.
- **Changed-since-commit markers** - The editor reads your git `HEAD` and highlights every value or state that has changed since your last commit, with a *"Changed since last commit · was: …"* tooltip. A **Changed** filter scopes the grid to just those edits.
- **Search and filter** - A search box matches across keys, developer notes, and translations in any visible language, with hits highlighted. Filter rows by **All**, **Untranslated**, **Needs review**, **Warnings**, **Orphaned** (legacy `.strings` only: keys present in the target file but missing from the source language), **Unused** (after running a code scan - see *Find unused keys*), or **Changed** - search and filter compose.
- **Hybrid columns** - By default the grid shows your source plus one target language. A language picker lets you toggle additional columns on and off, complete with each language's progress; your selection is remembered per file.
- **Translator notes** - Add, edit, or remove a developer note for any key from the key's context menu (hover a row and click the **⋯** button at the end of the key, or click an existing note to edit it inline), and mark a key as *Don't translate* to exclude it from progress and filters.
  - **Legacy `.strings`:** a key's note lives in the *source-language* file, so notes are editable only when you open that file - e.g. `en.lproj/Localizable.strings`. While viewing a target language the source note is shown **read-only** (open the source file to change it).
- **Find in code** - From any key's context menu, **Find in code** opens VS Code's search scoped to your source files and pre-filled with the key as a quoted string literal - jumping straight to the `Text("…")`, `NSLocalizedString("…", …)`, or `t('…')` call sites so you can refactor the wording where it's used. Swift, Objective-C, JavaScript and TypeScript are covered by default; see [How keys are matched in code](#how-keys-are-matched-in-code).
- **Find unused keys** - The **Scan code** button in the toolbar runs a one-shot pass over your source files and flags every key with no quoted-literal reference in code as *unused*, with an **Unused** filter to list them. It's a hint, not a verdict - keys built by string interpolation or referenced from storyboards/XIBs aren't detected, so verify before deleting. Nothing is indexed in the background and nothing is deleted automatically; re-run the scan whenever you want fresh results.
- **Add and remove strings** - The **+** and **−** buttons at the top left of the grid add a key or delete the selected one. **−** stays greyed out, with the reason in its tooltip, whenever a key isn't yours to delete: it is still referenced in your source code, Xcode manages it automatically (it would be re-extracted on the next build), or it is marked stale but still carries translations. Hand-added keys (`extractionState: "manual"`) can always be deleted, and a delete always re-scans your code first. Set `xcodeI18n.allowRemovingManagedStrings` if you want the automatically-managed rule lifted.
- **Add and remove languages** - Add a language from the language picker, the toolbar's **⋯** menu, or the Localizations sidebar's context menu. The catalog gets an empty `new` entry for every key, exactly as Xcode writes it. Removing a language is only offered once nothing is translated in it, so a disappearing column can never take work with it. For legacy `.strings`, adding a language creates the `<lang>.lproj` file seeded from the source language; removing one moves it to the trash.
- **Comment and State columns** - Xcode's two metadata columns, on by default. **Comment** shows each key's developer note in its own column, rendered a step fainter than the translations, and stays editable in place. **State** shows a green checkmark when a string is translated, an orange **NEW** square when it isn't, and a labelled chip for *needs review* and *stale*; it reports on the first target language shown. Toggle either from the **⋯** menu.
- **Resizable columns** - Drag a column divider to resize, double-click it to reset. Widths are persisted per file.
- **Built for large catalogs** - Rows are virtualized with measured heights, so catalogs with thousands of entries scroll smoothly while the frozen header and columns stay put.
- **Theme-aware** - The grid follows your active VS Code color theme and contrast settings.

![Editing a target cell inline, with a state badge, a format-specifier warning, and a changed-since-commit marker.](assets/screenshots/editing-cell.png)

![The language picker popover, showing each target language with a checkbox and its translation progress.](assets/screenshots/language-picker.png)

## How keys are matched in code

**Find in code** and **Find unused keys** both work the same way, and it is worth being precise about what they do — and don't — do.

They perform a **text search for the key as a quoted string literal**. There is no parser, no AST, and no knowledge of your i18n API. A key counts as referenced when it appears between quotes in a file matching `xcodeI18n.sourceFilePatterns`:

| Call site | Matched |
| --- | --- |
| `Text("Continue")`, `Button("Cancel")` | ✅ |
| `NSLocalizedString("Cancel", comment: "")` | ✅ |
| `@"Cancel"` (Objective-C — the `@` sits outside the quotes) | ✅ |
| `t('save.button')`, `t("save.button")`, ``t(`save.button`)`` | ✅ |
| `t('Don\'t save')` — escapes are decoded before comparing | ✅ |
| A key named in a comment, or in commented-out code | ✅ counted (see below) |
| A backtick literal spanning several lines | ✅ |
| ``t(`${screen}.title`)`` — interpolated, so built at runtime | ❌ skipped |
| `Text("Hi \(name)")` — Swift interpolation | ❌ skipped |
| `t(KEYS.saveButton)` — key held in a constant | ❌ not found |
| A key referenced only from a storyboard or XIB | ❌ not found |
| Swift raw (`#"…"#`) or multiline (`"""…"""`) strings | ❌ out of scope |

Matching is **case-sensitive and exact** — the whole literal has to equal the key, not contain it.

Two language rules keep the scan in sync, and both matter more than they sound:

- **A single quote only opens a string where the language says it does.** In Swift, Objective-C, C, Java and Kotlin, `'` is a character literal or — far more often — an apostrophe in prose. Treating it as a string delimiter makes the scanner run to the next apostrophe and swallow every real call site in between.
- **Single- and double-quoted strings cannot contain a raw newline.** So a quote that never closes on its own line isn't a string at all; it's an apostrophe in `<p>Here's the thing</p>`, and scanning resumes immediately after it rather than running away.

Comments are read in isolation rather than skipped, so a key mentioned in a comment or in commented-out code still counts — the scan errs toward *used* on purpose. Inside a comment the apostrophe is demoted to prose.

The consequences follow from that design. The count deliberately errs toward *used*: a key mentioned in a comment or in an unrelated string still counts, so **Unused** over-reports safety rather than under-reporting it. A zero is a strong hint, never a verdict, which is why nothing is ever deleted automatically and why the **−** button re-scans before it deletes.

**Find in code** opens VS Code's own search prefilled with the regex `["'`]<key>["'`]`, scoped to the same file patterns, so you land on the call sites and can edit them there.

### Escapes in the preview

Grid cells show the string **as it will appear in the app**, with ICU's quoting resolved: `You''ll see.` previews as `You'll see.`, and `'{braces}'` previews as a literal `{braces}` (styled apart from a real placeholder, with the raw form in its tooltip). The underlying value is never rewritten — open the cell for editing and you get the exact source text back, so the file stays byte-identical.

## Sync with code

The **sync** button in the toolbar (left of the **⋯** menu) reconciles a catalog with the source that uses it, in a single sweep:

- **Extract** — every `t("key", …)` / `i18n("key")` / `NSLocalizedString("key", …)` call whose key is missing from the catalog is added and marked `extractionState: "extracted"`.
- **Comment** — each key gets a comment listing every place it is used, one per line with no trailing newline:

  ```
  #makeBindHintButton.ts:$makeBindHintButton
  #HUDQuickChatView.ts:$renderOptionSet
  ```

  The name after the colon is the function the call sits in - the named function, method, or class scope, not an inline callback it happens to be nested inside. The leading `#` marks the line as machine-written, and that marker is what makes re-scanning safe. A comment is refreshed only when it is **empty** or **starts with `#`**; a note somebody typed for their translators is never touched. Because locations are listed in sorted file order, running sync twice produces no second change.
- **Re-file** — keys the catalog says were extracted, but that no call site references any more, are marked `stale`. This reads the same count as the **Unused** filter, so the STALE chip and the *unused* badge can never contradict each other: every stale key is also flagged unused, and *unused* additionally covers hand-added (`manual`) keys, which stale never applies to. **Nothing is deleted** — a stale entry keeps its translations until you remove it, and the **−** button unlocks for it once it has none. Hand-added (`manual`) and `migrated` keys are never re-filed. Turn this off with `xcodeI18n.markMissingKeysStale`.
- **Flag for review** — strings whose source text, or whose plural / device variations, changed since your last commit have their existing translations marked **needs review**. Those translations were written against something that no longer exists.
- **Refresh usage** — every key's reference count is recomputed, so the **Unused** filter is up to date. This happens even if you cancel the write.

Nothing is written without a confirmation listing exactly what will change, and the document stays dirty so it only reaches disk when you save.

**Gitignored files are never scanned.** That is what keeps build output out of it: a bundled `dist/` contains your strings again alongside every dependency's, minified, where a one-letter local named `t` is indistinguishable from a call to a translation function — so scanning it yields duplicate counts and nonsense keys. `git check-ignore` decides, so nested and negated rules work as written; outside a repo nothing is filtered.

Which functions count as localization calls is `xcodeI18n.translationFunctions`; a member call matches on its last segment, so `t` also covers `i18n.t("key")`. The sweep looks under `xcodeI18n.extractionRoot` — by default one level above the catalog, so `client/lang/messages.xcstrings` scans `client/` rather than the whole workspace.

A key assembled at runtime (`` t(`${screen}.title`) ``) or passed through a variable can't be seen, so extraction adds what it can and never removes anything on its own. Compiling your catalog remains your build's job — `xcstringstool` or Xcode's build phase for Apple projects, your own tooling elsewhere.

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

Two things are skipped everywhere the extension scans. **Gitignored files**, so build output such as `dist/` never appears. And **nested checkouts** — a directory below the workspace root carrying its own `.git`, i.e. a git worktree, submodule, or vendored clone. Those are somebody else's copy of the project and are *not* gitignored, so they need catching separately; without it their catalogs show up as duplicates and their sources inflate every usage count.

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
  - **Empty cells always open on a single click.** The double-click gesture protects text you might want to select or read; *(untranslated)* is neither, and needing two clicks to start typing is friction on the one action the grid exists for.
  - **Note:** Keyboard activation (**Enter**, **F2**, or type-to-edit) always opens the editor regardless of this setting.

- **`xcodeI18n.showCommentColumn`** - Show the developer note as its own column, the way Xcode does. When off, the note appears under the key instead.
  - Default: `true`

- **`xcodeI18n.showStateColumn`** - Show the State column (green checkmark / orange **NEW** square / state label). It reports on the first target language shown.
  - Default: `true`

- **`xcodeI18n.allowRemovingManagedStrings`** - Let the **−** button delete keys Xcode manages automatically. Off by default, because such a key is extracted from your source and returns on the next build.
  - Default: `false`

- **`xcodeI18n.validateIcuMessages`** - Parse values containing braces as ICU MessageFormat: highlight their structure and flag the syntax errors that would throw at format time.
  - Default: `true`
  - Values without braces are never touched. Turn this off if your strings use `{` and `}` as literal text and you would rather not escape them.

- **`xcodeI18n.catalogFilePatterns`** - File name patterns opened as String Catalogs.
  - Default: `["*.xcstrings", "*.strings.json"]`
  - Each pattern is registered globally in `workbench.editorAssociations` so this grid becomes the **default editor** for it, along with `git:` / `gitlens:` entries that keep diffs on the plain-text editor. Removing a pattern removes its associations again; associations you wrote by hand are left alone. **Open as Text** always remains available from the editor toolbar.

- **`xcodeI18n.sourceFilePatterns`** - File name patterns treated as source code by **Find in code** and **Find unused keys**.
  - Default: `["*.swift", "*.m", "*.mm", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"]`
  - Swift, Objective-C and the JavaScript/TypeScript family are covered out of the box. Add `*.kt`, `*.py`, `*.vue` or anything else you keep call sites in. See [How keys are matched in code](#how-keys-are-matched-in-code) for exactly what counts as a reference. Vendor folders (`node_modules`, `Pods`, `Carthage`, `build`, `DerivedData`, `.build`, `*.xcframework`) are always skipped.

- **`xcodeI18n.translationFunctions`** - Function names treated as localization calls when extracting.
  - Default: `["t", "i18n", "translate", "NSLocalizedString"]`

- **`xcodeI18n.extractionRoot`** - Where a sweep looks for strings, relative to the catalog's own folder.
  - Default: `".."` - one level up, so a catalog describes the module that owns it. Use `"../.."` to widen it or `"."` to scan only its folder.

- **`xcodeI18n.excludePatterns`** - Files and folders never scanned.
  - Default: `["**/node_modules/**", "**/.git/**", "**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/__mocks__/**"]`
  - Gitignored files are already skipped, so `node_modules` and `.git` are named only to avoid walking a large tree just to discard it. **Tests are named because they are not gitignored**: a string in a test is an assertion *about* the app rather than part of it, so extracting from one invents catalog entries nobody ships, and counting one as a reference would keep a dead key alive long after the feature was deleted.

- **`xcodeI18n.autoMarkNeedsReview`** - Flag translations as *needs review* when the source they were made from changes - either you edit a source string, or a sync finds the text or its variations moved since the last commit.
  - Default: `true`

- **`xcodeI18n.markMissingKeysStale`** - Mark previously extracted keys that no longer appear in your code as `stale` during a sync. Nothing is deleted.
  - Default: `true`

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
| ICU highlighting & validation | ✅ | ✅ |
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

## Installing your own build

This fork is not published to the Marketplace. To use it in your normal VS Code:

```bash
npm install && npm run install-local
```

That bundles the extension, packages `xcode-i18n.vsix`, and installs it with `code --install-extension`. Reload your VS Code windows afterwards (**Developer: Reload Window**) to pick up the new build. Uninstall it again from the Extensions view, or with `code --uninstall-extension reececomo.xcode-i18n`.

Because it declares the same editor and command IDs as the upstream extension, only one of the two can be installed at a time.

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
