import { canvasExperienceFromExperience, completeAgentCanvasExperienceV2, withCanvasExperience, } from "./defaults.js";
import { applyExperiencePresetOption, experiencePresetGroupsForExperience, isExperiencePresetOptionActive, toggleExperiencePresetOption, } from "./presets.js";
/**
 * Expose the authoritative v1 preset registry against a v2 product value.
 * Hosts should use these helpers instead of duplicating Canvas state rules.
 */
export function productInterfacePresetGroups(value, capabilities) {
    return experiencePresetGroupsForExperience(canvasExperienceFromExperience(value), capabilities);
}
export function applyProductInterfacePresetOption(value, optionId) {
    return withCanvasExperience(value, applyExperiencePresetOption(canvasExperienceFromExperience(value), optionId));
}
export function toggleProductInterfacePresetOption(value, optionId) {
    return withCanvasExperience(value, toggleExperiencePresetOption(canvasExperienceFromExperience(value), optionId));
}
export function isProductInterfacePresetOptionActive(value, optionId) {
    return isExperiencePresetOptionActive(canvasExperienceFromExperience(value), optionId);
}
/**
 * Return logical stylesheet bindings only. Resolution, validation of the
 * referenced bytes, CSP, and preview isolation remain host responsibilities.
 */
export function productInterfaceStylesheetReferences(value) {
    return completeAgentCanvasExperienceV2(value).extensions.stylesheets.map((reference) => ({ ...reference }));
}
