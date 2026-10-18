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

// Status colors are semantic (not derivable from a single accent), so they use
// one shared ramp per appearance.
const DARK_STATUS = { success: "#7FC8A0", warning: "#DDB25A", danger: "#E8837A", info: "#7FB2E8" };
const LIGHT_STATUS = { success: "#2E9E6E", warning: "#B37518", danger: "#C24436", info: "#2E6FB0" };

/** Seed colors supplied per scheme; every other token is derived from these. */
type Seed = { canvas: string; panel: string; inset: string; accent: string };

const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

function darkScheme(id: ThemePresetId, name: string, font: ThemeTokens["font"], s: Seed): ThemeTokens {
  const { canvas: C, panel: P, inset: I, accent: A } = s;
  return {
    id,
    name,
    appearance: "dark",
    font,
    surface: {
      canvas: C,
      panel: P,
      raised: mix(P, 72, I),
      inset: I,
      hover: mix(I, 85, "#fff"),
      disabled: mix(I, 68, "#fff"),
    },
    text: {
      primary: mix("#fff", 92, C),
      secondary: mix("#fff", 68, C),
      muted: mix("#fff", 52, C),
      inverse: mix(C, 72, "#000"),
    },
    border: {
      subtle: mix(P, 82, "#fff"),
      strong: mix(P, 62, "#fff"),
    },
    accent: {
      action: A,
      hover: mix(A, 82, "#fff"),
      soft: mix(A, 18, P),
      text: A,
    },
    status: { ...DARK_STATUS },
  };
}

export const themeTokens: Record<ThemeTokens["id"], ThemeTokens> = {
  "soft-glass": {
    id: "soft-glass",
    name: "Light",
    appearance: "light",
    font: NATIVE_FONT,
    surface: {
      canvas: "#F4F6FA",
      panel: "#FFFFFF",
      raised: "#FFFFFF",
      inset: "#F4F6FA",
      hover: "#E6E9F0",
      disabled: "#BFC5D2",
    },
    text: {
      primary: "#111E36",
      secondary: mix("#111E36", 72, "#F4F6FA"),
      muted: mix("#111E36", 55, "#F4F6FA"),
      inverse: "#FFFFFF",
    },
    border: {
      subtle: "#E6E9F0",
      strong: "#E6E9F0",
    },
    accent: {
      action: "#111E36",
      hover: mix("#111E36", 86, "#000"),
      soft: mix("#111E36", 10, "#FFFFFF"),
      text: "#111E36",
    },
    status: { ...LIGHT_STATUS },
  },
  "warm-graphite": darkScheme("warm-graphite", "Dark", NATIVE_FONT, {
    canvas: "#11100E", panel: "#1B1916", inset: "#2A251F", accent: "#D69A3A",
  }),
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
