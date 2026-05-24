// Collapsible JSON tree viewer. Each object / array node carries its
// own expand/collapse state defaulting to open; the optional `signal`
// prop lets a parent bulk-toggle every node at once. Hand-rolled — no
// third-party dep.

import { useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"

// Signal that bulk-changes every JsonNode's expanded state. A NEW
// reference each click lets each node's useEffect detect it; the
// `expand` field carries the target state.
export type ExpandSignal = { token: number; expand: boolean }

type Props = {
  value: unknown
  signal?: ExpandSignal | null
}

export function JsonTree({ value, signal = null }: Props): JSX.Element {
  return <JsonNode value={value} signal={signal} depth={0} isLast />
}

export function JsonNode({
  value,
  label,
  signal,
  depth,
  isLast,
}: {
  value: unknown
  label?: string
  signal: ExpandSignal | null
  depth: number
  isLast?: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  useEffect(() => {
    if (signal) setExpanded(signal.expand)
  }, [signal])

  const labelPart =
    label !== undefined ? (
      <span className="text-foreground/90">
        <span className="text-amber-600 dark:text-amber-400">
          {JSON.stringify(label)}
        </span>
        <span className="text-muted-foreground">: </span>
      </span>
    ) : null

  const trailingComma = isLast ? "" : ","
  const isArray = Array.isArray(value)
  const isObject =
    !isArray && value !== null && typeof value === "object"

  if (!isArray && !isObject) {
    return (
      <div style={{ paddingLeft: depth * 14 }}>
        {labelPart}
        <PrimitiveValue value={value} />
        <span className="text-muted-foreground">{trailingComma}</span>
      </div>
    )
  }

  const entries: Array<[string, unknown]> = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
  const open = isArray ? "[" : "{"
  const close = isArray ? "]" : "}"

  if (entries.length === 0) {
    return (
      <div style={{ paddingLeft: depth * 14 }}>
        {labelPart}
        <span className="text-muted-foreground">
          {open}
          {close}
          {trailingComma}
        </span>
      </div>
    )
  }

  const countSuffix = ` // ${String(entries.length)} ${
    isArray ? "item" : "key"
  }${entries.length === 1 ? "" : "s"}`

  return (
    <div>
      <div
        style={{ paddingLeft: depth * 14 }}
        className="flex items-center"
      >
        <button
          type="button"
          onClick={(): void => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="mr-1 grid h-4 w-4 place-items-center rounded text-muted-foreground/70 transition hover:text-foreground"
        >
          <ChevronRight
            className={
              "h-3 w-3 transition-transform " + (expanded ? "rotate-90" : "")
            }
            aria-hidden
            strokeWidth={2}
          />
        </button>
        {labelPart}
        <span className="text-muted-foreground">{open}</span>
        {!expanded ? (
          <>
            <span className="text-muted-foreground/60">{countSuffix}</span>
            <span className="text-muted-foreground">
              {close}
              {trailingComma}
            </span>
          </>
        ) : null}
      </div>
      {expanded ? (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode
              key={k}
              value={v}
              {...(isArray ? {} : { label: k })}
              signal={signal}
              depth={depth + 1}
              isLast={i === entries.length - 1}
            />
          ))}
          <div
            style={{ paddingLeft: depth * 14 }}
            className="text-muted-foreground"
          >
            {close}
            {trailingComma}
          </div>
        </>
      ) : null}
    </div>
  )
}

function PrimitiveValue({ value }: { value: unknown }): JSX.Element {
  if (typeof value === "string") {
    return (
      <span className="text-emerald-700 dark:text-emerald-400">
        {JSON.stringify(value)}
      </span>
    )
  }
  if (typeof value === "number") {
    return (
      <span className="text-violet-700 dark:text-violet-400">
        {String(value)}
      </span>
    )
  }
  if (typeof value === "boolean") {
    return (
      <span className="text-sky-700 dark:text-sky-400">{String(value)}</span>
    )
  }
  if (value === null) {
    return <span className="text-muted-foreground">null</span>
  }
  return <span className="text-foreground">{String(value)}</span>
}
