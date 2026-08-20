// TypeScript call sites, to exercise "Find in code" and "Find unused keys".
// The scan looks for the key as a quoted literal in any of the three styles, so
// all four of these count as a reference.
import { t } from "./i18n";

export const badge = t("{count, plural, one {# unread message} other {# unread messages}}");
export const signIn = t('Signed in as {name}');
export const cancel = t(`Cancel`);
export const greeting = t("Welcome, %@!");

// Built at runtime, so it is NOT counted as a reference to any key — which is
// exactly why an "unused" flag is a hint rather than a verdict.
export const dynamic = (screen: string) => t(`${screen}.title`);
