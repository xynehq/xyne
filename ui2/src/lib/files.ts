// Neutral file-related formatters. Used by feature data layers to prepare
// caption / column text for the file-browser primitives.

export const formatBytes = (n: number): string => {
  if (n < 1024) {
    return `${n} B`
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(0)} KB`
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const formatDate = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    return iso
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

// Pull the lowercase file extension from a path or filename. Returns "" if
// the basename has no extension.
export const extOf = (pathOrName: string): string => {
  const slash = pathOrName.lastIndexOf("/")
  const base = slash >= 0 ? pathOrName.slice(slash + 1) : pathOrName
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

// Strip the extension off a basename (for display). Keeps things untouched
// if there's no dot.
export const stripExt = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

// Slash-delimited path helpers shared between the data layer and any
// breadcrumb-like primitive. Empty string → empty segments.
export const splitPath = (p: string): string[] => (p === "" ? [] : p.split("/"))
export const joinPath = (segs: ReadonlyArray<string>): string => segs.join("/")
