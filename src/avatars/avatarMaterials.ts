/** Shaded vector materials keep saved colours editable at every avatar size. */
export function tint(hex: string, amount: number): string {
  const target = amount > 0 ? 255 : 0;
  return '#' + [1, 3, 5].map(i => {
    const channel = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(channel + (target - channel) * Math.abs(amount)).toString(16).padStart(2, '0');
  }).join('');
}

export function material(id: string, color: string): string {
  return `<radialGradient id="${id}" cx="32%" cy="22%" r="86%">
    <stop stop-color="${tint(color, .36)}"/><stop offset=".48" stop-color="${color}"/>
    <stop offset=".86" stop-color="${tint(color, -.12)}"/><stop offset="1" stop-color="${tint(color, -.3)}"/>
  </radialGradient>`;
}

export function relief(id: string): string {
  return `<filter id="${id}" x="-25%" y="-25%" width="160%" height="170%" color-interpolation-filters="sRGB">
    <feDropShadow dx="0" dy="1.1" stdDeviation=".65" flood-color="#071632" flood-opacity=".24"/>
    <feDropShadow dx="-.25" dy="-.35" stdDeviation=".18" flood-color="#fff4dd" flood-opacity=".42"/>
  </filter>`;
}
