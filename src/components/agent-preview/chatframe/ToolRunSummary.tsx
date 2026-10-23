import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { ChevronDown, ListChecks } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useLocale } from "../../../i18n/LocaleContext";
import { toolRunSummary } from "../../../runtime/toolSummary";

/** A compact total; open the existing details surface for individual steps. */
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
      <button type="button" className="tool-card-header" data-clickable="true" title={locale === "zh" ? "查看操作详情" : locale === "ja" ? "操作の詳細" : "View operation details"} aria-expanded={onViewDetails ? undefined : open} onClick={() => onViewDetails ? onViewDetails() : setOpen((value) => !value)}>
        <span className="tool-status-icon" data-status={status} aria-hidden="true"><ListChecks size={13} /></span>
        <span className="tool-title">{toolRunSummary(tools, locale)}</span>
        <ChevronDown size={14} className="chevron" data-open={open} aria-hidden="true" />
      </button>
      {open && !onViewDetails ? <div className="tool-run-steps">{children}</div> : null}
    </section>
  );
}
