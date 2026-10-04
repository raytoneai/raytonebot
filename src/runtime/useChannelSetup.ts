import { useEffect, useState } from "react";
import type { ComponentProps } from "react";

import type { InlineApprovalPrompt } from "../components/agent-preview/chatframe/approval";
import { settingsCopy } from "../i18n/copy/settings";
import type { AppLocale } from "../i18n/locales";
import { CHANNEL_FIELDS } from "../pi/imChannels/types";
import { answerChannelSetup } from "../pi/piClient";
import type { PendingChannelSetup } from "./channelSetup";

/**
 * The `connect_channel` card, drawn by the same prompt as questions and approvals. The token
 * lives only in this component's state until it is posted to the host; it is never an event.
 */
export function useChannelSetup(setup: PendingChannelSetup | undefined, conversationId: string, locale: AppLocale): ComponentProps<typeof InlineApprovalPrompt> | undefined {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setToken(""); setError(undefined); }, [setup?.requestId, setup?.stage]);
  if (!setup) return undefined;
  const copy = settingsCopy[locale].channels;
  const card = copy.setupCard;
  const name = copy.names[setup.platform];
  const send = async (action: "submit" | "allow" | "reject" | "skip") => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const field = CHANNEL_FIELDS[setup.platform].find((entry) => entry.secret)!.key;
      await answerChannelSetup(conversationId, setup.requestId, action, action === "submit" ? { [field]: token.trim() } : undefined);
      setToken("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  const base = { ariaLabel: card.title(name), kicker: card.title(name), pending };
  if (setup.stage === "credentials") {
    const problem = error ?? setup.error;
    return {
      ...base,
      question: card.tokenQuestion,
      options: [{ id: "token", title: card.tokenField, answerPlaceholder: true, secret: true }],
      answer: token,
      onAnswerChange: setToken,
      hint: problem ? card.failed(problem) : card.tokenHint,
      secondaryLabel: card.cancel,
      onSecondary: () => void send("skip"),
      primaryLabel: pending ? card.connecting : card.connect,
      primaryDisabled: !token.trim(),
      onPrimary: () => void send("submit"),
    };
  }
  const bot = setup.botName ?? name;
  if (!setup.candidate) {
    return {
      ...base,
      question: card.waitQuestion(bot),
      options: [],
      hint: error ?? card.waitHint,
      secondaryLabel: card.skip,
      onSecondary: () => void send("skip"),
      primaryLabel: card.waiting,
      primaryDisabled: true,
    };
  }
  const who = setup.candidate.name ? `${setup.candidate.name} (ID ${setup.candidate.id})` : `ID ${setup.candidate.id}`;
  return {
    ...base,
    question: card.candidateQuestion(who),
    options: [],
    hint: error ?? card.candidateHint,
    secondaryLabel: card.notMe,
    onSecondary: () => void send("reject"),
    primaryLabel: card.allow,
    onPrimary: () => void send("allow"),
  };
}
