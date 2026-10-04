import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

import { mountAvatarMotion, type AvatarMotion, type AvatarState } from "./avatarMotion";
import { avatarSVG, type AvatarKind } from "./raytoneAvatars";
import "./raytoneAvatar.css";

export { avatarBusy, type AvatarState } from "./avatarMotion";
export type { AvatarKind } from "./raytoneAvatars";

/** The agent currently answering: its face, display name and live state. */
export type AgentPersona = {
  kind: AvatarKind;
  name: string;
  state: AvatarState;
};

const AgentPersonaContext = createContext<AgentPersona | undefined>(undefined);

export function AgentPersonaProvider({ persona, children }: { persona: AgentPersona; children: ReactNode }) {
  return <AgentPersonaContext.Provider value={persona}>{children}</AgentPersonaContext.Provider>;
}

/** Undefined outside a provider (fixtures, previews): callers keep their original icon. */
export function useAgentPersona(): AgentPersona | undefined {
  return useContext(AgentPersonaContext);
}

/**
 * The persona's face. `live` animates (blink and state); otherwise it is a still drawing, so a
 * long transcript does not run a timer per message. `interactive` adds gaze-follow and drag,
 * meant for the one large welcome avatar.
 */
export function AgentAvatar({
  size,
  live = false,
  interactive = false,
  fallback,
  kind: kindOverride,
}: {
  size: number;
  /** Draw this character instead of the current persona's (settings, pickers). */
  kind?: AvatarKind;
  live?: boolean;
  interactive?: boolean;
  fallback?: ReactNode;
}) {
  const persona = useAgentPersona();
  const rootRef = useRef<HTMLSpanElement>(null);
  const motionRef = useRef<AvatarMotion | undefined>(undefined);
  const kind = kindOverride ?? persona?.kind;
  const markup = useMemo(() => (kind ? avatarSVG(kind) : ""), [kind]);
  const animated = Boolean(persona && live);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !animated) return;
    const motion = mountAvatarMotion(root, { interactive });
    motionRef.current = motion;
    return () => {
      motion.destroy();
      motionRef.current = undefined;
    };
  }, [animated, interactive, markup]);

  const state = persona?.state ?? "idle";
  useEffect(() => {
    motionRef.current?.setState(state);
  }, [state, markup, animated]);

  if (!kind) return <>{fallback}</>;
  return (
    <span
      ref={rootRef}
      className="raytone-avatar"
      data-state={animated ? undefined : "idle"}
      data-interactive={interactive ? "true" : undefined}
      style={{ width: size, height: size }}
      aria-hidden="true"
      // Static, generated markup from `avatarSVG`; no user content reaches it.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
