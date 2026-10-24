import { useState, type ReactNode } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { readOutputPanelLayout, saveOutputPanelLayout } from "../../runtime/outputPanelLayout";

/**
 * The chat beside the output panel, resizable. Its own module so the resizer library loads only
 * when the panel first opens; the shell shows the chat alone until then.
 */
export function RightPanelLayout({
  main,
  panel,
  mainSize,
  rightSize,
}: {
  main: ReactNode;
  panel: ReactNode;
  mainSize: number | string;
  rightSize: number | string;
}) {
  const [defaultLayout] = useState(() => readOutputPanelLayout());
  return (
    <PanelGroup className="preview-panels" orientation="horizontal" defaultLayout={defaultLayout}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) saveOutputPanelLayout(meta.requestedLayout ?? layout);
      }}>
      <Panel id="main" defaultSize={mainSize} minSize="52%">
        {main}
      </Panel>
      <PanelResizeHandle className="resize-handle" />
      <Panel id="output" defaultSize={rightSize} minSize="24%">
        <aside className="right-panel">{panel}</aside>
      </Panel>
    </PanelGroup>
  );
}
