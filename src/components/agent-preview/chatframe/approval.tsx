import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { useLayoutEffect, useRef, useState } from "react";

import { StateIcon, type IconSlot } from "../../../agentmatrix";
import { useCopy } from "../../../i18n/LocaleContext";
import type { UiCopy } from "../../../i18n/uiCopy";
import type { ApprovalDecision } from "../ToolCallCard";
import { useApprovalSubmission } from "../../../runtime/approvalSubmission";
import { usePromptFocus } from "../../../runtime/usePromptFocus";

export type InlineApprovalPromptOption = {
  id: string;
  title: string;
  body?: string;
  answerPlaceholder?: boolean;
  /** The answer field is a credential: masked, never autocompleted or spell-checked. */
  secret?: boolean;
  disabled?: boolean;
  selected?: boolean;
  onSelect?: () => void;
};

export function InlineApprovalPrompt({
  ariaLabel,
  kicker,
  question,
  options,
  hint,
  secondaryLabel,
  primaryLabel,
  pending = false,
  approvalSurface,
  onSecondary,
  onPrimary,
  primaryDisabled = false,
  answer: controlledAnswer,
  onAnswerChange,
}: {
  ariaLabel: string;
  kicker: string;
  question: string;
  options: readonly InlineApprovalPromptOption[];
  hint: string;
  secondaryLabel: string;
  primaryLabel: string;
  pending?: boolean;
  approvalSurface?: "inline";
  onSecondary?: () => void;
  onPrimary?: (answer: string) => void;
  primaryDisabled?: boolean;
  answer?: string;
  onAnswerChange?: (answer: string) => void;
}) {
  const [localAnswer, setAnswer] = useState("");
  const answer = controlledAnswer ?? localAnswer;
  const panel = usePromptFocus(pending);
  const heading = useRef<HTMLElement>(null);
  const advanceFocus = useRef(false);
  useLayoutEffect(() => {
    // A question change removes the old input. Keep keyboard navigation inside the form.
    if (advanceFocus.current) heading.current?.focus();
    advanceFocus.current = false;
  }, [question]);
  const primary = () => { advanceFocus.current = true; onPrimary?.(answer); };
  const secondary = () => { advanceFocus.current = true; onSecondary?.(); };

  return (
    <aside
      ref={panel}
      className="inline-approval-panel"
      data-approval-surface={approvalSurface}
      data-preview-anchor="external-approval"
      aria-label={ariaLabel}
      aria-busy={pending}
    >
      <div className="inline-approval-head">
        <div>
          <span>{kicker}</span>
          <strong ref={heading} tabIndex={-1}>{question}</strong>
        </div>
      </div>

      <ol className="inline-approval-options">
        {options.map((option, index) => (
          <li
            key={option.id}
            data-placeholder={option.answerPlaceholder ? "true" : undefined}
            data-interactive={option.onSelect ? "true" : undefined}
          >
            <span className="inline-approval-option-index">{index + 1}.</span>
            {option.answerPlaceholder ? (
              <input
                className="inline-approval-answer"
                type={option.secret ? "password" : "text"}
                autoComplete={option.secret ? "off" : undefined}
                spellCheck={option.secret ? false : undefined}
                maxLength={4000}
                value={answer}
                placeholder={option.title}
                aria-label={option.title}
                disabled={pending}
                onChange={(event) => { setAnswer(event.target.value); onAnswerChange?.(event.target.value); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && !pending && !primaryDisabled) {
                    event.preventDefault();
                    primary();
                  }
                }}
              />
            ) : option.onSelect ? (
              <button
                type="button"
                className="inline-approval-option-button"
                data-approval-action={option.id}
                aria-pressed={option.selected}
                disabled={pending || option.disabled}
                onClick={option.onSelect}
              >
                <strong>{option.title}</strong>
                {option.body ? <span>{option.body}</span> : null}
              </button>
            ) : (
              <div>
                <strong>{option.title}</strong>
                {option.body ? <span>{option.body}</span> : null}
              </div>
            )}
          </li>
        ))}
      </ol>

      <footer className="inline-approval-footer">
        <span role="status">
          <span className="inline-approval-info" aria-hidden="true">i</span>
          {hint}
        </span>
        <div>
          <button
            type="button"
            className="inline-approval-secondary"
            disabled={pending}
            onClick={secondary}
          >
            {secondaryLabel}
          </button>
          <button
            type="button"
            className="inline-approval-primary"
            disabled={pending || primaryDisabled}
            onClick={primary}
          >
            {primaryLabel}
          </button>
        </div>
      </footer>
    </aside>
  );
}

export function InlineApprovalSurface({
  tool,
  onConfirm,
}: {
  tool: AgentUXToolTimelineItem;
  onConfirm?: (decision: ApprovalDecision) => void | Promise<void>;
}) {
  const copy = useCopy();
  const { pending, failed, submit: confirm } = useApprovalSubmission(onConfirm);
  const choices = approvalChoices(copy);
  const prompt = tool.approval?.prompt ?? copy.chat.approval.promptFallback;

  return (
    <InlineApprovalPrompt
      ariaLabel={copy.chat.approval.actionsLabel}
      kicker={copy.chat.approval.permissionRequired}
      question={prompt}
      options={choices.map((choice) => ({
        id: choice.id,
        title: choice.label,
        body: choice.hint,
        onSelect: () => void confirm(choice.id),
      }))}
      hint={pending ? copy.chat.approval.sending : failed ? copy.chat.approval.failed : copy.chat.approval.chooseHint}
      secondaryLabel={copy.chat.approval.no}
      primaryLabel={copy.chat.approval.yes}
      pending={pending}
      approvalSurface="inline"
      onSecondary={() => void confirm("no")}
      onPrimary={() => void confirm("yes")}
    />
  );
}

export function ExternalApprovalSurface({
  tool,
  approvalIconSlot,
  onConfirm,
}: {
  tool: AgentUXToolTimelineItem;
  approvalIconSlot?: IconSlot;
  onConfirm?: (decision: ApprovalDecision) => void | Promise<void>;
}) {
  const copy = useCopy();
  const [selected, setSelected] = useState<ApprovalChoice>("yes");
  const { pending, failed, submit } = useApprovalSubmission(onConfirm);
  const panel = usePromptFocus(pending);
  const choices = approvalChoices(copy);
  // Same precedence as the inline card: the backend's own question, else the dictionary's.
  const prompt = tool.approval?.prompt ?? copy.chat.approval.promptFallback;
  return (
    <aside
      ref={panel}
      className="external-approval-panel"
      data-approval-surface="external"
      data-preview-anchor="external-approval"
      aria-label={copy.chat.approval.externalLabel}
      aria-busy={pending}
    >
      <div className="external-approval-head">
        <div>
          <span className="external-approval-title-row">
            {approvalIconSlot ? (
              <span className="external-approval-title-icon" aria-hidden="true">
                <StateIcon slot={approvalIconSlot} size={15} />
              </span>
            ) : null}
            <strong>{copy.chat.approval.permissionRequired}</strong>
          </span>
        </div>
        <small>{tool.title ?? tool.name}</small>
      </div>

      <p className="external-approval-prompt">{prompt}</p>

      <div className="external-approval-command">
        <code>{formatApprovalCommand(tool)}</code>
        <span>{copy.chat.approval.noOutput}</span>
      </div>

      <div className="external-approval-options" aria-label={copy.chat.approval.actionsLabel}>
        {choices.map((choice, index) => (
          <button
            key={choice.id}
            type="button"
            data-approval-action={choice.id}
            data-selected={selected === choice.id}
            disabled={pending}
            onClick={() => setSelected(choice.id)}
          >
            <span className="external-approval-index">{index + 1}.</span>
            <span className="external-approval-option-copy">
              <strong>{choice.label}</strong>
              <span>{choice.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="external-approval-footer">
        <span role="status">
          {pending ? copy.chat.approval.sending : failed ? copy.chat.approval.failed : copy.chat.approval.chooseHint}
        </span>
        <button
          type="button"
          className="external-approval-confirm"
          disabled={pending}
          onClick={() => void submit(selected)}
        >
          {copy.chat.approval.confirm}
        </button>
      </div>
    </aside>
  );
}

export function isPendingApprovalTool(item: AgentUXToolTimelineItem): item is AgentUXToolTimelineItem {
  return item.status === "awaiting_approval" && Boolean(item.approval);
}

type ApprovalChoice = ApprovalDecision;

function approvalChoices(copy: UiCopy): Array<{ id: ApprovalChoice; label: string; hint: string }> {
  return [
    {
      id: "yes",
      label: copy.chat.approval.yes,
      hint: copy.chat.approval.hints.yes,
    },
    {
      id: "always",
      label: copy.chat.approval.always,
      hint: copy.chat.approval.hints.always,
    },
    {
      id: "no",
      label: copy.chat.approval.no,
      hint: copy.chat.approval.hints.no,
    },
  ];
}

function formatApprovalCommand(tool: AgentUXToolTimelineItem): string {
  const args = toPlainRecord(tool.approval?.argsPreview);
  const command = stringFromRecord(args, "cmd") || stringFromRecord(args, "command");
  if (command) {
    return `$ ${command}`;
  }

  if ((tool.name === "rm" || tool.name === "filesystem.rm") && args) {
    const path = stringFromRecord(args, "path");
    const recursive = args.recursive === true;
    const force = args.force === true;
    const flags = `${recursive ? "r" : ""}${force ? "f" : ""}`;
    return `$ rm ${flags ? `-${flags} ` : ""}${path || ""}`.trim();
  }

  if (tool.argsText) {
    return `$ ${tool.argsText}`;
  }

  if (args) {
    return JSON.stringify(args, null, 2);
  }

  return `$ ${tool.name}`;
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringFromRecord(value: Record<string, unknown> | undefined, key: string): string {
  const item = value?.[key];
  return typeof item === "string" ? item : "";
}
