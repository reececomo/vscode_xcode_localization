// ICU MessageFormat: highlighting + validation.
//
// A String Catalog value can carry an ICU message — `{count, plural, one {…}
// other {…}}` — and the failure mode is unforgiving: a missing `other` branch or
// an unbalanced brace throws at format time, in the language nobody on the team
// reads. So the grid parses every braced value and reports what's wrong inline,
// the same way it already reports printf specifiers.
//
// One pass produces BOTH the highlight tokens and the diagnostics, so what you
// see coloured and what you see warned about can never disagree. The parser
// never throws and always consumes the whole input: on a syntax error it records
// it, skips to the matching brace, and carries on, so one broken placeholder
// doesn't blank the rest of the line.

/** What a token is, which is also how it gets coloured. */
export type IcuTokenKind =
  | "text"
  /** `{` and `}` — coloured by nesting depth, like bracket-pair colouring. */
  | "brace"
  | "comma"
  /** The argument name: `count` in `{count, plural, …}`. */
  | "arg"
  /** The argument type: `plural`, `select`, `number`, … */
  | "type"
  /** A branch selector (`one`, `=0`, `female`) or a format style. */
  | "key"
  /** `#` — the count, inside a plural branch. */
  | "hash"
  /** `offset:1` on a plural. */
  | "offset"
  /** An `'…'` quoted literal, which turns ICU syntax back into plain text. */
  | "quoted";

export interface IcuToken {
  /** The raw source span, which is what the editor round-trips. */
  text: string;
  kind: IcuTokenKind;
  /** Brace nesting depth, used to colour matching pairs alike. */
  depth: number;
  start: number;
  /**
   * What this span actually renders as, when that differs from the source —
   * `it''s` is the escape for `it's`, and `'{x}'` renders as a literal `{x}`.
   * Set only where an escape is resolved; absent means "shown as written".
   */
  display?: string;
}

export interface IcuDiagnostic {
  message: string;
  start: number;
  end: number;
}

/** One placeholder found in a message. */
export interface IcuArgument {
  name: string;
  /** The declared type, or "none" for a bare `{name}`. */
  type: string;
}

export interface IcuParse {
  tokens: IcuToken[];
  errors: IcuDiagnostic[];
  args: IcuArgument[];
}

/** Types ICU understands after the argument name. */
const ARG_TYPES = [
  "number",
  "date",
  "time",
  "spellout",
  "ordinal",
  "duration",
  "plural",
  "selectordinal",
  "select",
];

/** CLDR plural categories. A branch is one of these or an exact `=N` match. */
const PLURAL_KEYS = ["zero", "one", "two", "few", "many", "other"];

/** Types whose options are `selector {message}` branches rather than a style. */
function hasBranches(type: string): boolean {
  return type === "plural" || type === "selectordinal" || type === "select";
}

/**
 * Whether a value is worth parsing as ICU at all. Braces are the only marker
 * ICU has, so a value without them is plain text and is left alone.
 */
export function looksLikeIcu(value: string): boolean {
  return value.includes("{") || value.includes("}");
}

/**
 * Parse an ICU message. Never throws; a malformed message yields diagnostics
 * plus best-effort tokens for whatever did parse.
 */
/**
 * How a span reads once ICU's quoting is resolved, or undefined when it reads
 * as written. Two rules cover it: a doubled apostrophe is one literal
 * apostrophe, and a quoted run is its contents with the quotes dropped — that
 * is how `'{0}'` puts a literal brace on screen. Resolving these for DISPLAY
 * only keeps the underlying value byte-exact, so editing still round-trips.
 */
function rendered(kind: IcuTokenKind, text: string): string | undefined {
  if (kind === "text") {
    return text.includes("''") ? text.replace(/''/g, "'") : undefined;
  }
  if (kind === "quoted") {
    let inner = text.startsWith("'") ? text.slice(1) : text;
    if (inner.endsWith("'") && !inner.endsWith("''")) inner = inner.slice(0, -1);
    return inner.replace(/''/g, "'");
  }
  return undefined;
}

export function parseIcu(value: string): IcuParse {
  const tokens: IcuToken[] = [];
  const errors: IcuDiagnostic[] = [];
  const args: IcuArgument[] = [];
  let i = 0;

  const push = (kind: IcuTokenKind, start: number, end: number, depth: number) => {
    if (end <= start) return;
    const text = value.slice(start, end);
    tokens.push({ text, kind, depth, start, display: rendered(kind, text) });
  };
  const text = (start: number, end: number, depth: number) =>
    push("text", start, end, depth);
  const fail = (message: string, start: number, end: number) => {
    errors.push({ message, start, end: Math.max(end, start + 1) });
  };
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  /** Consume whitespace, keeping it in the token stream as plain text. */
  const space = (depth: number) => {
    const start = i;
    while (i < value.length && isSpace(value[i])) i++;
    text(start, i, depth);
  };
  /** Read a bare word up to whitespace, a comma or a brace. */
  const word = (): string => {
    const start = i;
    while (i < value.length && !/[,{}\s]/.test(value[i])) i++;
    return value.slice(start, i);
  };
  /** After a syntax error: swallow through to the brace that closes us. */
  const recover = (depth: number) => {
    const start = i;
    let level = 1;
    while (i < value.length && level > 0) {
      if (value[i] === "{") level++;
      else if (value[i] === "}") level--;
      i++;
    }
    text(start, i, depth);
  };

  /**
   * Message text at `depth`. Returns at the `}` that closes the enclosing
   * branch (left unconsumed for the caller) or at end of input.
   * `inPlural` enables `#`, which only means "the count" inside a plural.
   */
  function parseMessage(depth: number, inPlural: boolean): void {
    let start = i;
    while (i < value.length) {
      const c = value[i];

      if (c === "'") {
        const next = value[i + 1];
        // '' is a literal apostrophe; a quote before syntax opens a literal run.
        if (next === "'") {
          i += 2;
          continue;
        }
        if (next === "{" || next === "}" || (inPlural && next === "#")) {
          text(start, i, depth);
          const quoteStart = i;
          i += 2;
          while (i < value.length) {
            if (value[i] === "'") {
              if (value[i + 1] === "'") {
                i += 2;
                continue;
              }
              i++;
              break;
            }
            i++;
          }
          push("quoted", quoteStart, i, depth);
          start = i;
          continue;
        }
        i++;
        continue;
      }

      if (c === "#" && inPlural) {
        text(start, i, depth);
        push("hash", i, i + 1, depth);
        i++;
        start = i;
        continue;
      }

      if (c === "}") {
        text(start, i, depth);
        if (depth === 0) {
          fail("Stray '}' — escape it as '}' if you meant the character.", i, i + 1);
          push("brace", i, i + 1, depth);
          i++;
          start = i;
          continue;
        }
        return;
      }

      if (c === "{") {
        text(start, i, depth);
        parseArgument(depth);
        start = i;
        continue;
      }

      i++;
    }
    text(start, i, depth);
  }

  /** A `{…}` placeholder, starting at the `{`. */
  function parseArgument(depth: number): void {
    const open = i;
    push("brace", i, i + 1, depth);
    i++;
    space(depth);

    const nameStart = i;
    const name = word();
    if (name === "") {
      fail("This placeholder has no name.", open, i + 1);
    } else {
      push("arg", nameStart, i, depth);
    }
    space(depth);

    if (value[i] === "}") {
      push("brace", i, i + 1, depth);
      i++;
      if (name) args.push({ name, type: "none" });
      return;
    }
    if (value[i] !== ",") {
      fail(
        i >= value.length
          ? "Unclosed placeholder — add the missing '}'."
          : "Expected ',' or '}' after the placeholder name.",
        open,
        i + 1
      );
      recover(depth);
      return;
    }

    push("comma", i, i + 1, depth);
    i++;
    space(depth);

    const typeStart = i;
    const type = word();
    push("type", typeStart, i, depth);
    if (name) args.push({ name, type });
    if (!ARG_TYPES.includes(type)) {
      fail(
        `Unknown placeholder type ${type ? `"${type}"` : ""}`.trim() +
          ` — expected ${ARG_TYPES.join(", ")}.`,
        typeStart,
        i
      );
      // We don't know whether a style or branches follow, so skip the whole
      // placeholder rather than mis-parse it into a second, bogus error.
      recover(depth);
      return;
    }
    space(depth);

    if (hasBranches(type)) {
      if (value[i] !== ",") {
        fail(
          `"${type}" needs branches, e.g. {${name || "count"}, ${type}, other {…}}.`,
          open,
          Math.max(i, open + 1)
        );
        recover(depth);
        return;
      }
      push("comma", i, i + 1, depth);
      i++;
      parseBranches(depth, type, open);
      return;
    }

    // A styled argument: `{when, date, short}`. The style runs to the close.
    if (value[i] === ",") {
      push("comma", i, i + 1, depth);
      i++;
      const styleStart = i;
      while (i < value.length && value[i] !== "}") i++;
      push("key", styleStart, i, depth);
    }
    if (value[i] === "}") {
      push("brace", i, i + 1, depth);
      i++;
      return;
    }
    fail("Unclosed placeholder — add the missing '}'.", open, value.length);
  }

  /** The `selector {message}` list of a plural / selectordinal / select. */
  function parseBranches(depth: number, type: string, open: number): void {
    const seen = new Set<string>();
    let hasOther = false;

    for (;;) {
      space(depth);
      if (i >= value.length) {
        fail("Unclosed placeholder — add the missing '}'.", open, value.length);
        return;
      }
      if (value[i] === "}") {
        push("brace", i, i + 1, depth);
        i++;
        break;
      }

      const selStart = i;
      while (i < value.length && !/[{}\s]/.test(value[i])) i++;
      const selector = value.slice(selStart, i);
      if (selector === "") {
        fail("Expected a branch name here.", i, i + 1);
        recover(depth);
        return;
      }

      // `offset:N` shifts the number `#` prints; it isn't a branch.
      if (selector.startsWith("offset:")) {
        push("offset", selStart, i, depth);
        if (!/^offset:-?\d+$/.test(selector)) {
          fail("'offset:' needs a whole number, e.g. offset:1.", selStart, i);
        } else if (type === "select") {
          fail("'offset:' only applies to plural and selectordinal.", selStart, i);
        }
        continue;
      }

      push("key", selStart, i, depth);
      if (type !== "select") {
        if (selector.startsWith("=")) {
          if (!/^=\d+$/.test(selector)) {
            fail(
              `Exact match "${selector}" must be '=' followed by a whole number.`,
              selStart,
              i
            );
          }
        } else if (!PLURAL_KEYS.includes(selector)) {
          fail(
            `Unknown plural branch "${selector}" — use ${PLURAL_KEYS.join(
              ", "
            )} or "=N".`,
            selStart,
            i
          );
        }
      }
      if (seen.has(selector)) {
        fail(`Duplicate branch "${selector}".`, selStart, i);
      }
      seen.add(selector);
      if (selector === "other") hasOther = true;

      space(depth);
      if (value[i] !== "{") {
        fail(`Branch "${selector}" needs a {…} message.`, selStart, i + 1);
        recover(depth);
        return;
      }
      push("brace", i, i + 1, depth + 1);
      i++;
      parseMessage(depth + 1, type !== "select");
      if (value[i] === "}") {
        push("brace", i, i + 1, depth + 1);
        i++;
      } else {
        fail(`Branch "${selector}" is missing its closing '}'.`, selStart, value.length);
        return;
      }
    }

    if (!hasOther) {
      // Without it ICU throws for any value no other branch matches.
      fail(`"${type}" needs an "other" branch as its fallback.`, open, i);
    }
  }

  parseMessage(0, false);
  return { tokens, errors, args };
}

// Values are re-parsed on every render of a visible row, so keep the last few
// hundred results. Bounded rather than growing: catalogs run to thousands of
// strings and only the visible window matters.
const CACHE_LIMIT = 600;
const cache = new Map<string, IcuParse>();

/** {@link parseIcu}, memoized. */
export function icu(value: string): IcuParse {
  const hit = cache.get(value);
  if (hit) return hit;
  const parsed = parseIcu(value);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(value, parsed);
  return parsed;
}

/** Syntax errors in a value, or [] when it isn't an ICU message. */
export function icuErrors(value: string): IcuDiagnostic[] {
  if (!looksLikeIcu(value)) return [];
  return icu(value).errors;
}

export interface IcuArgumentDiff {
  ok: boolean;
  /** Placeholders the source has and the translation doesn't. */
  missing: string[];
  /** Placeholders the translation invented. */
  extra: string[];
  /** Placeholders whose type changed, e.g. a plural flattened to a bare value. */
  retyped: string[];
}

function argMap(value: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!looksLikeIcu(value)) return out;
  for (const arg of icu(value).args) {
    // First declaration wins: a name repeated across branches is the same
    // argument, and the outermost one carries the type.
    if (!out.has(arg.name)) out.set(arg.name, arg.type);
  }
  return out;
}

/**
 * Compare the placeholders of a source message and its translation. A dropped
 * `{name}` formats as a gap in the sentence; a plural flattened to a bare value
 * loses agreement — both are worth a warning, neither blocks saving.
 */
export function diffIcuArguments(
  source: string,
  target: string
): IcuArgumentDiff {
  const from = argMap(source);
  const to = argMap(target);
  const missing: string[] = [];
  const extra: string[] = [];
  const retyped: string[] = [];

  for (const [name, type] of from) {
    if (!to.has(name)) {
      missing.push(`{${name}}`);
    } else if (to.get(name) !== type) {
      retyped.push(`{${name}}: ${type} → ${to.get(name)}`);
    }
  }
  for (const name of to.keys()) {
    if (!from.has(name)) extra.push(`{${name}}`);
  }

  return {
    ok: missing.length === 0 && extra.length === 0 && retyped.length === 0,
    missing,
    extra,
    retyped,
  };
}
