import { Check, CircleAlert, Copy, Pencil, RotateCcw } from "lucide-react";
import { useRef, useState, type ReactElement } from "react";

import { useCopy } from "../../../i18n/LocaleContext";
import type { AgentFrontendProject } from "../../../schema/agentuxConfig";
import { IconTooltip } from "../../common/IconTooltip";
import { useClipboardFeedback } from "../../../runtime/useClipboardFeedback";
import { useShellExtras } from "../../shell/ShellExtras";

type MessageActionRole = "user" | "assistant";

export function MessageActions({ project, role, text = "", messageId }: { project: AgentFrontendProject; role: MessageActionRole; text?: string; messageId?: string }) {
  const copy = useCopy();
  const { messageBranch } = useShellExtras();
  const [actionError, setActionError] = useState<string>();
  const [branchPending, setBranchPending] = useState(false);
  const clipboard = useClipboardFeedback(text);
  const actionsRef = useRef<HTMLDivElement>(null);
  const feedback = clipboard.status === "copied" ? copy.chat.message.actions.copied
    : clipboard.status === "failed" ? copy.chat.message.actions.copyFailed : undefined;
  const { messageActions } = project.conversation;
  type MessageAction = { id: string; label: string; icon?: ReactElement; timeText?: string };
  const compactActions = (items: Array<MessageAction | undefined>) =>
    items.filter((action): action is MessageAction => Boolean(action));
  const actions = role === "user"
    ? compactActions([
      (messageActions.userCopy ?? messageActions.copy)
        ? { id: "copy", label: copy.chat.message.actions.copyPrompt, icon: <Copy size={14} /> }
        : undefined,
      (messageActions.userEdit ?? messageActions.edit)
        ? { id: "resend", label: copy.chat.message.actions.resendPrompt, icon: <RotateCcw size={14} /> }
        : undefined,
      messageActions.userTime
        ? { id: "time", label: copy.chat.message.actions.promptTime, timeText: "09:47" }
        : undefined,
    ])
    : compactActions([
      (messageActions.agentCopy ?? messageActions.copy)
        ? { id: "copy", label: copy.chat.message.actions.copyResponse, icon: <Copy size={14} /> }
        : undefined,
      (messageActions.agentRegenerate ?? messageActions.regenerate)
        ? { id: "regenerate", label: copy.chat.message.actions.regenerateResponse, icon: <RotateCcw size={14} /> }
        : undefined,
      messageActions.agentEdit
        ? { id: "edit", label: copy.chat.message.actions.editResponse, icon: <Pencil size={14} /> }
        : undefined,
      messageActions.agentTime
        ? { id: "time", label: copy.chat.message.actions.responseTime, timeText: "09:48" }
        : undefined,
    ]);

  if (actions.length === 0) {
    return null;
  }

  return (
    <div
      className="message-actions"
      ref={actionsRef}
      data-message-actions={role}
      data-preview-anchor={role === "user" ? "user-message-actions" : "agent-message-actions"}
      aria-label={role === "user" ? copy.chat.message.actions.userActionsLabel : copy.chat.message.actions.agentActionsLabel}
    >
      {actions.map((action) => action.timeText ? (
        <span key={action.id} className="message-action-time" aria-label={action.label}>
          {action.timeText}
        </span>
      ) : (
        <IconTooltip key={action.id} label={action.id === "copy" && feedback ? feedback : action.label}>
          <button className="message-action-icon" aria-label={action.id === "copy" && feedback ? feedback : action.label} type="button"
            disabled={action.id === "copy" ? !text : !messageBranch?.canBranch(messageId)}
            onClick={action.id === "copy" ? () => void clipboard.copy(actionsRef.current?.closest(".message-item, .lane-message")?.querySelector(".msg-surface")) : () => {
              if (!messageId || !messageBranch || (action.id !== "edit" && action.id !== "regenerate" && action.id !== "resend")) return;
              setActionError(undefined);
              setBranchPending(true);
              void messageBranch.run(messageId, action.id)
                .catch(error => setActionError(error instanceof Error ? error.message : String(error)))
                .finally(() => setBranchPending(false));
            }}>
            {action.id === "copy" && feedback
              ? clipboard.status === "copied"
                // Copy is a hot path, so the confirmation is one small pop, not a flourish: the
                // glyph swaps in place and the pop is what makes the swap read as "done".
                ? <Check size={14} className="message-action-pop" />
                : <CircleAlert size={14} /> : action.icon}
          </button>
        </IconTooltip>
      ))}
      {feedback ? <span className="clipboard-feedback" role="status">{feedback}</span> : null}
      {actionError ? <span className="clipboard-feedback" role="alert">{actionError}</span> : null}
      {branchPending && role !== "user" ? <span className="clipboard-feedback" role="status">{copy.chat.message.actions.branchPending}</span> : null}
    </div>
  );
}
