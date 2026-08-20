// Finding a localization key in source code.
//
// This is deliberately a TEXT search, not a parser: the extension never learns
// your i18n API. It looks for the key as a quoted string literal, which is what
// every call site has in common — `Text("Save")`, `NSLocalizedString("Save", …)`,
// `t('save.button')`, `` i18n(`save.button`) ``. That buys language independence
// at the cost of precision, and the trade is deliberate: over-counting is safe
// (a key looks used and survives), under-counting is not (a key looks dead and
// gets deleted). Everything here therefore errs toward "used".

/** Escape a string for use inside a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex that finds the key as a quoted literal in any of the three quote
 * styles, for VS Code's search box.
 *
 * No backreference pairs the quotes, because the editor's search runs on
 * ripgrep, whose engine has none. Mismatched quotes (`"key'`) therefore match
 * too — which needs a string that opens and closes differently to be a false
 * positive, so it costs nothing in practice.
 */
export function literalSearchPattern(key: string): string {
  return `["'\`]${escapeRegExp(key)}["'\`]`;
}

/**
 * Decode the escapes inside a quoted literal, so source that had to escape a
 * character still matches the key that contains it — `'Don\\'t'` is the key
 * `Don't`. Unknown escapes keep the character that follows the backslash, the
 * lenient reading both Swift and JavaScript take.
 */
export function unescapeLiteral(raw: string): string {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\" || i + 1 >= raw.length) {
      out += c;
      continue;
    }
    const d = raw[++i];
    switch (d) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "0": out += "\0"; break;
      case "u": {
        // \u{1F600} (Swift, JS) and ￿ (JS, Obj-C).
        if (raw[i + 1] === "{") {
          const close = raw.indexOf("}", i + 2);
          const hex = close === -1 ? "" : raw.slice(i + 2, close);
          if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
            out += String.fromCodePoint(parseInt(hex, 16));
            i = close;
            break;
          }
          out += d;
          break;
        }
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += d;
        }
        break;
      }
      default:
        // Covers \" \' \` \\ and anything else: the character itself.
        out += d;
    }
  }
  return out;
}

/**
 * Whether a literal splices in a value at runtime — `"Hi \(name)"` in Swift,
 * `` `hi ${name}` `` in JS. Such a string is built, not looked up, so it can
 * never be a key and is skipped rather than counted.
 */
function isInterpolated(raw: string): boolean {
  return /(^|[^\\])\\\(/.test(raw) || /(^|[^\\])\$\{/.test(raw);
}

/** Which quote characters actually start a string in a given language. */
export interface SourceSyntax {
  double: boolean;
  single: boolean;
  backtick: boolean;
  /** Comment styles to skip over. */
  hashComments: boolean;
  slashComments: boolean;
}

/**
 * How to read a file, by extension.
 *
 * The single quote is the reason this matters. In Swift, Objective-C, C, Java
 * and friends `'` is a character literal or, far more often, an apostrophe in
 * prose — treating it as a string delimiter makes the scanner swallow
 * everything up to the next apostrophe, taking real call sites with it. In
 * JavaScript, TypeScript, Python and Ruby it genuinely opens a string.
 */
export function syntaxFor(fileName: string): SourceSyntax {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const slash = { hashComments: false, slashComments: true };
  switch (ext) {
    case "swift":
    case "m":
    case "mm":
    case "h":
    case "hpp":
    case "c":
    case "cc":
    case "cpp":
    case "java":
    case "kt":
    case "kts":
    case "cs":
    case "dart":
    case "scala":
      return { double: true, single: false, backtick: false, ...slash };
    case "go":
      return { double: true, single: false, backtick: true, ...slash };
    case "py":
    case "rb":
    case "sh":
    case "bash":
    case "zsh":
    case "yml":
    case "yaml":
    case "toml":
      return {
        double: true,
        single: true,
        backtick: false,
        hashComments: true,
        slashComments: false,
      };
    default:
      return { double: true, single: true, backtick: true, ...slash };
  }
}

/**
 * Walk `text` and hand every string literal to `onLiteral` (raw, still escaped).
 *
 * A character scan rather than a regex, because the two things that break a
 * regex here are structural: comments hold apostrophes that look like open
 * quotes, and so does ordinary prose in JSX. Two rules keep it in sync —
 * comments are read in ISOLATION, and single- and double-quoted strings cannot
 * contain a raw newline in any language here. A quote that never closes on its
 * own line is therefore not a string at all; it is an apostrophe, and scanning
 * resumes right after it instead of running to the next one.
 *
 * Comments are scanned rather than skipped, so a key named in a comment or in
 * commented-out code still counts as a reference. That keeps the whole scan
 * erring toward "used", which is the safe direction: over-counting leaves a key
 * alive, under-counting invites someone to delete a live one. Inside a comment
 * the apostrophe is demoted to ordinary prose, which is what it almost always
 * is there.
 */
function scanComment(
  body: string,
  syntax: SourceSyntax,
  onLiteral: (raw: string, inComment: boolean) => void
): void {
  if (!body.includes('"') && !body.includes("`")) return;
  scanSource(
    body,
    {
      double: true,
      // An apostrophe in a comment is prose, never a string.
      single: false,
      backtick: syntax.backtick,
      hashComments: false,
      slashComments: false,
    },
    { onLiteral: (raw) => onLiteral(raw, true) }
  );
}

/** What a caller wants out of a walk over the source. */
interface ScanHandlers {
  /** A string literal's raw (still escaped) contents, and whether it was found
   * inside a comment rather than in code. */
  onLiteral?(raw: string, inComment: boolean): void;
  /** A comment's full span, delimiters included. */
  onComment?(start: number, end: number): void;
}

function scanSource(
  text: string,
  syntax: SourceSyntax,
  handlers: ScanHandlers
): void {
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];

    if (syntax.slashComments && c === "/" && text[i + 1] === "/") {
      const from = i;
      const body = i + 2;
      i = body;
      while (i < n && text[i] !== "\n") i++;
      handlers.onComment?.(from, i);
      if (handlers.onLiteral) {
        scanComment(text.slice(body, i), syntax, handlers.onLiteral);
      }
      continue;
    }
    if (syntax.slashComments && c === "/" && text[i + 1] === "*") {
      const from = i;
      const body = i + 2;
      i = body;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      const bodyEnd = i;
      i = Math.min(n, i + 2);
      handlers.onComment?.(from, i);
      if (handlers.onLiteral) {
        scanComment(text.slice(body, bodyEnd), syntax, handlers.onLiteral);
      }
      continue;
    }
    if (syntax.hashComments && c === "#") {
      const from = i;
      const body = i + 1;
      i = body;
      while (i < n && text[i] !== "\n") i++;
      handlers.onComment?.(from, i);
      if (handlers.onLiteral) {
        scanComment(text.slice(body, i), syntax, handlers.onLiteral);
      }
      continue;
    }

    const opensString =
      (c === '"' && syntax.double) ||
      (c === "'" && syntax.single) ||
      (c === "`" && syntax.backtick);

    if (opensString) {
      // Only a backtick template may span lines.
      const multiline = c === "`";
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === c) {
          closed = true;
          break;
        }
        if (!multiline && (d === "\n" || d === "\r")) break;
        j++;
      }
      if (closed) {
        handlers.onLiteral?.(text.slice(i + 1, j), false);
        i = j + 1;
        continue;
      }
      // Not a string: an apostrophe in prose, or an unterminated quote. Step
      // over just this character so the rest of the file still scans.
      i++;
      continue;
    }

    i++;
  }
}

/**
 * Count how often each wanted key appears as a quoted literal in `text`.
 *
 * `counts` receives references from CODE. `commentCounts`, when given, receives
 * mentions found inside comments, kept separate rather than folded in: a
 * commented-out call is not a reference — the string is not in the app — but it
 * is still worth telling someone about before they delete the key. One question
 * per counter, so nothing downstream has to guess which kind of hit it got.
 *
 * Only the keys handed in are counted, so the work is proportional to the
 * matches and the memory to the key set — a codebase of any size scans in one
 * pass. `fileName` selects the language rules; omitted, the permissive default
 * (all three quote styles, slash comments) applies.
 */
export function countKeyLiterals(
  text: string,
  wanted: ReadonlySet<string>,
  counts: Record<string, number>,
  fileName = "",
  commentCounts?: Record<string, number>
): void {
  scanSource(text, syntaxFor(fileName), {
    onLiteral: (raw, inComment) => {
      if (inComment && !commentCounts) return;
      if (isInterpolated(raw)) return;
      const value = unescapeLiteral(raw);
      if (!wanted.has(value)) return;
      const into = inComment ? commentCounts! : counts;
      into[value] = (into[value] ?? 0) + 1;
    },
  });
}

/**
 * The same text with every comment blanked to spaces, newlines kept.
 *
 * A commented-out `i18n("Launching")` is not a call: the string is not in the
 * app, so it must not be extracted, must not keep a key from going stale, and
 * must not count as a reference. It is still worth reporting separately, which
 * is why the walker distinguishes the two rather than simply skipping comments.
 *
 * Blanking rather than removing keeps every offset and line number intact, so
 * whatever the caller reports still points at the right place in the real file.
 */
export function maskComments(text: string, fileName = ""): string {
  const spans: Array<[number, number]> = [];
  scanSource(text, syntaxFor(fileName), {
    onComment: (start, end) => spans.push([start, end]),
  });
  if (spans.length === 0) return text;

  let out = "";
  let last = 0;
  for (const [start, end] of spans) {
    out += text.slice(last, start);
    out += text.slice(start, end).replace(/[^\n\r]/g, " ");
    last = end;
  }
  return out + text.slice(last);
}
