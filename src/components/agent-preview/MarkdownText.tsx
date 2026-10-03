import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MermaidDiagram } from "./outputframe/markdown/MermaidDiagram";
import "./markdownText.css";

/**
 * Chat markdown: GFM (tables, task lists, strikethrough, autolinks) via react-markdown, the
 * approach TelegramAgent's `frontend/src/markdownText.tsx` uses. Raw HTML is never rendered
 * (react-markdown's default). Links open only for https; images are not fetched, since an
 * agent's output could otherwise load a tracking URL — their alt text stays readable.
 */
const SAFE_HREF = /^https:\/\/[^\s<>"']+$/;
const REMARK_PLUGINS = [remarkGfm];

const components: Components = {
  a({ href, children }) {
    if (typeof href === "string" && SAFE_HREF.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="markdown-link">
          {children}
        </a>
      );
    }
    return <>{children}</>;
  },
  img({ alt }) {
    return alt ? <span className="markdown-image-alt">[{alt}]</span> : null;
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table className="markdown-table">{children}</table>
      </div>
    );
  },
  code({ className, children }) {
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    const text = String(children ?? "");
    if (language === "mermaid") return <MermaidDiagram code={text.replace(/\n$/, "")} />;
    return <code className={className}>{children}</code>;
  },
};

export const MarkdownText = memo(function MarkdownText({ children }: { children: string }) {
  const plugins = useMemo(() => REMARK_PLUGINS, []);
  return (
    <div className="markdown-text">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
