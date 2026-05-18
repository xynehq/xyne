// Shared utilities for file-browser primitives.

export const columnCountForWidth = (w: number): number => {
  if (w >= 1280) return 5
  if (w >= 1024) return 4
  if (w >= 640) return 3
  return 2
}
