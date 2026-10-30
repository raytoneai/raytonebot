import { type SettingsCopy } from "../../i18n/copy/settings";
import { useLocale } from "../../i18n/LocaleContext";
import { APP_LOCALES } from "../../i18n/locales";
import { themeTokens, type ThemePresetId } from "../../theme/themeTokens";
import { Segmented } from "./SettingsShared";

const LOCALE_LABELS = { zh: "中文", en: "English", ja: "日本語" } as const;

export function AppearanceSection({ t, themePreset, onThemeChange }: { t: SettingsCopy; themePreset: ThemePresetId; onThemeChange: (id: ThemePresetId) => void }) {
  const { locale, setLocale } = useLocale();
  return (
    <>
      <div className="settings-list">
        <div className="settings-row">
          <span className="settings-row-main"><strong>{t.appearance.language}</strong></span>
          <Segmented
            ariaLabel={t.appearance.language}
            value={locale}
            options={APP_LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] }))}
            onChange={setLocale}
          />
        </div>
      </div>
      <h3 className="settings-subhead">{t.appearance.theme}</h3>
      <div className="settings-themes" role="radiogroup" aria-label={t.appearance.theme}>
        {Object.values(themeTokens).map((theme) => (
          <button
            type="button"
            role="radio"
            aria-checked={theme.id === themePreset}
            key={theme.id}
            className="settings-theme"
            onClick={() => onThemeChange(theme.id)}
          >
            <span className="settings-theme-swatch" aria-hidden="true" style={{ background: theme.surface.canvas, borderColor: theme.border.strong }}>
              <span style={{ background: theme.surface.panel }} />
              <span style={{ background: theme.accent.action }} />
            </span>
            <span className="settings-theme-name">{t.appearance[theme.appearance]}</span>
          </button>
        ))}
      </div>
    </>
  );
}
