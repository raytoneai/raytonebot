import type { CSSProperties } from "react";

import { AgentAvatar, type AvatarKind } from "./AgentPersona";

/** Group chat: a group's face — the user plus each agent member, four overlapping discs (Grok-style). */
export function GroupFace({ size, kinds }: { size: number; kinds: readonly AvatarKind[] }) {
  const cell = Math.round(size * 0.53);
  const ring = size >= 30 ? 2 : 1.5;
  const corners: CSSProperties[] = [{ left: 0, top: 0 }, { right: 0, top: 0 }, { left: 0, bottom: 0 }, { right: 0, bottom: 0 }];
  const disc = (style: CSSProperties): CSSProperties => ({ position: "absolute", width: cell, height: cell, borderRadius: "50%",
    overflow: "hidden", boxShadow: `0 0 0 ${ring}px #fff`, background: "#fff", display: "inline-flex", ...style });
  return (
    <span aria-hidden="true" style={{ position: "relative", display: "inline-block", width: size, height: size, flex: "none" }}>
      <span style={{ ...disc(corners[0]), alignItems: "center", justifyContent: "center", background: "#c8d6f6", color: "#2b3a67",
        fontSize: Math.max(8, Math.round(cell * 0.48)), fontWeight: 600 }}>我</span>
      {kinds.slice(0, 3).map((kind, index) => (
        <span key={index} style={disc(corners[index + 1])}><AgentAvatar size={cell} kind={kind} /></span>
      ))}
    </span>
  );
}
