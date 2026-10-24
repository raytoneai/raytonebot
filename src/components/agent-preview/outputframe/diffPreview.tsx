import { unifiedDiffLines } from "../../../runtime/unifiedDiff";
import "./diffPreview.css";

export function renderDiffPreview(text: string) {
  return <pre className="unified-diff" data-language="diff">{unifiedDiffLines(text).map((line, index) =>
    <span key={index} className="unified-diff-line" data-diff-kind={line.kind}>{line.text}</span>,
  )}</pre>;
}
