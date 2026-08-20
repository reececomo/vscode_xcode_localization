// Finding the workspace's OWN files.
//
// Two things get filtered out, for different reasons.
//
// GITIGNORED FILES. What belongs to a project is already written down in its
// `.gitignore`, so that is what decides — rather than a list of folder names
// this extension would have to keep guessing at. It matters most for build
// output: a bundled `dist/` holds your strings again alongside every
// dependency's, minified, where a one-letter local named `t` is indistinguishable
// from a call to a translation function. Scanning it yields duplicate counts and
// nonsense extractions. `git check-ignore` answers authoritatively, including
// nested and negated rules; without a repo (or without git) nothing is filtered,
// which is the safe direction.
//
// NESTED CHECKOUTS. A git worktree, submodule or vendored clone is a whole
// parallel copy of the project, and it is NOT gitignored. What they have in
// common is a `.git` entry of their own — a directory for a clone, a `gitdir:`
// file for a worktree. The workspace root is exempt: it is allowed to be a
// worktree itself.

import * as vscode from "vscode";
import { execFile } from "child_process";
import { excludeGlob } from "./config";

/** Directories already classified, so a big scan asks the filesystem once. */
const nestedRepoCache = new Map<string, boolean>();

/** Drop the caches — used by the tree's Refresh, so a new worktree is noticed. */
export function clearProjectFileCache(): void {
  nestedRepoCache.clear();
}

async function hasGitEntry(dir: vscode.Uri): Promise<boolean> {
  const key = dir.toString();
  const cached = nestedRepoCache.get(key);
  if (cached !== undefined) return cached;
  let found = false;
  try {
    // Either kind counts: a directory (clone) or a file (worktree, submodule).
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, ".git"));
    found = true;
  } catch {
    found = false;
  }
  nestedRepoCache.set(key, found);
  return found;
}

/**
 * Whether `uri` sits inside a checkout of its own — a worktree, submodule or
 * vendored clone nested under the workspace folder.
 */
async function inNestedRepo(uri: vscode.Uri): Promise<boolean> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return false;
  const root = folder.uri.path;

  let dir = vscode.Uri.joinPath(uri, "..");
  while (dir.path.startsWith(root) && dir.path !== root) {
    if (await hasGitEntry(dir)) return true;
    const up = vscode.Uri.joinPath(dir, "..");
    if (up.path === dir.path) break;
    dir = up;
  }
  return false;
}

/**
 * Ask git which of `paths` (relative to `cwd`) are ignored.
 *
 * Exit code 1 means "none of them are", which is a normal answer, not a
 * failure. Any other failure — no repo, no git on PATH — resolves to "nothing
 * is ignored" so the scan degrades to including everything rather than silently
 * losing files.
 */
function gitCheckIgnore(cwd: string, paths: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (paths.length === 0) return resolve(new Set());
    const child = execFile(
      "git",
      ["check-ignore", "-z", "--stdin"],
      { cwd, maxBuffer: 128 * 1024 * 1024 },
      (error, stdout) => {
        const code = (error as { code?: number } | null)?.code;
        if (error && code !== 1) return resolve(new Set());
        resolve(new Set(stdout.split("\0").filter((p) => p !== "")));
      }
    );
    child.stdin?.end(paths.join("\0"));
  });
}

/** Group URIs by the workspace folder that contains them. */
function byWorkspaceFolder(uris: vscode.Uri[]): Map<string, vscode.Uri[]> {
  const groups = new Map<string, vscode.Uri[]>();
  for (const uri of uris) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) continue;
    const key = folder.uri.fsPath;
    const list = groups.get(key);
    if (list) list.push(uri);
    else groups.set(key, [uri]);
  }
  return groups;
}

/** Everything in `uris` that git does not ignore. */
async function withoutIgnored(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
  const keep: vscode.Uri[] = [];
  for (const [root, group] of byWorkspaceFolder(uris)) {
    const relative = group.map((uri) =>
      vscode.workspace.asRelativePath(uri, false)
    );
    const ignored = await gitCheckIgnore(root, relative);
    group.forEach((uri, i) => {
      if (!ignored.has(relative[i])) keep.push(uri);
    });
  }
  return keep;
}

/**
 * `vscode.workspace.findFiles`, minus anything gitignored and anything
 * belonging to a nested checkout. Use this everywhere the extension scans the
 * project, so build output and worktrees never show up as duplicate catalogs or
 * inflate a key's usage count.
 */
export async function findProjectFiles(
  include: string | vscode.RelativePattern,
  exclude: string = excludeGlob()
): Promise<vscode.Uri[]> {
  const found = await vscode.workspace.findFiles(include, exclude);
  const tracked = await withoutIgnored(found);
  const keep: vscode.Uri[] = [];
  for (const uri of tracked) {
    if (!(await inNestedRepo(uri))) keep.push(uri);
  }
  return keep;
}
