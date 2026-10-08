import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { ChevronDown, ListChecks } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useLocale } from "../../../i18n/LocaleContext";
import { toolRunSummary } from "../../../runtime/toolSummary";

/** A finished turn's quiet steps as one line ("运行了 2 条命令 · 读取了 1 个文件"); open it for each step. */
export function ToolRunSummary({ tools, forceOpen = false, children }: {
  tools: readonly AgentUXToolTimelineItem[];
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const { locale } = useLocale();
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const failed = tools.some((tool) => tool.status === "error");
  return (
    <section className="tool-card tool-run-summary" data-action="summary" data-status={failed ? "error" : "success"} data-open={open}>
      <button type="button" className="tool-card-header" data-clickable="true" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="tool-status-icon" data-status={failed ? "error" : "success"} aria-hidden="true"><ListChecks size={13} /></span>
        <span className="tool-title">{toolRunSummary(tools, locale)}</span>
        <ChevronDown size={14} className="chevron" data-open={open} aria-hidden="true" />
      </button>
      {open ? <div className="tool-run-steps">{children}</div> : null}
    </section>
  );
}
