// Keep native AntD shadows before hydration; the initialized document substitutes
// these with one modality-aware outline without changing borders or fills.
export const controlFocusShadows = {
  activeShadow: 'var(--artzoo-control-shadow, 0 0 0 2px rgba(67, 107, 78, .12))',
  errorActiveShadow: 'var(--artzoo-control-shadow, 0 0 0 2px rgba(163, 67, 53, .12))',
  warningActiveShadow: 'var(--artzoo-control-shadow, 0 0 0 2px rgba(121, 86, 26, .12))'
};

export const selectFocusOutline = {
  activeOutlineColor: 'var(--artzoo-control-outline, rgba(67, 107, 78, .12))',
  colorErrorOutline: 'var(--artzoo-control-outline, rgba(163, 67, 53, .12))',
  colorWarningOutline: 'var(--artzoo-control-outline, rgba(121, 86, 26, .12))'
};
