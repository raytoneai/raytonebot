import { AGENTCANVAS_EXPERIENCE_V1, AGENTCANVAS_EXPERIENCE_V2, type AgentCanvasExperience, type AgentCanvasExperienceV1, type AgentCanvasExperienceV2 } from "./types.js";
export type ExperienceValidationIssue = {
    path: string;
    message: string;
};
export declare class ExperienceValidationError extends Error {
    readonly issues: ExperienceValidationIssue[];
    constructor(issues: ExperienceValidationIssue[]);
}
export declare class UnsupportedExperienceVersionError extends Error {
    readonly version: unknown;
    constructor(version: unknown);
}
export declare function validateAgentCanvasExperience(input: unknown): ExperienceValidationIssue[];
export declare function decodeAgentCanvasExperience(input: unknown): AgentCanvasExperienceV1;
export declare function parseAgentCanvasExperience(json: string): AgentCanvasExperienceV1;
export declare function encodeAgentCanvasExperience(value: AgentCanvasExperienceV1): string;
export declare function validateAgentCanvasExperienceV2(input: unknown): ExperienceValidationIssue[];
export declare function decodeAgentCanvasExperienceV2(input: unknown): AgentCanvasExperienceV2;
export declare function parseAgentCanvasExperienceV2(json: string): AgentCanvasExperienceV2;
export declare function encodeAgentCanvasExperienceV2(value: AgentCanvasExperienceV2): string;
export declare function validateSupportedAgentCanvasExperience(input: unknown): ExperienceValidationIssue[];
export declare function decodeSupportedAgentCanvasExperience(input: unknown): AgentCanvasExperience;
export declare function parseSupportedAgentCanvasExperience(json: string): AgentCanvasExperience;
export declare function encodeSupportedAgentCanvasExperience(value: AgentCanvasExperience): string;
export declare function migrateAgentCanvasExperience(input: unknown, targetVersion?: typeof AGENTCANVAS_EXPERIENCE_V1 | typeof AGENTCANVAS_EXPERIENCE_V2): AgentCanvasExperience;
export declare const supportedExperienceMigrations: readonly {
    from: string;
    to: string;
}[];
