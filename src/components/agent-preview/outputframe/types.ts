import type { ArtifactRenderer, OutputSource } from "../../../schema/agentuxConfig";
import type { UiCopy } from "../../../i18n/uiCopy";

export type ConcreteArtifactRenderer = Exclude<ArtifactRenderer, "auto">;
export type OutputFrameCopy = UiCopy["workspace"]["outputFrame"];
/** Live panel navigation; the exported project's artifact/console configuration stays compatible. */
export type OutputPanelSource = OutputSource | "browser" | "workspace";
export type { OutputSource };
