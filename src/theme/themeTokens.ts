import { slate, slateDark, amberDark, green, greenDark, amber, red, redDark, blue, blueDark } from "@radix-ui/colors";

export type ThemeTokens = {
  id: ThemePresetId;
  name: string;
  /** Drives the preview's light/dark chrome (data-appearance). */
  appearance: "dark" | "light";
  font: {
    ui: string;
    display: string;
    mono: string;
  };
  surface: {
    canvas: string;
    panel: string;
    raised: string;
    inset: string;
    hover: string;
    active: string;
    disabled: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    inverse: string;
  };
  border: {
    subtle: string;
    strong: string;
    focus: string;
  };
  accent: {
    action: string;
    hover: string;
    soft: string;
    /** Readable accent text on panel and soft backgrounds; separate from solid fills. */
    text?: string;
  };
  status: {
    success: string;
    warning: string;
    danger: string;
    info: string;
  };
};

// Keep the original ids so the main light theme's CSS and saved preferences stay compatible.
export type ThemePresetId = "soft-glass" | "warm-graphite";

const NATIVE_FONT: ThemeTokens["font"] = {
  ui: "\"IBM Plex Sans Variable\", \"IBM Plex Sans\", \"Aptos\", ui-sans-serif, system-ui, sans-serif",
  display: "\"IBM Plex Sans Condensed\", \"Aptos Display\", ui-sans-serif, system-ui, sans-serif",
  mono: "\"IBM Plex Mono\", \"SFMono-Regular\", Consolas, monospace",
};

// Radix scale roles: 1–2 surfaces, 3–5 interaction backgrounds, 6–8 borders,
// 9–10 solid fills and 11–12 readable text. Keep persisted theme IDs stable.
export const themeTokens: Record<ThemeTokens["id"], ThemeTokens> = {
  "soft-glass": {
    id: "soft-glass", name: "Light", appearance: "light", font: NATIVE_FONT,
    surface: {
      canvas: slate.slate2, panel: slate.slate1, raised: slate.slate1,
      inset: slate.slate3, hover: slate.slate4, active: slate.slate5, disabled: slate.slate6,
    },
    text: {
      primary: slate.slate12, secondary: slate.slate11, muted: slate.slate11, inverse: slate.slate1,
    },
    border: { subtle: slate.slate6, strong: slate.slate7, focus: slate.slate8 },
    accent: { action: slate.slate12, hover: slate.slate11, soft: slate.slate3, text: slate.slate12 },
    status: { success: green.green11, warning: amber.amber11, danger: red.red11, info: blue.blue11 },
  },
  "warm-graphite": {
    id: "warm-graphite", name: "Dark", appearance: "dark", font: NATIVE_FONT,
    surface: {
      canvas: slateDark.slate1, panel: slateDark.slate2, raised: slateDark.slate3,
      inset: slateDark.slate3, hover: slateDark.slate4, active: slateDark.slate5, disabled: slateDark.slate6,
    },
    text: {
      primary: slateDark.slate12, secondary: slateDark.slate11, muted: slateDark.slate11, inverse: slateDark.slate1,
    },
    border: { subtle: slateDark.slate6, strong: slateDark.slate7, focus: slateDark.slate8 },
    accent: { action: amberDark.amber9, hover: amberDark.amber10, soft: amberDark.amber3, text: amberDark.amber11 },
    status: { success: greenDark.green11, warning: amberDark.amber11, danger: redDark.red11, info: blueDark.blue11 },
  },
};

/** Retired palettes retain their light/dark preference; invalid data uses the project default. */
export function resolveThemePreset(id: string | undefined, fallback: ThemePresetId = "soft-glass"): ThemePresetId {
  switch (id) {
    case "warm-graphite":
    case "cocoa-system":
    case "forest-ember":
    case "cold-mono":
    case "slate-blue":
    case "cyan-grid":
      return "warm-graphite";
    case "soft-glass":
    case "sand-workspace":
    case "apricot-agent":
    case "ice-white":
    case "mist-blue":
    case "polar-mono":
      return "soft-glass";
    default:
      return fallback;
  }
}
