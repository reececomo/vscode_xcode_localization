// Extracting localization keys from source code.
//
// Finds calls like `t("key", …)`, `i18n("key")` or `NSLocalizedString("key", …)`
// and reports the key together with enough context to write a useful translator
// comment: the file it came from and the function it sits in.
//
// Still a scanner, not a compiler. It recognises a call by shape — an
// identifier, an open paren, a string literal — which is what every i18n API
// has in common and what makes this work across Swift, TypeScript and whatever
// else the project uses. The cost is that a key built at runtime, or passed
// through a variable, is invisible; extraction adds what it can see and never
// removes anything on its own.

import { maskComments, syntaxFor, unescapeLiteral } from "./sourceScan";

/** Function names treated as localization calls. */
export const DEFAULT_TRANSLATION_FUNCTIONS = [
  "t",
  "i18n",
  "translate",
  "NSLocalizedString",
];

export interface CallSite {
  /** The literal first argument — the localization key. */
  key: string;
  /** The function that was called, e.g. `t`. */
  fn: string;
  /** Byte offset of the call in the file. */
  offset: number;
  /** 1-based line, for reporting. */
  line: number;
  /** Nearest enclosing declaration, e.g. `renderScoreboard`. Empty if none. */
  enclosing: string;
}

// Declarations worth naming as "the function this key sits in": named function
// scopes and types, not inline callbacks. A key passed to `$makeSelect({ $label:
// i18n("Max FPS") })` belongs to the screen that builds the menu, not to the
// anonymous option-formatter it happens to sit inside — so an object-literal
// property holding an arrow function is deliberately NOT a declaration here.
// All patterns are matched and the nearest one before the call wins.
const DECLARATIONS: RegExp[] = [
  // function foo(  /  async function foo(
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
  // const foo = (…) =>  /  let foo = function(
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/g,
  // class Foo  /  struct Foo  /  enum Foo
  /\b(?:class|struct|enum|interface)\s+([A-Za-z_$][\w$]*)/g,
  // Swift / Kotlin: func foo(  /  fun foo(
  /\b(?:func|fun)\s+([A-Za-z_$][\w$]*)\s*\(/g,
  // Class / object method shorthand: foo(…) {  or foo(…): Type {
  //
  // The return type must stay on one line. Allowing it to run to the next brace
  // turns a ternary — `cond ? t("a") : t("b")` — into "a method `t` returning
  // everything up to the next {", which is how call sites end up attributed to
  // the translation function itself.
  /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{};\n]+)?\{/gm,
];

/** Names that are control flow rather than a declaration worth reporting. */
const NOT_A_DECLARATION = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "do",
  "else",
  "guard",
  "defer",
  "repeat",
]);

interface Declaration {
  name: string;
  offset: number;
}

/** Every declaration in the file, in source order. */
function declarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  for (const pattern of DECLARATIONS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      if (!name || NOT_A_DECLARATION.has(name)) continue;
      out.push({ name, offset: m.index });
    }
  }
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

/** The declaration a given offset falls after — the nearest one preceding it. */
function enclosingAt(
  decls: Declaration[],
  offset: number,
  skip: ReadonlySet<string>
): string {
  // Walk back from the nearest preceding declaration. `skip` holds the
  // translation functions themselves: whatever a pattern thinks it saw,
  // `t` is never the function a key lives in.
  let lo = 0;
  let hi = decls.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (decls[mid].offset < offset) {
      at = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = at; i >= 0; i--) {
    if (!skip.has(decls[i].name)) return decls[i].name;
  }
  return "";
}

/**
 * Find every localization call in `text`.
 *
 * Matching is on the call shape rather than on any particular API: an
 * identifier from `fnNames`, optional whitespace, `(`, optional whitespace, and
 * a string literal. A member call (`i18n.t("…")`) matches on its last segment,
 * so `t` covers both. Quote styles follow the file's language, so an apostrophe
 * in Swift prose is never mistaken for a string.
 *
 * Comments are blanked out first. A commented-out call is not a call, and a key
 * only reachable from one has no business being added to a catalog — that goes
 * for the declarations too, so a commented-out `function` never gets credited
 * as the scope a live call sits in.
 */
export function findCallSites(
  text: string,
  fileName: string,
  fnNames: readonly string[]
): CallSite[] {
  if (fnNames.length === 0) return [];
  const syntax = syntaxFor(fileName);
  const names = new Set(fnNames);
  // Blanked, not removed, so every offset and line number still lines up with
  // the real file.
  const code = maskComments(text, fileName);
  const decls = declarations(code);
  const out: CallSite[] = [];

  // An identifier immediately followed by "(" and a quote — the quote character
  // is captured so the literal can be read with the matching terminator.
  const call = /([A-Za-z_$][\w$]*)\s*\(\s*(["'`])/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(code)) !== null) {
    const fn = m[1];
    const quote = m[2];
    if (!names.has(fn)) continue;
    if (quote === '"' && !syntax.double) continue;
    if (quote === "'" && !syntax.single) continue;
    if (quote === "`" && !syntax.backtick) continue;

    // Read the literal, honouring escapes and the no-raw-newline rule.
    const start = m.index + m[0].length;
    const multiline = quote === "`";
    let j = start;
    let closed = false;
    while (j < code.length) {
      const c = code[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === quote) {
        closed = true;
        break;
      }
      if (!multiline && (c === "\n" || c === "\r")) break;
      j++;
    }
    if (!closed) continue;

    const raw = code.slice(start, j);
    // A key spliced together at runtime isn't a key we can extract.
    if (/(^|[^\\])\$\{/.test(raw) || /(^|[^\\])\\\(/.test(raw)) continue;
    // `t("")` is a call, but an empty key is nothing to put in a catalog.
    if (raw === "") continue;

    out.push({
      key: unescapeLiteral(raw),
      fn,
      offset: m.index,
      line: code.slice(0, m.index).split("\n").length,
      enclosing: enclosingAt(decls, m.index, names),
    });
    call.lastIndex = j + 1;
  }
  return out;
}

/** One place a key is used. */
export interface KeyLocation {
  /** File name, without its directory. */
  file: string;
  /** Enclosing declaration, e.g. `$sortableName`. Empty if none was found. */
  enclosing: string;
}

/**
 * The translator comment line for one call site: `#NationalTeamName.ts:$sortableName`.
 *
 * The leading `#` marks the line as machine-written. That marker is what makes
 * re-scanning safe — a comment starting with `#` is ours to replace, anything
 * else is a human's note and is left alone.
 */
export function extractionComment(location: KeyLocation): string {
  const base = location.file.split("/").pop() ?? location.file;
  return location.enclosing ? `#${base}:${location.enclosing}` : `#${base}`;
}

/**
 * The comment for a key used in several places: one line per location, in the
 * order they were found, with no trailing newline.
 */
export function extractionComments(locations: readonly KeyLocation[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const location of locations) {
    const line = extractionComment(location);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Whether an existing comment may be replaced by a freshly scanned one.
 *
 * Only two cases: there is no comment, or the comment is one this tool wrote —
 * which the leading `#` says. A note somebody typed for their translators is
 * never overwritten by a scan.
 */
export function isReplaceableComment(comment: string | undefined): boolean {
  const text = (comment ?? "").trim();
  return text === "" || text.startsWith("#");
}
