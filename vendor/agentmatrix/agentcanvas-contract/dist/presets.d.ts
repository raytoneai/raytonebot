import { type AgentCanvasExperienceV1, type CompleteAgentCanvasExperienceV1 } from "./types.js";
export type ExperienceCapabilityFlags = {
    provider: boolean;
    liveRun: boolean;
    git: boolean;
    gitMutation: boolean;
    export: boolean;
    debug: boolean;
};
export declare const workspaceSafeCapabilities: ExperienceCapabilityFlags;
export type ExperiencePresetGroupId = "layout" | "conversation" | "sidebar" | "ux-effects" | "tool-calls" | "blocks" | "composer" | "output" | "render" | "theme";
export type ExperiencePresetOption = {
    id: string;
    label: string;
    description: string;
    section?: string;
    capability?: keyof ExperienceCapabilityFlags;
};
export type ExperiencePresetGroup = {
    id: ExperiencePresetGroupId;
    label: string;
    options: ExperiencePresetOption[];
};
export declare const experiencePresetGroups: readonly ExperiencePresetGroup[];
export declare function experiencePresetGroupsForCapabilities(capabilities?: Partial<ExperienceCapabilityFlags>): ExperiencePresetGroup[];
export declare function experiencePresetGroupsForExperience(input: AgentCanvasExperienceV1, capabilities?: Partial<ExperienceCapabilityFlags>): ExperiencePresetGroup[];
export declare function applyExperiencePresetOption(input: AgentCanvasExperienceV1, optionId: string): CompleteAgentCanvasExperienceV1;
export declare function isExperiencePresetOptionActive(input: AgentCanvasExperienceV1, optionId: string): boolean;
export declare function toggleExperiencePresetOption(input: AgentCanvasExperienceV1, optionId: string): CompleteAgentCanvasExperienceV1;
