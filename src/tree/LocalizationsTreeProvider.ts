// Activity-bar "Localizations" view: a NATIVE TreeView (no custom HTML) listing
// the workspace's localizations with translation progress. Two file formats live
// side by side:
//   • `.strings` (legacy): one file per language → shown as a TABLE (one per
//     <groupDir>/<basename>.strings set) that expands to its LANGUAGE files.
//     Clicking a language opens that file in the grid editor.
//   • `.xcstrings` (String Catalog): all languages in one file → shown as a
//     single CATALOG leaf that opens the catalog editor.
// Vendor dirs are excluded so framework / Pods localizations never show up.

import * as vscode from "vscode";
import { parseStrings, stringsProgress } from "../shared/strings";
import { parseCatalog } from "../shared/xcstrings";
import { allLanguageProgress } from "../shared/progress";
import { langFromLproj, detectSourceLanguage, type LprojGroup } from "../editor/lproj";
import { langName } from "../shared/langName";
import { catalogFindGlob, EXCLUDE_GLOB } from "../editor/config";

const STRINGS_GLOB = "**/*.lproj/*.strings";

/** Anti-flicker: hold the "Loading…" placeholder at least this long on the first
 * scan so a fast scan doesn't flash the spinner on and off (mirrors the grid). */
const LOADING_DWELL_MS = 800;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface TableNode {
  kind: "table";
  group: LprojGroup;
  sourceLang: string;
}
interface CatalogNode {
  kind: "catalog";
  uri: vscode.Uri;
  /** Number of languages in the catalog (incl. source). */
  langCount: number;
  /** Aggregate translated % across all target languages (no targets → 100). */
  percent: number;
  /** Whether the catalog has any non-source language (else percent is moot). */
  hasTargets: boolean;
}
interface LanguageNode {
  kind: "language";
  uri: vscode.Uri;
  lang: string;
  isSource: boolean;
  translated: number;
  total: number;
  percent: number;
}
/** A language INSIDE a `.xcstrings` catalog (catalogs hold every language in one
 * file). Selecting a target opens the grid focused on Key/source + that column;
 * selecting the source focuses the (editable) source column on its own. */
interface CatalogLanguageNode {
  kind: "catalogLanguage";
  catalogUri: vscode.Uri;
  lang: string;
  isSource: boolean;
  translated: number;
  total: number;
  percent: number;
}
/** Transient placeholder shown while the first workspace scan runs (mirrors the
 * grid's "Loading catalog…" state). */
interface LoadingNode {
  kind: "loading";
}
export type LocalizationNode = Node;
type Node =
  | TableNode
  | LanguageNode
  | CatalogNode
  | CatalogLanguageNode
  | LoadingNode;

function baseName(uri: vscode.Uri): string {
  const p = uri.path;
  const s = p.lastIndexOf("/");
  return s === -1 ? p : p.slice(s + 1);
}
function parentOf(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, "..");
}

async function readEntries(uri: vscode.Uri) {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return parseStrings(doc.getText()).entries;
  } catch {
    return [];
  }
}

/** Parse a `.xcstrings` catalog and aggregate its translation progress across
 * all target languages (translated cells / total over every target). */
async function readCatalogProgress(
  uri: vscode.Uri
): Promise<{ langCount: number; percent: number; hasTargets: boolean }> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const catalog = parseCatalog(doc.getText());
    const prog = allLanguageProgress(catalog);
    const targets = Object.keys(prog);
    if (targets.length === 0) {
      return { langCount: catalog.languages.length, percent: 100, hasTargets: false };
    }
    let translated = 0;
    let total = 0;
    for (const lang of targets) {
      translated += prog[lang].translated;
      total += prog[lang].total;
    }
    return {
      langCount: catalog.languages.length,
      percent: total === 0 ? 100 : Math.round((translated / total) * 100),
      hasTargets: true,
    };
  } catch {
    return { langCount: 0, percent: 0, hasTargets: false };
  }
}

/** A path for stable sorting that interleaves tables + catalogs by location. */
function sortPath(node: TableNode | CatalogNode): string {
  return node.kind === "table"
    ? `${vscode.workspace.asRelativePath(node.group.groupDir)}/${node.group.basename}.strings`
    : vscode.workspace.asRelativePath(node.uri);
}

export class LocalizationsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  /** Last computed top-level nodes (stale-while-revalidate cache). */
  private roots: Node[] | null = null;
  /** A scan is in flight. */
  private loading = false;
  /** A refresh landed mid-scan → run one more pass when this one finishes. */
  private reloadQueued = false;
  /** The first scan has completed → render data instead of the spinner row. */
  private loadedOnce = false;

  /** Re-scan the workspace. The current tree stays on screen while the new scan
   * runs (no loading flash on routine file-change refreshes); only the very first
   * scan shows the "Loading…" placeholder. */
  refresh(): void {
    void this.loadRoots();
  }

  getChildren(node?: Node): vscode.ProviderResult<Node[]> {
    if (!node) {
      // First scan still pending → kick it off and show a spinner row (mirrors
      // the grid's "Loading catalog…"). Afterwards, serve the cached roots.
      if (this.loadedOnce && this.roots) return this.roots;
      void this.loadRoots();
      return [{ kind: "loading" }];
    }
    if (node.kind === "table") return this.getLanguages(node);
    if (node.kind === "catalog") return this.getCatalogLanguages(node);
    return []; // language leaves / the loading row
  }

  /** Scan the workspace for `.strings` tables and `.xcstrings` catalogs,
   * interleaved by location so a folder's localizations sit together. Coalesces
   * concurrent calls and re-runs once if a refresh arrives mid-scan. */
  private async loadRoots(): Promise<void> {
    if (this.loading) {
      this.reloadQueued = true;
      return;
    }
    this.loading = true;
    const startedAt = Date.now();
    try {
      do {
        this.reloadQueued = false;
        const [tables, catalogs] = await Promise.all([
          this.getTables(),
          this.getCatalogs(),
        ]);
        const roots: (TableNode | CatalogNode)[] = [...tables, ...catalogs];
        roots.sort((a, b) => {
          const pa = sortPath(a);
          const pb = sortPath(b);
          return pa < pb ? -1 : pa > pb ? 1 : 0;
        });
        this.roots = roots;
        // Min-dwell on the FIRST scan (the one showing the spinner): hold it at
        // least LOADING_DWELL_MS so a fast scan doesn't flash. Later scans are
        // stale-while-revalidate (no spinner) → no dwell.
        if (!this.loadedOnce) {
          const remaining = LOADING_DWELL_MS - (Date.now() - startedAt);
          if (remaining > 0) await delay(remaining);
        }
        this.loadedOnce = true;
        this._onDidChange.fire();
      } while (this.reloadQueued);
    } catch {
      // A scan failure shouldn't pin the spinner forever — fall back to whatever
      // we had (or empty → the "no localizations" welcome view).
      this.roots = this.roots ?? [];
      this.loadedOnce = true;
      this._onDidChange.fire();
    } finally {
      this.loading = false;
    }
  }

  private async getCatalogs(): Promise<CatalogNode[]> {
    const uris = await vscode.workspace.findFiles(catalogFindGlob(), EXCLUDE_GLOB);
    return Promise.all(
      uris.map(async (uri) => ({
        kind: "catalog" as const,
        uri,
        ...(await readCatalogProgress(uri)),
      }))
    );
  }

  private async getTables(): Promise<TableNode[]> {
    const uris = await vscode.workspace.findFiles(STRINGS_GLOB, EXCLUDE_GLOB);
    // Group by (groupDir, basename) — siblings in the same parent are one table.
    const tables = new Map<string, LprojGroup>();
    for (const uri of uris) {
      const file = baseName(uri);
      if (!file.endsWith(".strings")) continue;
      const basename = file.slice(0, -".strings".length);
      const lprojDir = parentOf(uri);
      const lang = langFromLproj(baseName(lprojDir));
      if (!lang) continue;
      const groupDir = parentOf(lprojDir);
      const key = groupDir.toString() + " " + basename;
      let g = tables.get(key);
      if (!g) {
        g = { groupDir, basename, files: [] };
        tables.set(key, g);
      }
      g.files.push({ lang, uri });
    }

    const nodes: TableNode[] = [];
    for (const group of tables.values()) {
      group.files.sort((a, b) => (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0));
      nodes.push({ kind: "table", group, sourceLang: await detectSourceLanguage(group) });
    }
    nodes.sort((a, b) => {
      const pa = vscode.workspace.asRelativePath(a.group.groupDir);
      const pb = vscode.workspace.asRelativePath(b.group.groupDir);
      if (pa !== pb) return pa < pb ? -1 : 1;
      return a.group.basename < b.group.basename ? -1 : 1;
    });
    return nodes;
  }

  private async getLanguages(node: TableNode): Promise<LanguageNode[]> {
    const srcFile = node.group.files.find((f) => f.lang === node.sourceLang);
    const sourceKeys = new Set<string>();
    if (srcFile) {
      for (const e of await readEntries(srcFile.uri)) sourceKeys.add(e.key);
    }

    const out: LanguageNode[] = [];
    for (const f of node.group.files) {
      const isSource = f.lang === node.sourceLang;
      if (isSource) {
        out.push({
          kind: "language",
          uri: f.uri,
          lang: f.lang,
          isSource: true,
          translated: sourceKeys.size,
          total: sourceKeys.size,
          percent: 100,
        });
      } else {
        const p = stringsProgress(sourceKeys, await readEntries(f.uri));
        out.push({ kind: "language", uri: f.uri, lang: f.lang, isSource: false, ...p });
      }
    }
    out.sort((a, b) =>
      a.isSource ? -1 : b.isSource ? 1 : a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0
    );
    return out;
  }

  /** Children of a catalog node: its source language first, then each target,
   * each carrying that language's translation progress. */
  private async getCatalogLanguages(
    node: CatalogNode
  ): Promise<CatalogLanguageNode[]> {
    let catalog;
    try {
      const doc = await vscode.workspace.openTextDocument(node.uri);
      catalog = parseCatalog(doc.getText());
    } catch {
      return [];
    }
    const source = catalog.sourceLanguage;
    const prog = allLanguageProgress(catalog);
    // Denominator = rows of translatable keys; identical across languages.
    let total = 0;
    for (const e of catalog.entries) {
      if (e.shouldTranslate) total += e.rows.length;
    }

    const out: CatalogLanguageNode[] = [];
    if (source) {
      out.push({
        kind: "catalogLanguage",
        catalogUri: node.uri,
        lang: source,
        isSource: true,
        translated: total,
        total,
        percent: 100,
      });
    }
    // catalog.languages is [source, ...others sorted]; keep that order.
    for (const lang of catalog.languages.filter((l) => l !== source)) {
      const p = prog[lang];
      out.push({
        kind: "catalogLanguage",
        catalogUri: node.uri,
        lang,
        isSource: false,
        translated: p?.translated ?? 0,
        total: p?.total ?? total,
        percent: p?.percent ?? 0,
      });
    }
    return out;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "loading") {
      const item = new vscode.TreeItem(
        "Loading localizations…",
        vscode.TreeItemCollapsibleState.None
      );
      // The animated codicon spinner — same idea as the grid's spinning loader.
      item.iconPath = new vscode.ThemeIcon("loading~spin");
      item.contextValue = "xcodeI18n.loading";
      return item;
    }
    if (node.kind === "catalog") {
      // Collapsible like a .strings table: expands to its languages. Picking the
      // source opens the full catalog; picking a target focuses that column. No
      // row command — the chevron toggles, languages live underneath.
      const item = new vscode.TreeItem(
        baseName(node.uri),
        node.langCount > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      item.description = node.hasTargets
        ? `${node.langCount} languages · ${node.percent}%`
        : `${node.langCount} language${node.langCount === 1 ? "" : "s"}`;
      item.tooltip = `${vscode.workspace.asRelativePath(node.uri)} — String Catalog${
        node.hasTargets ? ` · ${node.percent}% translated` : ""
      } · expand to pick a language`;
      // Stable type icon — a String Catalog is always a "catalog" regardless of
      // progress. The done-ness lives in the "· NN%" description; the green check
      // is reserved for the per-language leaves (where it means "this language is
      // complete"). Keeps the two top-level row kinds visually parallel.
      item.iconPath = new vscode.ThemeIcon("symbol-string");
      item.contextValue = "xcodeI18n.catalog";
      return item;
    }

    if (node.kind === "catalogLanguage") {
      const item = new vscode.TreeItem(
        langName(node.lang),
        vscode.TreeItemCollapsibleState.None
      );
      item.description = node.isSource
        ? `${node.lang} · source`
        : `${node.lang} · ${node.percent}%`;
      item.tooltip = node.isSource
        ? `${langName(node.lang)} (${node.lang}) — source language · opens the source column (editable)`
        : `${langName(node.lang)} (${node.lang}) — ${node.translated}/${node.total} translated · opens Key + ${node.lang} only`;
      item.iconPath = node.isSource
        ? new vscode.ThemeIcon("globe")
        : new vscode.ThemeIcon(
            node.percent === 100 ? "check" : "globe",
            node.percent === 100 ? new vscode.ThemeColor("charts.green") : undefined
          );
      // Both focus the picked language in the grid: a target shows Key/source +
      // that column; the source shows the (now editable) source column on its own.
      item.command = {
        command: "xcodeI18n.openCatalogLanguage",
        title: "Open Language Column",
        arguments: [node.catalogUri, node.lang],
      };
      // Only a target language can be removed — the source is what everything
      // else is translated from. The suffix is what the menu's `when` matches.
      item.contextValue = node.isSource
        ? "xcodeI18n.catalogLanguage"
        : "xcodeI18n.catalogLanguage.removable";
      return item;
    }

    if (node.kind === "table") {
      const item = new vscode.TreeItem(
        `${node.group.basename}.strings`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = vscode.workspace.asRelativePath(node.group.groupDir);
      item.iconPath = new vscode.ThemeIcon("symbol-string");
      item.contextValue = "xcodeI18n.table";
      item.tooltip = `${node.group.files.length} languages · source: ${node.sourceLang || "?"}`;
      return item;
    }

    const item = new vscode.TreeItem(
      langName(node.lang),
      vscode.TreeItemCollapsibleState.None
    );
    item.description = node.isSource
      ? `${node.lang} · source`
      : `${node.lang} · ${node.percent}%`;
    item.tooltip = node.isSource
      ? `${langName(node.lang)} (${node.lang}) — source language`
      : `${langName(node.lang)} (${node.lang}) — ${node.translated}/${node.total} translated`;
    item.iconPath = node.isSource
      ? new vscode.ThemeIcon("globe")
      : new vscode.ThemeIcon(
          node.percent === 100 ? "check" : "globe",
          node.percent === 100 ? new vscode.ThemeColor("charts.green") : undefined
        );
    item.command = {
      command: "vscode.openWith",
      title: "Open Localization",
      arguments: [node.uri, "xcodeI18n.stringsEditor"],
    };
    item.contextValue = node.isSource
      ? "xcodeI18n.language"
      : "xcodeI18n.language.removable";
    return item;
  }
}
