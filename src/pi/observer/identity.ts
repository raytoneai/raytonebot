export const OBSERVER_ID = "system:observer";
export const isObserverId = (id: unknown): id is string => typeof id === "string" && (id === OBSERVER_ID || id.startsWith("observer:"));
