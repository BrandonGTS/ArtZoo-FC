export type CropView = { zoom: number; x: number; y: number };
export type CropBounds = { width: number; height: number };
export type CropPixels = { left: number; top: number; side: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function cropSide(bounds: CropBounds, zoom: number): number {
  return Math.max(1, Math.floor(Math.min(bounds.width, bounds.height) / clamp(zoom, 1, 4)));
}

export function clampCrop(bounds: CropBounds, view: CropView): CropView {
  const zoom = clamp(view.zoom, 1, 4);
  const side = cropSide(bounds, zoom);
  return { zoom, x: clamp(view.x, 0, bounds.width - side), y: clamp(view.y, 0, bounds.height - side) };
}

/** The preview and upload both use this exact integer source rectangle. */
export function cropPixels(bounds: CropBounds, view: CropView): CropPixels {
  const safe = clampCrop(bounds, view);
  return { left: Math.round(safe.x), top: Math.round(safe.y), side: cropSide(bounds, safe.zoom) };
}

export function initialCrop(bounds: CropBounds): CropView {
  const side = cropSide(bounds, 1);
  return { zoom: 1, x: (bounds.width - side) / 2, y: (bounds.height - side) / 2 };
}

/** CSS movement is converted to source pixels, independent of canvas resolution. */
export function panCrop(
  bounds: CropBounds,
  view: CropView,
  dx: number,
  dy: number,
  displayWidth: number,
  displayHeight: number
): CropView {
  if (displayWidth <= 0 || displayHeight <= 0) return view;
  const side = cropSide(bounds, view.zoom);
  return clampCrop(bounds, {
    ...view,
    x: view.x - (dx * side) / displayWidth,
    y: view.y - (dy * side) / displayHeight
  });
}

/** Zoom about a fractional point in the viewport, defaulting to its center. */
export function zoomCrop(
  bounds: CropBounds,
  view: CropView,
  zoom: number,
  anchorX = 0.5,
  anchorY = 0.5
): CropView {
  const safe = clampCrop(bounds, view);
  const nextZoom = clamp(zoom, 1, 4);
  const difference = cropSide(bounds, safe.zoom) - cropSide(bounds, nextZoom);
  return clampCrop(bounds, {
    zoom: nextZoom,
    x: safe.x + difference * clamp(anchorX, 0, 1),
    y: safe.y + difference * clamp(anchorY, 0, 1)
  });
}

/** deltaMode: 0 = pixels, 1 = lines, 2 = pages. Bound extreme mouse-wheel deltas. */
export function wheelZoom(zoom: number, deltaY: number, deltaMode: number, displayHeight: number): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? displayHeight : 1);
  return clamp(zoom * Math.exp(-clamp(pixels, -240, 240) * 0.002), 1, 4);
}
