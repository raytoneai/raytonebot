/**
 * The app's current theme as CSS for a sandboxed HTML artifact, under the variable names Open
 * Intelligent UI widgets already use (and the role prompt names). Values come from the theme's
 * variables (`themeVariables()`, built from theme state in the shell: the DOM still holds the
 * old theme while a switch renders), so light and dark schemes carry over; the artifact's own
 * styles come later and win. Self-hosted fonts cannot load in the frame (font-src data:), so
 * the font stacks fall back to system fonts.
 */
import {
  amber, amberDark, blue, blueDark, green, greenDark,
  purple, purpleDark, red, redDark, slate, slateDark, teal, tealDark,
  tomato, tomatoDark,
} from "@radix-ui/colors";

const SVG_COLORS = {
  blue: ["blue", blue, blueDark], teal: ["teal", teal, tealDark], purple: ["purple", purple, purpleDark], coral: ["tomato", tomato, tomatoDark],
  amber: ["amber", amber, amberDark], green: ["green", green, greenDark], red: ["red", red, redDark], gray: ["slate", slate, slateDark],
} as const;

export function artifactThemeCss(read: (variable: string) => string, appearance: "light" | "dark"): string {
  const value = (variable: string, fallback: string) => read(variable).trim().replace(/[<>{};]/g, "") || fallback;
  const vars: Record<string, string> = {
    "--color-background-primary": value("--surface-panel", appearance === "dark" ? "#16171a" : "#ffffff"),
    "--color-background-secondary": value("--surface-inset", appearance === "dark" ? "#1f2024" : "#f4f5f7"),
    "--color-text-primary": value("--text-primary", appearance === "dark" ? "#ececef" : "#16171a"),
    "--color-text-secondary": value("--text-secondary", appearance === "dark" ? "#a1a1aa" : "#5b5f66"),
    "--color-border-primary": value("--border-subtle", appearance === "dark" ? "#2c2d33" : "#e3e5e8"),
    "--color-accent": value("--accent", "#2563eb"),
    "--color-success": value("--success", "#16a34a"),
    "--color-warning": value("--warning", "#d97706"),
    "--color-danger": value("--danger", "#dc2626"),
    "--font-sans": value("--font-ui", "system-ui, sans-serif"),
    "--font-mono": value("--font-mono", "ui-monospace, monospace"),
    "--border-radius-md": "8px",
  };
  const root = Object.entries(vars).map(([name, v]) => `${name}:${v}`).join(";");
  const dark = appearance === "dark";
  const svg = Object.entries(SVG_COLORS).map(([name, [paletteName, lightScale, darkScale]]) => {
    const scale = (dark ? darkScale : lightScale) as Record<string, string>;
    // Radix 3/8 provide a quiet node surface and a visible edge; 12 is the high-contrast text role.
    // Keep --c as the legacy accent token, while the new roles separate node and label colors.
    return `.c-${name}{--c:${scale[`${paletteName}9`]};--c-bg:${scale[`${paletteName}3`]};--c-stroke:${scale[`${paletteName}8`]};--c-label:${scale[`${paletteName}12`]};color:var(--c-label)}` +
      `:where(.c-${name}:not(text):not([fill])){fill:var(--c-bg)}:where(.c-${name}:not(text):not([stroke])){stroke:var(--c-stroke)}` +
      `:where(.c-${name} text:not([fill]):not(.t):not(.ts):not(.th)){fill:var(--c-label)}:where(.c-${name} text:not([stroke])){stroke:none}`;
  }).join("");
  return [
    `:root{${root};color-scheme:${appearance}}`,
    "body{margin:0;padding:16px;background:var(--color-background-primary);color:var(--color-text-primary);font:14px/1.5 var(--font-sans)}",
    "button,input,select,textarea{font:inherit;color:inherit}",
    "button{padding:6px 12px;border:1px solid var(--color-border-primary);border-radius:var(--border-radius-md);background:var(--color-background-secondary);cursor:pointer}",
    "button:hover{border-color:var(--color-accent)}button:disabled{opacity:.5;cursor:default}",
    "input:not([type=range]):not([type=checkbox]):not([type=radio]),select,textarea{padding:6px 8px;border:1px solid var(--color-border-primary);border-radius:var(--border-radius-md);background:var(--color-background-primary)}",
    "input[type=range],input[type=checkbox],input[type=radio]{accent-color:var(--color-accent)}",
    ":focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}",
    "table{border-collapse:collapse}th,td{padding:6px 10px;border-bottom:1px solid var(--color-border-primary);text-align:left}",
    "code,pre{font-family:var(--font-mono)}",
    ":where(text.t:not([fill])){fill:var(--c-label,var(--color-text-primary))}:where(text.ts:not([fill])){fill:var(--c-label,var(--color-text-secondary))}:where(text.th:not([fill])){fill:var(--c-label,var(--color-text-primary))}:where(text.th){font-weight:700}:where(text:is(.t,.ts,.th):not([stroke])){stroke:none}",
    svg,
    "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}",
  ].join("\n");
}
