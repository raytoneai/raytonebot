/** Host-managed text Skills, shared by server and Settings. No executable plugin content. */
export type Skill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  updatedAt: number;
};

export type SkillState = { revision: number; skills: Skill[] };
export type SkillInput = Omit<Skill, "id" | "updatedAt" | "enabled"> & { id?: string; enabled?: boolean };

export const SKILL_NAME_LIMIT = 80;
export const SKILL_DESCRIPTION_LIMIT = 300;
export const SKILL_INSTRUCTIONS_LIMIT = 16_000;
export const SKILL_COUNT_LIMIT = 100;

export const validSkillId = (value: unknown): value is string => typeof value === "string"
  && /^skill_[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
