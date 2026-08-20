import { useEffect, useRef, useState } from "react";
import type { LangProgress } from "../src/shared/progress";
import { ChevronDownIcon, PlusIcon, TrashIcon } from "./icons";
import { langName } from "../src/shared/langName";

interface LanguagePickerProps {
  /** Source language (always shown, cannot be turned off). */
  source: string;
  /** All available target languages (source already removed). */
  available: string[];
  /** Target languages currently shown. */
  selected: string[];
  /** Translation progress per language (for the inline bars). */
  progress: Record<string, LangProgress>;
  onChange(next: string[]): void;
  /** Whether this file's languages can be added to / removed from here. */
  canManage: boolean;
  /** Ask the host to add a language (it prompts for the tag). */
  onAddLanguage(): void;
  /** Ask the host to remove a language (it confirms). */
  onRemoveLanguage(lang: string): void;
  /** True when nothing is translated in `lang`, so removing it loses no work. */
  isEmpty(lang: string): boolean;
}

/** Compact chip label for the current targets: e.g. "fr", "fr +1", or "none". */
function chipLabel(selected: string[]): string {
  if (selected.length === 0) return "none";
  if (selected.length === 1) return selected[0];
  return `${selected[0]} +${selected.length - 1}`;
}

/**
 * Language chip + popover to choose which target language columns to show
 * (Hybrid mode). Lives inside the search field like VSCode Settings' filter
 * tokens: the chip shows the current targets and opens the picker. Keeps
 * `available` order so columns stay stable.
 */
export function LanguagePicker({
  source,
  available,
  selected,
  progress,
  onChange,
  canManage,
  onAddLanguage,
  onRemoveLanguage,
  isEmpty,
}: LanguagePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedSet = new Set(selected);

  function toggle(lang: string) {
    const next = selectedSet.has(lang)
      ? available.filter((l) => l !== lang && selectedSet.has(l))
      : available.filter((l) => l === lang || selectedSet.has(l));
    onChange(next);
  }

  return (
    <div className="lang-picker" ref={ref}>
      <button
        type="button"
        className={"lang-chip" + (open ? " active" : "")}
        aria-label={`Languages shown: ${
          selected.length
            ? selected.map((l) => langName(l)).join(", ")
            : "none"
        }. Click to change.`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          selected.length
            ? `${selected
                .map((l) => `${langName(l)} (${l})`)
                .join(", ")} — click to change`
            : "Choose languages to display"
        }
      >
        <span className="chip-label">{chipLabel(selected)}</span>
        <ChevronDownIcon size={11} />
      </button>

      {open && (
        <div className="lang-popover" role="menu">
          <div className="pop-head">
            <span className="pop-title">Display languages</span>
            <div className="pop-actions">
              <button
                type="button"
                className="pop-link"
                onClick={() => onChange([...available])}
              >
                Select all
              </button>
              <button
                type="button"
                className="pop-link"
                onClick={() => onChange([])}
              >
                Clear all
              </button>
            </div>
          </div>

          <label className="is-source">
            <input type="checkbox" checked disabled />
            <span className="lang-name" title={`${langName(source)} (${source})`}>
              <span className="lang-title">{langName(source)}</span>
              <span className="lang-code">{source}</span>
            </span>
            <span className="src-tag">source</span>
          </label>

          {available.map((lang) => {
            const p = progress[lang];
            return (
              <label key={lang}>
                <input
                  type="checkbox"
                  checked={selectedSet.has(lang)}
                  onChange={() => toggle(lang)}
                />
                <span className="lang-name" title={`${langName(lang)} (${lang})`}>
                  <span className="lang-title">{langName(lang)}</span>
                  <span className="lang-code">{lang}</span>
                </span>
                {p && (
                  <>
                    <span
                      className="prog-bar"
                      title={`${p.translated}/${p.total} translated${
                        p.needsReview ? `, ${p.needsReview} needs review` : ""
                      }`}
                    >
                      <span
                        className="prog-fill"
                        style={{ width: `${p.percent}%` }}
                      />
                    </span>
                    <span className="prog-pct">{p.percent}%</span>
                  </>
                )}
                {canManage && <RemoveLanguage lang={lang} empty={isEmpty(lang)} onRemove={onRemoveLanguage} />}
              </label>
            );
          })}

          {canManage && (
            <button
              type="button"
              className="pop-add"
              onClick={() => {
                setOpen(false);
                onAddLanguage();
              }}
            >
              <PlusIcon size={12} />
              <span>Add language…</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Per-language remove button. A language with translations in it stays disabled
 * rather than hidden: the point is to say *why* it can't go, not to pretend the
 * action doesn't exist.
 */
function RemoveLanguage({
  lang,
  empty,
  onRemove,
}: {
  lang: string;
  empty: boolean;
  onRemove(lang: string): void;
}) {
  return (
    <button
      type="button"
      className="lang-remove"
      disabled={!empty}
      aria-label={`Remove ${langName(lang)}`}
      title={
        empty
          ? `Remove ${langName(lang)} from this catalog`
          : `${langName(lang)} has translations, so it can't be removed. Clear them first.`
      }
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (empty) onRemove(lang);
      }}
    >
      <TrashIcon size={12} />
    </button>
  );
}
