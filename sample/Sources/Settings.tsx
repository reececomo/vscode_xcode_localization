import { t } from "./i18n";

export function Settings() {
  return (
    <ul>
      <li>{t("settings.title")}</li>
      <li>{t('settings.notifications')}</li>
    </ul>
  );
}
