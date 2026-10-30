import { useCallback, useState } from "react";
import type { OutputPanelItem } from "../components/agent-preview/outputframe/panelItem";
import type { OutputPanelSource } from "../components/agent-preview/outputframe/types";

export function useOutputPanel(initialSource: OutputPanelSource) {
  // Closed until asked for, matching the configurator: a run with nothing to show should not
  // hand half the canvas to an empty output panel. Opens on the drawer toggle or on clicking an
  // artifact in the conversation.
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [items, setItems] = useState<OutputPanelItem[]>([]);
  const [activeItemId, setActiveItemId] = useState<string>();
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [toolLogTarget, setToolLogTarget] = useState<{ id: string; nonce: number }>();
  const [source, setSource] = useState<OutputPanelSource>(initialSource);
  const [browserAvailable, setBrowserAvailable] = useState(false);

  const openItem = useCallback((item: OutputPanelItem, rightPanelAvailable: boolean) => {
    setItems((current) => {
      const index = current.findIndex((entry) => entry.id === item.id || Boolean(item.workspacePath && entry.workspacePath === item.workspacePath));
      if (index >= 0) {
        const next = [...current];
        next[index] = item;
        return next;
      }
      return [...current, item];
    });
    setWorkspaceModalOpen(false);
    setActiveItemId(item.id);
    setSource("artifact");
    if (rightPanelAvailable) {
      setOutputModalOpen(false);
      setRightCollapsed(false);
      return;
    }
    setOutputModalOpen(true);
  }, []);

  const closeItem = useCallback((id: string) => {
    setItems((current) => {
      const next = current.filter((entry) => entry.id !== id);
      if (next.length === 0) {
        setOutputModalOpen(false);
        setActiveItemId(undefined);
      } else if (activeItemId === id) {
        setActiveItemId(next[0].id);
      }
      return next;
    });
  }, [activeItemId]);

  const showSource = useCallback((nextSource: OutputPanelSource, rightPanelAvailable: boolean) => {
    setSource(nextSource);
    setOutputModalOpen(false);
    if (rightPanelAvailable) setRightCollapsed(false);
    else setWorkspaceModalOpen(true);
  }, []);

  const showConsole = useCallback((id: string, rightPanelAvailable: boolean) => {
    setToolLogTarget((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }));
    showSource("console", rightPanelAvailable);
  }, [showSource]);

  // Conversation navigation clears artifact selection and its modal; other surface choices persist.
  const reset = useCallback(() => {
    setItems([]);
    setActiveItemId(undefined);
    setOutputModalOpen(false);
  }, []);

  return {
    rightCollapsed,
    setRightCollapsed,
    items,
    activeItemId,
    setActiveItemId,
    outputModalOpen,
    setOutputModalOpen,
    workspaceModalOpen,
    setWorkspaceModalOpen,
    toolLogTarget,
    source,
    selectSource: setSource,
    browserAvailable,
    setBrowserAvailable,
    openItem,
    closeItem,
    showSource,
    showConsole,
    reset,
  };
}
