// Surgical editing engine for .xcstrings.
//
// Core principle (see the architecture-decisions memory): do NOT re-serialize
// the whole file. Reason: Xcode's `strings` key order uses a comparator that
// matches no standard sort — re-sorting would dirty the diff or shuffle keys.
// Instead we only:
//   - replace the exact span of an existing "value"/"state", or
//   - insert a "<lang>" : { stringUnit … } block at the correct position
//     (language codes sort by code unit — verified to match Xcode 100% on the
//     real file).
// Every other byte stays untouched ⇒ minimal git diff.
//
// The output must match Xcode (Foundation, measured on the real file):
//   - colon as " : " (space on both sides)
//   - 2-space indent, EOL from the document (CRLF/LF)
//   - slash '/' written raw (no \/), non-ASCII written raw → JSON.stringify
//     already matches all three.

import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  type Node,
} from "jsonc-parser";

/** A single offset-based replacement (the host turns it into a vscode.Range). */
export interface TextReplace {
  offset: number;
  length: number;
  newText: string;
}

export interface EditContext {
  /** "\r\n" or "\n", taken from document.eol. */
  eol: string;
  /** Indent unit, defaults to 2 spaces (xcstrings always uses 2 spaces). */
  indentUnit?: string;
}

export interface EditResult {
  edits: TextReplace[];
  /** Reason if no edit could be produced (the cell stays unchanged). */
  reason?: string;
}

/**
 * Stringify the way Xcode writes values: raw slashes, raw non-ASCII, standard
 * JSON control-char escapes. JSON.stringify already does all three (it does not
 * escape '/' nor non-ASCII).
 */
function jsonString(s: string): string {
  return JSON.stringify(s);
}

/** Leading whitespace of the line containing `offset` (handles CRLF and LF). */
function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let i = lineStart;
  let ws = "";
  while (i < text.length && (text[i] === " " || text[i] === "\t")) {
    ws += text[i];
    i++;
  }
  return ws;
}

/**
 * Set the translation for (key, lang) at a SINGLE stringUnit (no variations).
 * - empty value + existing slot → keep the slot, value "", state "new".
 * - empty value + missing slot  → do nothing (don't insert an empty translation).
 * - non-empty value → state "translated".
 */
export function setTranslation(
  text: string,
  key: string,
  lang: string,
  segments: string[],
  value: string,
  ctx: EditContext
): EditResult {
  const root = parseTree(text);
  if (!root) return { edits: [], reason: "JSON could not be parsed" };

  const indentUnit = ctx.indentUnit ?? "  ";
  const isEmpty = value.trim() === "";
  const newState = isEmpty ? "new" : "translated";

  // `segments` is the relative jsonc path to the variation node (e.g.
  // ["variations","plural","one"] or ["substitutions","count","variations",
  // "plural","one"]); [] is the base stringUnit.
  const base = [
    "strings",
    key,
    "localizations",
    lang,
    ...segments,
    "stringUnit",
  ];

  const unitNode = findNodeAtLocation(root, base);
  if (unitNode) {
    return replaceExisting(text, root, base, value, newState, ctx);
  }

  if (isEmpty) return { edits: [] };

  const locNode = findNodeAtLocation(root, ["strings", key, "localizations"]);
  if (!locNode || locNode.type !== "object") {
    return {
      edits: [],
      reason: "key has no 'localizations' yet — creating one is not supported yet",
    };
  }

  // Simple cell → the verified single-stringUnit insert. Variant cell → build
  // the smallest missing subtree along the variations path.
  if (segments.length === 0) {
    return {
      edits: [insertLanguage(text, locNode, lang, value, ctx, indentUnit)],
    };
  }
  return insertCell(text, locNode, lang, segments, value, ctx, indentUnit);
}

function replaceExisting(
  text: string,
  root: Node,
  base: string[],
  value: string,
  newState: string,
  ctx: EditContext
): EditResult {
  const valueNode = findNodeAtLocation(root, [...base, "value"]);
  const stateNode = findNodeAtLocation(root, [...base, "state"]);

  const edits: TextReplace[] = [];

  if (valueNode) {
    edits.push({
      offset: valueNode.offset,
      length: valueNode.length,
      newText: jsonString(value),
    });
  } else if (stateNode) {
    // stringUnit has a state but no value → insert "value" after "state".
    const indent = lineIndentAt(text, stateNode.offset);
    const at = stateNode.offset + stateNode.length;
    edits.push({
      offset: at,
      length: 0,
      newText: `,${ctx.eol}${indent}"value" : ${jsonString(value)}`,
    });
  } else {
    return { edits: [], reason: "stringUnit has neither state nor value" };
  }

  if (stateNode) {
    edits.push({
      offset: stateNode.offset,
      length: stateNode.length,
      newText: jsonString(newState),
    });
  }

  return { edits };
}

/**
 * Insert a new language block into the localizations object at the correct
 * code-unit position.
 */
function insertLanguage(
  text: string,
  locNode: Node,
  lang: string,
  value: string,
  ctx: EditContext,
  indentUnit: string
): TextReplace {
  const eol = ctx.eol;
  const parentIndent = lineIndentAt(text, locNode.offset); // the `"localizations" : {` line
  const baseIndent = parentIndent + indentUnit; // where `"<lang>"` goes

  const block = renderLangBlock(lang, value, baseIndent, eol, indentUnit);

  const props = (locNode.children ?? []).filter((c) => c.type === "property");
  const entries = props.map((p) => ({
    name: String(p.children![0].value),
    node: p,
  }));

  // Empty object — `{}` or Xcode's `{` + blank line + `}`. Replace everything
  // BETWEEN the braces so the existing filler doesn't survive as a blank line.
  if (entries.length === 0) {
    const open = locNode.offset + 1;
    const close = locNode.offset + locNode.length - 1;
    return {
      offset: open,
      length: Math.max(0, close - open),
      newText: `${eol}${baseIndent}${block}${eol}${parentIndent}`,
    };
  }

  // Find the insert position by code-unit order of the language code.
  let insertBefore: Node | null = null;
  for (const e of entries) {
    if (lang < e.name) {
      insertBefore = e.node;
      break;
    }
  }

  if (insertBefore) {
    // Insert right before this property (the "baseIndent" already precedes it).
    return {
      offset: insertBefore.offset,
      length: 0,
      newText: `${block},${eol}${baseIndent}`,
    };
  }

  // Sorts after everything → insert after the last property (no trailing comma).
  const last = entries[entries.length - 1].node;
  return {
    offset: last.offset + last.length,
    length: 0,
    newText: `,${eol}${baseIndent}${block}`,
  };
}

/** Render `"<lang>" : { "stringUnit" : { "state"…, "value"… } }`. */
function renderLangBlock(
  lang: string,
  value: string,
  baseIndent: string,
  eol: string,
  indentUnit: string
): string {
  const i1 = baseIndent + indentUnit;
  const i2 = i1 + indentUnit;
  return (
    `${jsonString(lang)} : {` +
    eol +
    `${i1}"stringUnit" : {` +
    eol +
    `${i2}"state" : "translated",` +
    eol +
    `${i2}"value" : ${jsonString(value)}` +
    eol +
    `${i1}}` +
    eol +
    `${baseIndent}}`
  );
}

// ---- Variations (plural / device) & substitutions ----
//
// A variant/substitution cell lives at localizations/<lang>/<segments…>/
// stringUnit, where `segments` is the relative jsonc path: e.g.
// ["variations","plural","one"] or
// ["substitutions","count","variations","plural","one"]. We edit an existing
// stringUnit the same way as a simple one (replaceExisting), and create a
// missing one by inserting the SMALLEST missing subtree at code-unit order —
// the same ordering rule verified for language codes (plural cases / device
// names are ASCII, so code-unit == Xcode's sorted keys).

/**
 * Render the JSON value text for a single nested path ending in a stringUnit.
 * `chain` is the property names from the inserted node down to "stringUnit";
 * `indent` is the indentation of the property this value is attached to.
 */
function renderChainValue(
  chain: string[],
  value: string,
  indent: string,
  eol: string,
  indentUnit: string
): string {
  const i1 = indent + indentUnit;
  if (chain.length === 1) {
    // chain[0] === "stringUnit" → { "state" …, "value" … }
    return (
      `{${eol}${i1}"state" : "translated",` +
      `${eol}${i1}"value" : ${jsonString(value)}${eol}${indent}}`
    );
  }
  const childKey = chain[1];
  const childVal = renderChainValue(chain.slice(1), value, i1, eol, indentUnit);
  return `{${eol}${i1}${jsonString(childKey)} : ${childVal}${eol}${indent}}`;
}

/**
 * Create a variant cell for a target language. Walks from `localizations` down
 * the variant path, then inserts the smallest missing subtree. Declines (with a
 * reason, no edit) when a shape conflict would otherwise produce invalid JSON.
 */
function insertCell(
  text: string,
  locNode: Node,
  lang: string,
  segments: string[],
  value: string,
  ctx: EditContext,
  indentUnit: string
): EditResult {
  const chain = [lang, ...segments, "stringUnit"];

  let container = locNode;
  let i = 0;
  while (i < chain.length) {
    const prop = findProperty(container, chain[i]);
    if (!prop) break;
    const v = propValue(prop);
    if (v.type !== "object") {
      return {
        edits: [],
        reason: `cannot edit variant: '${chain[i]}' is not an object`,
      };
    }
    container = v;
    i++;
  }

  // stringUnit already present → the caller routes those to replaceExisting; a
  // concurrent edit could land here, so just do nothing.
  if (i === chain.length) return { edits: [] };

  // A localization is EITHER a stringUnit OR variations, never both.
  if (chain[i] === "variations" && findProperty(container, "stringUnit")) {
    return {
      edits: [],
      reason: "this language has a plain value for the key; cannot add variations",
    };
  }

  // Substitutions carry required metadata (formatSpecifier/argNum) we cannot
  // synthesize. Only FILL an existing one: allow inserting just the leaf case
  // (i === segments.length) or its stringUnit; decline if an ancestor above the
  // case (the substitution itself, its name, or its variations) is missing.
  if (segments.includes("substitutions") && i < segments.length) {
    return {
      edits: [],
      reason:
        "no such substitution in this language yet — add the language in Xcode first",
    };
  }

  const baseIndent = lineIndentAt(text, container.offset) + indentUnit;
  const valueText = renderChainValue(
    chain.slice(i),
    value,
    baseIndent,
    ctx.eol,
    indentUnit
  );
  return {
    edits: [insertProperty(text, container, chain[i], valueText, ctx, indentUnit)],
  };
}

// ---- String-level config: comment, shouldTranslate, per-cell state ----
//
// These edit object properties rather than translation values. Xcode writes
// every object's keys in code-unit (alphabetical) order, so within a string
// entry the order is: comment < extractionState < localizations <
// shouldTranslate, and within a stringUnit: state < value. We insert each new
// property at its correct slot so the diff stays clean and Xcode won't reshuffle
// it on the next save.

/** Find a direct property node by name in an object node, or null. */
function findProperty(objNode: Node, name: string): Node | null {
  for (const c of objNode.children ?? []) {
    if (
      c.type === "property" &&
      c.children &&
      String(c.children[0].value) === name
    ) {
      return c;
    }
  }
  return null;
}

/** The value node of a property (its `children[1]`). */
function propValue(prop: Node): Node {
  return prop.children![1];
}

/**
 * Insert `"name" : <valueText>` into `objNode`. `placement` defaults to
 * code-unit order among the existing keys (the order Xcode writes every object
 * in); `"end"` appends instead, for the one object whose order is not sorted —
 * the `strings` table itself. Mirrors {@link insertLanguage} but for arbitrary
 * properties.
 */
function insertProperty(
  text: string,
  objNode: Node,
  name: string,
  valueText: string,
  ctx: EditContext,
  indentUnit: string,
  placement: "code-unit" | "end" = "code-unit"
): TextReplace {
  const eol = ctx.eol;
  const parentIndent = lineIndentAt(text, objNode.offset); // the `… : {` line
  const baseIndent = parentIndent + indentUnit; // where the property goes
  const block = `${jsonString(name)} : ${valueText}`;

  const props = (objNode.children ?? []).filter((c) => c.type === "property");

  // Empty object — `{}` or Xcode's `{` + blank line + `}`. Replace everything
  // BETWEEN the braces so the existing filler doesn't survive as a blank line.
  if (props.length === 0) {
    const open = objNode.offset + 1;
    const close = objNode.offset + objNode.length - 1;
    return {
      offset: open,
      length: Math.max(0, close - open),
      newText: `${eol}${baseIndent}${block}${eol}${parentIndent}`,
    };
  }

  let insertBefore: Node | null = null;
  if (placement === "code-unit") {
    for (const p of props) {
      if (name < String(p.children![0].value)) {
        insertBefore = p;
        break;
      }
    }
  }

  if (insertBefore) {
    return {
      offset: insertBefore.offset,
      length: 0,
      newText: `${block},${eol}${baseIndent}`,
    };
  }

  // Sorts after everything → append after the last property.
  const last = props[props.length - 1];
  return {
    offset: last.offset + last.length,
    length: 0,
    newText: `,${eol}${baseIndent}${block}`,
  };
}

/**
 * Remove one or more named properties from `objNode`, fixing the surrounding
 * commas so the JSON stays valid. Consecutive removals are collapsed into a
 * single span — removing them one by one would produce overlapping edits
 * whenever a run reaches the last property.
 */
function removeProperties(
  text: string,
  objNode: Node,
  names: ReadonlySet<string>,
  ctx?: EditContext
): TextReplace[] {
  const props = (objNode.children ?? []).filter((c) => c.type === "property");
  const drop = props.map((p) => names.has(String(p.children![0].value)));
  if (!drop.some(Boolean)) return [];

  // Everything goes → empty the object out. Xcode writes an emptied object as
  // a blank line between the braces, so match that when we know the EOL.
  if (drop.every(Boolean)) {
    const open = objNode.offset; // at '{'
    const close = objNode.offset + objNode.length - 1; // at '}'
    const filler = ctx ? `${ctx.eol}${ctx.eol}${lineIndentAt(text, open)}` : "";
    return [{ offset: open + 1, length: close - (open + 1), newText: filler }];
  }

  const out: TextReplace[] = [];
  let i = 0;
  while (i < props.length) {
    if (!drop[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < props.length && drop[j + 1]) j++;
    if (j < props.length - 1) {
      // Run is followed by a survivor → swallow it plus its trailing comma and
      // indent, up to where the next kept property starts.
      const next = props[j + 1];
      out.push({
        offset: props[i].offset,
        length: next.offset - props[i].offset,
        newText: "",
      });
    } else {
      // Run ends the object → swallow the comma that precedes it instead.
      const prev = props[i - 1];
      const start = prev.offset + prev.length;
      const end = props[j].offset + props[j].length;
      out.push({ offset: start, length: end - start, newText: "" });
    }
    i = j + 1;
  }
  return out;
}

/**
 * Remove the named property from `objNode`, fixing the surrounding comma so the
 * JSON stays valid. Returns null if the property isn't present.
 */
function removeProperty(
  text: string,
  objNode: Node,
  name: string,
  ctx?: EditContext
): TextReplace | null {
  const edits = removeProperties(text, objNode, new Set([name]), ctx);
  return edits[0] ?? null;
}

function findKeyObject(root: Node, key: string): Node | null {
  const node = findNodeAtLocation(root, ["strings", key]);
  return node && node.type === "object" ? node : null;
}

/**
 * Set (or clear) the developer comment / note for a key. An empty/whitespace
 * comment removes the property entirely (Xcode drops empty comments).
 */
export function setComment(
  text: string,
  key: string,
  comment: string,
  ctx: EditContext
): EditResult {
  const root = parseTree(text);
  if (!root) return { edits: [], reason: "JSON could not be parsed" };
  const indentUnit = ctx.indentUnit ?? "  ";

  const keyNode = findKeyObject(root, key);
  if (!keyNode) return { edits: [], reason: `key not found: ${key}` };

  const existing = findProperty(keyNode, "comment");

  if (comment.trim() === "") {
    if (!existing) return { edits: [] };
    const rem = removeProperty(text, keyNode, "comment", ctx);
    return { edits: rem ? [rem] : [] };
  }

  if (existing) {
    const v = propValue(existing);
    return {
      edits: [{ offset: v.offset, length: v.length, newText: jsonString(comment) }],
    };
  }
  return {
    edits: [insertProperty(text, keyNode, "comment", jsonString(comment), ctx, indentUnit)],
  };
}

/**
 * Toggle whether a key should be translated. `true` is the default, so it is
 * expressed by REMOVING the property; `false` writes `"shouldTranslate" : false`.
 */
export function setShouldTranslate(
  text: string,
  key: string,
  value: boolean,
  ctx: EditContext
): EditResult {
  const root = parseTree(text);
  if (!root) return { edits: [], reason: "JSON could not be parsed" };
  const indentUnit = ctx.indentUnit ?? "  ";

  const keyNode = findKeyObject(root, key);
  if (!keyNode) return { edits: [], reason: `key not found: ${key}` };

  const existing = findProperty(keyNode, "shouldTranslate");

  if (value) {
    // Default → represented by absence.
    if (!existing) return { edits: [] };
    const rem = removeProperty(text, keyNode, "shouldTranslate", ctx);
    return { edits: rem ? [rem] : [] };
  }

  if (existing) {
    const v = propValue(existing);
    return { edits: [{ offset: v.offset, length: v.length, newText: "false" }] };
  }
  return {
    edits: [insertProperty(text, keyNode, "shouldTranslate", "false", ctx, indentUnit)],
  };
}

/** Build the jsonc location path to a cell's stringUnit. `segments` is the
 * relative path to the variation node (variations and/or substitutions). */
function unitPath(key: string, lang: string, segments: string[]): string[] {
  return ["strings", key, "localizations", lang, ...segments, "stringUnit"];
}

/**
 * Set the review state of a single cell (no value change). `segments` is the
 * variant path ([] for a plain stringUnit). The stringUnit must already exist
 * (you can't mark an absent translation).
 */
export function setState(
  text: string,
  key: string,
  lang: string,
  segments: string[],
  state: string,
  ctx: EditContext
): EditResult {
  const root = parseTree(text);
  if (!root) return { edits: [], reason: "JSON could not be parsed" };
  const indentUnit = ctx.indentUnit ?? "  ";

  const base = unitPath(key, lang, segments);
  const unitNode = findNodeAtLocation(root, base);
  if (!unitNode || unitNode.type !== "object") {
    return { edits: [], reason: "no stringUnit for this cell" };
  }

  const stateNode = findNodeAtLocation(root, [...base, "state"]);
  if (stateNode) {
    return {
      edits: [{ offset: stateNode.offset, length: stateNode.length, newText: jsonString(state) }],
    };
  }
  // No state yet → insert before "value" (state < value).
  return {
    edits: [insertProperty(text, unitNode, "state", jsonString(state), ctx, indentUnit)],
  };
}

/** Apply TextReplaces to a string (handy for tests / host fallback). */
export function applyReplaces(text: string, edits: TextReplace[]): string {
  const sorted = [...edits].sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.offset) + e.newText + out.slice(e.offset + e.length);
  }
  return out;
}

// ---- Xcode-style JSON rendering (used when whole sub-objects are created) ----
//
// Single-value edits above splice text directly, but adding a string or a
// language creates entire nodes. Those are rendered here so a hand-added block
// is byte-identical to one Xcode would have written: " : " between key and
// value, 2-space indent, object keys in code-unit order, and — an Xcode quirk
// worth matching — an empty object written as a blank line between its braces.

/** JSON value in the shape Xcode writes into a String Catalog. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/**
 * Render `value` as Xcode would, with `indent` as the indentation of the line
 * the value starts on (i.e. its closing brace lines up with `indent`).
 */
export function renderJsonValue(
  value: JsonValue,
  indent: string,
  eol: string,
  indentUnit = "  "
): string {
  if (typeof value === "string") return jsonString(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  const inner = indent + indentUnit;

  if (Array.isArray(value)) {
    if (value.length === 0) return `[${eol}${eol}${indent}]`;
    const items = value.map(
      (v) => `${inner}${renderJsonValue(v, inner, eol, indentUnit)}`
    );
    return `[${eol}${items.join(`,${eol}`)}${eol}${indent}]`;
  }

  // Code-unit key order — the order Xcode writes every object in.
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  if (keys.length === 0) return `{${eol}${eol}${indent}}`;
  const props = keys.map(
    (k) =>
      `${inner}${jsonString(k)} : ${renderJsonValue(
        value[k] as JsonValue,
        inner,
        eol,
        indentUnit
      )}`
  );
  return `{${eol}${props.join(`,${eol}`)}${eol}${indent}}`;
}

// ---- Adding & removing strings ----

/** The `strings` table node, or null when this isn't a String Catalog. */
function findStringsTable(root: Node): Node | null {
  const node = findNodeAtLocation(root, ["strings"]);
  return node && node.type === "object" ? node : null;
}

/**
 * Add a new key to the catalog.
 *
 * The key goes at the END of the `strings` table rather than in sorted position:
 * Xcode's own key order follows a comparator that matches no standard sort, so
 * there is no "correct" slot to insert into — appending keeps the diff to a
 * single added block and Xcode re-files it on its next write.
 *
 * The entry is marked `extractionState: "manual"`, which is what Xcode writes
 * for a hand-added string; it is also what makes the string removable again
 * (an automatically extracted key would just come back on the next build).
 */
export function addString(
  text: string,
  key: string,
  ctx: EditContext
): EditResult {
  const root = parseTree(text);
  if (!root) return { edits: [], reason: "JSON could not be parsed" };
  const indentUnit = ctx.indentUnit ?? "  ";

  const stringsNode = findStringsTable(root);
  if (!stringsNode) {
    return { edits: [], reason: "this file has no 'strings' table" };
  }
  if (findProperty(stringsNode, key)) {
    return { edits: [], reason: `the key "${key}" already exists` };
  }

  const indent = lineIndentAt(text, stringsNode.offset) + indentUnit;
  const valueText = renderJsonValue(
    { extractionState: "manual" },
    indent,
    ctx.eol,
    indentUnit
  );
  return {
    edits: [
      insertProperty(text, stringsNode, key, valueText, ctx, indentUnit, "end"),
    ],
  };
}

/** Delete whole keys (with every localization) from the catalog. */
export function removeStrings(
  text: string,
  keys: string[],
  ctx: EditContext
): EditResult {
  const root = parseTree(text);
  if (!root) return { edits: [], reason: "JSON could not be parsed" };

  const stringsNode = findStringsTable(root);
  if (!stringsNode) {
    return { edits: [], reason: "this file has no 'strings' table" };
  }
  const edits = removeProperties(text, stringsNode, new Set(keys), ctx);
  if (edits.length === 0) {
    return { edits: [], reason: "no such key in this catalog" };
  }
  return { edits };
}

// ---- Adding & removing languages ----

/**
 * Build the localization node for a language that has nothing translated yet.
 * The shape is cloned from `template` (the source language's node for the same
 * key) so plural / device variants and substitutions line up; every leaf value
 * is emptied and marked `new`. Substitution metadata (`formatSpecifier`,
 * `argNum`) is copied verbatim because it cannot be synthesized.
 */
function emptyLocalization(template: unknown): JsonValue {
  const blank: JsonValue = { stringUnit: { state: "new", value: "" } };
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    return blank;
  }
  const node = template as Record<string, unknown>;
  const out: { [key: string]: JsonValue } = {};

  if (node.formatSpecifier !== undefined) {
    out.formatSpecifier = node.formatSpecifier as JsonValue;
  }
  if (node.argNum !== undefined) out.argNum = node.argNum as JsonValue;
  if (node.stringUnit) out.stringUnit = { state: "new", value: "" };

  const variations = node.variations as Record<string, unknown> | undefined;
  if (variations) {
    const dims: { [key: string]: JsonValue } = {};
    for (const [dimension, cases] of Object.entries(variations)) {
      if (!cases || typeof cases !== "object") continue;
      const forms: { [key: string]: JsonValue } = {};
      for (const [name, sub] of Object.entries(
        cases as Record<string, unknown>
      )) {
        forms[name] = emptyLocalization(sub);
      }
      dims[dimension] = forms;
    }
    out.variations = dims;
  }

  const substitutions = node.substitutions as Record<string, unknown> | undefined;
  if (substitutions) {
    const subs: { [key: string]: JsonValue } = {};
    for (const [name, sub] of Object.entries(substitutions)) {
      subs[name] = emptyLocalization(sub);
    }
    out.substitutions = subs;
  }

  // A node with neither a value nor variants would render as an empty object,
  // which is not a localization — fall back to a plain empty string unit.
  if (!out.stringUnit && !out.variations && !out.substitutions) return blank;
  return out;
}

/**
 * Add a language to every key in the catalog, with an empty `new` string unit
 * per translatable leaf — the same thing Xcode writes when you add a language,
 * so the file round-trips through Xcode without a reformat. Keys that already
 * carry the language are left alone.
 */
export function addLanguage(
  text: string,
  lang: string,
  ctx: EditContext
): EditResult {
  const root = parseTree(text);
  if (!root) return { edits: [], reason: "JSON could not be parsed" };
  const indentUnit = ctx.indentUnit ?? "  ";

  const stringsNode = findStringsTable(root);
  if (!stringsNode) {
    return { edits: [], reason: "this file has no 'strings' table" };
  }
  const sourceNode = findNodeAtLocation(root, ["sourceLanguage"]);
  const sourceLanguage =
    typeof sourceNode?.value === "string" ? sourceNode.value : "";

  const edits: TextReplace[] = [];
  for (const prop of stringsNode.children ?? []) {
    if (prop.type !== "property" || !prop.children) continue;
    const keyObj = prop.children[1];
    if (keyObj.type !== "object") continue;

    const locProp = findProperty(keyObj, "localizations");
    if (!locProp) {
      // No localizations at all yet → create the whole property.
      const indent = lineIndentAt(text, keyObj.offset) + indentUnit;
      const valueText = renderJsonValue(
        { [lang]: emptyLocalization(undefined) },
        indent,
        ctx.eol,
        indentUnit
      );
      edits.push(
        insertProperty(text, keyObj, "localizations", valueText, ctx, indentUnit)
      );
      continue;
    }

    const locObj = propValue(locProp);
    if (locObj.type !== "object") continue;
    if (findProperty(locObj, lang)) continue;

    const template = sourceLanguage
      ? findProperty(locObj, sourceLanguage)
      : null;
    const shape = emptyLocalization(
      template ? getNodeValue(propValue(template)) : undefined
    );
    const indent = lineIndentAt(text, locObj.offset) + indentUnit;
    const valueText = renderJsonValue(shape, indent, ctx.eol, indentUnit);
    edits.push(insertProperty(text, locObj, lang, valueText, ctx, indentUnit));
  }

  if (edits.length === 0) {
    return { edits: [], reason: `${lang} is already in this catalog` };
  }
  return { edits };
}

/**
 * Remove a language from every key. Callers are expected to have checked that
 * the language has nothing translated (see `languageIsEmpty`) — this only does
 * the edit. A key left with no localizations at all loses the now-empty
 * `localizations` property too, which is how Xcode writes such a key.
 */
export function removeLanguage(
  text: string,
  lang: string,
  ctx: EditContext
): EditResult {
  const root = parseTree(text);
  if (!root) return { edits: [], reason: "JSON could not be parsed" };

  const stringsNode = findStringsTable(root);
  if (!stringsNode) {
    return { edits: [], reason: "this file has no 'strings' table" };
  }

  const edits: TextReplace[] = [];
  for (const prop of stringsNode.children ?? []) {
    if (prop.type !== "property" || !prop.children) continue;
    const keyObj = prop.children[1];
    if (keyObj.type !== "object") continue;

    const locProp = findProperty(keyObj, "localizations");
    if (!locProp) continue;
    const locObj = propValue(locProp);
    if (locObj.type !== "object") continue;
    if (!findProperty(locObj, lang)) continue;

    const remaining = (locObj.children ?? []).filter(
      (c) => c.type === "property"
    ).length;
    if (remaining <= 1) {
      const rem = removeProperty(text, keyObj, "localizations", ctx);
      if (rem) edits.push(rem);
    } else {
      const rem = removeProperty(text, locObj, lang, ctx);
      if (rem) edits.push(rem);
    }
  }

  if (edits.length === 0) {
    return { edits: [], reason: `${lang} is not in this catalog` };
  }
  return { edits };
}
