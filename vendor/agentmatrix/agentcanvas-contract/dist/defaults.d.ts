import { type AgentCanvasExperienceV1, type AgentCanvasExperienceV2, type CompleteAgentCanvasExperienceV1, type CompleteAgentCanvasExperienceV2 } from "./types.js";
export declare const defaultAgentCanvasExperience: CompleteAgentCanvasExperienceV1;
export declare function completeAgentCanvasExperience(value: AgentCanvasExperienceV1): CompleteAgentCanvasExperienceV1;
/**
 * The v2 product default deliberately inherits the current Canvas visual
 * language. Brand and design overrides are neutral until a host/user elects
 * to customize them, so adopting v2 cannot restyle the existing Canvas UI by
 * accident.
 */
export declare const defaultAgentCanvasExperienceV2: CompleteAgentCanvasExperienceV2;
export declare function createDefaultAgentCanvasExperienceV2(input?: {
    displayName?: string;
    welcomeHeadline?: string;
    welcomeSupportingText?: string;
}): CompleteAgentCanvasExperienceV2;
export declare function completeAgentCanvasExperienceV2(value: AgentCanvasExperienceV2): CompleteAgentCanvasExperienceV2;
export declare function canvasExperienceFromExperience(value: AgentCanvasExperienceV1 | AgentCanvasExperienceV2): AgentCanvasExperienceV1;
export declare function withCanvasExperience<T extends AgentCanvasExperienceV1 | AgentCanvasExperienceV2>(value: T, canvas: AgentCanvasExperienceV1): T;
