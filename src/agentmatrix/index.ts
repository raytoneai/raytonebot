/**
 * AgentMatrix standard layer — public barrel.
 *
 * This module replaces the legacy `@agent-ux/*` protocol with the AgentMatrix
 * public Session Event model: protocol types, scenario fixtures, legacy event
 * conversion, the swappable icon registry, and its React bindings.
 */

export * from "./protocol";
export * from "./icons";
export { IconSetProvider, IconStyleProvider, StateIcon, useIconSet, useIconStyle } from "./IconSetContext";
export { SCENARIOS, scenarioById, type Scenario, type ScenarioId } from "./fixtures";
export { toAgentUXEvents, type LegacyEvent, type AdapterOptions } from "./legacyAdapter";
