import { type ExperienceCapabilityFlags, type ExperiencePresetGroup } from "./presets.js";
import type { AgentCanvasExperienceV2, AgentCanvasStylesheetLayer } from "./types.js";
/**
 * Expose the authoritative v1 preset registry against a v2 product value.
 * Hosts should use these helpers instead of duplicating Canvas state rules.
 */
export declare function productInterfacePresetGroups(value: AgentCanvasExperienceV2, capabilities?: Partial<ExperienceCapabilityFlags>): ExperiencePresetGroup[];
export declare function applyProductInterfacePresetOption(value: AgentCanvasExperienceV2, optionId: string): AgentCanvasExperienceV2;
export declare function toggleProductInterfacePresetOption(value: AgentCanvasExperienceV2, optionId: string): AgentCanvasExperienceV2;
export declare function isProductInterfacePresetOptionActive(value: AgentCanvasExperienceV2, optionId: string): boolean;
/**
 * Return logical stylesheet bindings only. Resolution, validation of the
 * referenced bytes, CSP, and preview isolation remain host responsibilities.
 */
export declare function productInterfaceStylesheetReferences(value: AgentCanvasExperienceV2): ReadonlyArray<{
    assetId: string;
    layer: AgentCanvasStylesheetLayer;
}>;
