import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { ChevronDown, ListChecks } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useLocale } from "../../../i18n/LocaleContext";
import { toolRunSummary } from "../../../runtime/toolSummary";

/** A finished turn's quiet steps as one line ("运行了 2 条命令 · 读取了 1 个文件"); open it for each step. */
export function ToolRunSummary({ tools, forceOpen = false, children, onViewDetails }: {
  tools: readonly AgentUXToolTimelineItem[];
  forceOpen?: boolean;
  children: ReactNode;
  onViewDetails?: () => void;
}) {
  const { locale } = useLocale();
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const status = tools.some((tool) => tool.status === "error") ? "error" : tools.some((tool) => tool.status === "cancelled") ? "cancelled" : "success";
  return (
    <section className="tool-card tool-run-summary" data-action="summary" data-status={status} data-open={open}>
      <button type="button" className="tool-card-header" data-clickable="true" aria-expanded={onViewDetails ? undefined : open} onClick={() => onViewDetails ? onViewDetails() : setOpen((value) => !value)}>
        <span className="tool-status-icon" data-status={status} aria-hidden="true"><ListChecks size={13} /></span>
        <span className="tool-title">{toolRunSummary(tools, locale)}{onViewDetails ? (locale === "zh" ? " · 查看详情" : locale === "ja" ? " · 詳細" : " · View details") : ""}</span>
        <ChevronDown size={14} className="chevron" data-open={open} aria-hidden="true" />
      </button>
      {open && !onViewDetails ? <div className="tool-run-steps">{children}</div> : null}
    </section>
  );
}
