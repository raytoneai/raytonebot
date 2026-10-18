import type { ThemeTokens } from "./themeTokens";

export function applyTheme(theme: ThemeTokens, root: HTMLElement = document.documentElement): void {
  for (const [variable, value] of Object.entries(themeVariables(theme))) root.style.setProperty(variable, value);
}

/** The CSS variables a theme sets, by name; HTML artifacts read them before `applyTheme` runs. */
export function themeVariables(theme: ThemeTokens): Record<string, string> {
  return {
    ...tokenGroup("font", theme.font),
    ...tokenGroup("surface", theme.surface),
    ...tokenGroup("text", theme.text),
    ...tokenGroup("border", theme.border),
    ...tokenGroup("accent", { text: theme.text.primary, ...theme.accent }, { action: "accent" }),
    ...tokenGroup("", theme.status),
  };
}

function tokenGroup(
  prefix: string,
  tokens: Record<string, string>,
  aliases: Record<string, string> = {},
): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).map(([key, value]) => (
    [`--${aliases[key] ?? [prefix, key].filter(Boolean).join("-")}`, value]
  )));
}
