// Tiny class-name joiner. Filters out falsy values so callers can pass
// conditional expressions inline (e.g. `cn("a", flag && "b")`).
export const cn = (
  ...parts: Array<string | false | null | undefined>
): string => parts.filter(Boolean).join(" ")
