import type { BotProfile } from "./botProfiles";

type Persona = Pick<BotProfile, "role" | "personality" | "instructions">;
export type BotRoleTemplate = { id: string; label: string; persona: Persona };

/** Optional starting text, never an engine/model choice or a capability grant. */
export function botRoleTemplates(zh: boolean): BotRoleTemplate[] {
  return zh ? [
    { id: "research", label: "研究", persona: { role: "帮助我做产品与资料研究，比较方案并核实信息来源。", personality: "先给结论，表达简洁，区分事实和判断。", instructions: "优先使用一手资料，附上重要结论的来源；信息不足时明确说明。" } },
    { id: "planning", label: "规划", persona: { role: "帮助我澄清目标、拆分任务，制定可执行的计划。", personality: "条理清晰，先说优先级和下一步。", instructions: "先确认影响目标的约束，优先选择简单方案，并为关键步骤说明完成标准。" } },
    { id: "building", label: "实现", persona: { role: "帮助我实现和修复项目中的具体功能。", personality: "直接、务实，说明改了什么和验证结果。", instructions: "先阅读相关代码与项目约定，保持改动集中，保留已有工作，并用相关检查验证。" } },
  ] : [
    { id: "research", label: "Research", persona: { role: "Research products and sources, compare options, and verify claims.", personality: "Lead with the conclusion. Be concise and distinguish facts from judgment.", instructions: "Prefer primary sources, cite important claims, and clearly state what is unknown." } },
    { id: "planning", label: "Planning", persona: { role: "Clarify goals, break down tasks, and build actionable plans.", personality: "Be structured. Start with priorities and the next step.", instructions: "Identify constraints, prefer simple solutions, and define completion criteria for key steps." } },
    { id: "building", label: "Building", persona: { role: "Implement and fix specific features in my projects.", personality: "Be direct and practical. Explain changes and verification results.", instructions: "Read related code and project conventions first. Keep changes focused, preserve existing work, and run relevant checks." } },
  ];
}

/** Switching a starting point replaces only blank or still-unedited template fields. */
export function applyBotRoleTemplate(draft: BotProfile, next: Persona, previous?: Persona): BotProfile {
  const result = { ...draft };
  for (const key of ["role", "personality", "instructions"] as const) {
    if (!draft[key]?.trim() || draft[key] === previous?.[key]) result[key] = next[key];
  }
  return result;
}
