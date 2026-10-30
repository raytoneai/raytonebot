import { Check, CircleAlert, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useCopy } from "../../i18n/LocaleContext";
import { useClipboardFeedback } from "../../runtime/useClipboardFeedback";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <span className="settings-field-control">
        {children}
        {hint ? <small className="settings-note">{hint}</small> : null}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel, disabled }: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          key={option.value}
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ t, value }: { t: { copy: string; copied: string }; value: string }) {
  const clipboard = useClipboardFeedback(value);
  const failure = useCopy().chat.message.actions.copyFailedText;
  const label = clipboard.status === "copied" ? t.copied : clipboard.status === "failed" ? failure : t.copy;
  return (
    <button
      type="button"
      className="settings-copy"
      aria-label={label}
      title={label}
      onClick={(event) => void clipboard.copy(event.currentTarget.closest(".settings-about-row")?.querySelector("code"))}
    >
      {clipboard.status === "copied" ? <Check size={13} aria-hidden="true" /> : clipboard.status === "failed" ? <CircleAlert size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

export function ProviderMark({ label }: { label: string }) {
  return <span className="settings-mark" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>;
}

export function Dot() {
  return <span className="settings-dot" aria-hidden="true" />;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Placeholder for a saved key; never contains credential characters. */
export const MASK = "••••••••••••••••";
