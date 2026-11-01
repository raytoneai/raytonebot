/** Move and activate a radio in the same group while preserving native button activation. */
export function handleSettingsRadioKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  if (!group) return;
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
  const currentIndex = radios.indexOf(event.currentTarget);
  if (currentIndex < 0 || radios.length === 0) return;
  const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1 :
    (currentIndex + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + radios.length) % radios.length;
  event.preventDefault();
  radios[nextIndex].focus();
  radios[nextIndex].click();
}
