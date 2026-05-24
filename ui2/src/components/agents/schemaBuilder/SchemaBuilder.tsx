// Visual schema builder for Extractor agents. The user adds fields
// (name + type + required + description); the parent receives the
// updated ExtractorSchema and serialises to JSON Schema on submit.
//
// Supported types: string / number / boolean / enum / array / object.
// Array items and object properties recurse into the same row UI so
// arbitrarily nested shapes are reachable.
//
// Toolbar above the field list switches between the visual builder
// and a read-only JSON Schema preview, and bulk-toggles all field
// rows expanded / collapsed via a small "signal" prop threaded
// through the recursive FieldRow children.

import { useEffect, useState } from "react"
import {
  Check,
  ChevronRight,
  Code2,
  Copy,
  GripVertical,
  Layers,
  ListTree,
  Plus,
  Trash2,
} from "lucide-react"

import { type ExpandSignal, JsonNode } from "@/components/JsonTree"
import {
  type ExtractorSchema,
  type SchemaField,
  type SchemaPrimitiveType,
  emptyField,
  toJsonSchema,
} from "./types"

const TYPES: ReadonlyArray<{ value: SchemaPrimitiveType; label: string }> = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "enum", label: "Enum" },
  { value: "array", label: "List" },
  { value: "object", label: "Object" },
]

type Props = {
  value: ExtractorSchema
  onChange: (next: ExtractorSchema) => void
}

export function SchemaBuilder({ value, onChange }: Props): JSX.Element {
  const [view, setView] = useState<"builder" | "json">("builder")
  const [expandSignal, setExpandSignal] = useState<ExpandSignal | null>(null)
  const [jsonSignal, setJsonSignal] = useState<ExpandSignal | null>(null)
  const [copied, setCopied] = useState(false)

  const update = (fields: SchemaField[]): void => {
    onChange({ ...value, fields })
  }

  const expandAll = (): void => {
    setExpandSignal({ token: Date.now(), expand: true })
  }
  const collapseAll = (): void => {
    setExpandSignal({ token: Date.now(), expand: false })
  }

  const jsonText = JSON.stringify(toJsonSchema(value), null, 2)

  const copyJson = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(jsonText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore — older browsers / insecure contexts
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Schema view"
          className="inline-flex items-center rounded-md border border-border bg-surface-elevated p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "builder"}
            onClick={(): void => setView("builder")}
            className={
              "inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition " +
              (view === "builder"
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <ListTree className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            Builder
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "json"}
            onClick={(): void => setView("json")}
            className={
              "inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition " +
              (view === "json"
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Code2 className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            JSON Schema
          </button>
        </div>

        {view === "builder" ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={expandAll}
              disabled={value.fields.length === 0}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11.5px] text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title="Expand all fields"
            >
              <Layers className="h-3 w-3" aria-hidden strokeWidth={1.75} />
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              disabled={value.fields.length === 0}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11.5px] text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title="Collapse all fields"
            >
              <Layers className="h-3 w-3 rotate-180" aria-hidden strokeWidth={1.75} />
              Collapse all
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(): void =>
                setJsonSignal({ token: Date.now(), expand: true })
              }
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11.5px] text-muted-foreground transition hover:text-foreground"
              title="Expand all keys"
            >
              <Layers className="h-3 w-3" aria-hidden strokeWidth={1.75} />
              Expand all
            </button>
            <button
              type="button"
              onClick={(): void =>
                setJsonSignal({ token: Date.now(), expand: false })
              }
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11.5px] text-muted-foreground transition hover:text-foreground"
              title="Collapse all keys"
            >
              <Layers
                className="h-3 w-3 rotate-180"
                aria-hidden
                strokeWidth={1.75}
              />
              Collapse all
            </button>
            <button
              type="button"
              onClick={(): void => {
                void copyJson()
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11.5px] text-muted-foreground transition hover:text-foreground"
              title="Copy JSON Schema"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3" aria-hidden strokeWidth={2} />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" aria-hidden strokeWidth={1.75} />
                  Copy
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {view === "json" ? (
        <div className="max-h-[480px] overflow-auto rounded-md border border-border bg-surface-muted/30 p-3 font-mono text-[12px] leading-relaxed text-foreground">
          <JsonNode
            value={toJsonSchema(value)}
            signal={jsonSignal}
            depth={0}
          />
        </div>
      ) : (
        <>
          <div className="rounded-md border border-border/60 bg-surface-muted/20 p-3">
            <label className="block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
              Schema description (optional)
            </label>
            <input
              type="text"
              value={value.description ?? ""}
              onChange={(e): void =>
                onChange({ ...value, description: e.target.value })
              }
              placeholder="e.g. Extracted invoice fields"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-2">
            {value.fields.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/60 bg-surface-muted/10 px-3 py-4 text-center text-[12.5px] text-muted-foreground">
                No fields yet. Add one below to define what the LLM should
                return.
              </div>
            ) : (
              value.fields.map((field, i) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  expandSignal={expandSignal}
                  onChange={(next): void => {
                    const copy = value.fields.slice()
                    copy[i] = next
                    update(copy)
                  }}
                  onRemove={(): void => {
                    update(value.fields.filter((_, j) => j !== i))
                  }}
                />
              ))
            )}
          </div>

          <button
            type="button"
            onClick={(): void => update([...value.fields, emptyField()])}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border bg-background px-2.5 text-[12.5px] text-muted-foreground transition hover:border-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            Add field
          </button>
        </>
      )}
    </div>
  )
}

function FieldRow({
  field,
  expandSignal,
  onChange,
  onRemove,
}: {
  field: SchemaField
  expandSignal: ExpandSignal | null
  onChange: (next: SchemaField) => void
  onRemove: () => void
}): JSX.Element {
  const isStructured =
    field.type === "object" || field.type === "array" || field.type === "enum"
  const [expanded, setExpanded] = useState(isStructured || !!field.description)

  useEffect(() => {
    if (expandSignal) setExpanded(expandSignal.expand)
  }, [expandSignal])

  const set = <K extends keyof SchemaField>(k: K, v: SchemaField[K]): void =>
    onChange({ ...field, [k]: v })

  const handleTypeChange = (t: SchemaPrimitiveType): void => {
    const next: SchemaField = { ...field, type: t }
    if (t !== "enum") delete next.enumValues
    if (t !== "array") delete next.itemType
    if (t !== "object") delete next.properties
    if (t === "enum" && !next.enumValues) next.enumValues = []
    if (t === "array" && !next.itemType) {
      next.itemType = emptyField("item")
      next.itemType.required = true
    }
    if (t === "object" && !next.properties) next.properties = []
    if (t === "enum" || t === "array" || t === "object") setExpanded(true)
    onChange(next)
  }

  return (
    <div className="rounded-md border border-border/60 bg-background/40">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={(): void => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse field" : "Expand field"}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground/70 transition hover:text-foreground"
        >
          <ChevronRight
            className={
              "h-3 w-3 transition-transform " + (expanded ? "rotate-90" : "")
            }
            aria-hidden
            strokeWidth={2}
          />
        </button>
        <GripVertical
          className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40"
          aria-hidden
          strokeWidth={1.75}
        />
        <input
          type="text"
          value={field.name}
          onChange={(e): void => set("name", e.target.value)}
          placeholder="field_name"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <select
          value={field.type}
          onChange={(e): void =>
            handleTypeChange(e.target.value as SchemaPrimitiveType)
          }
          className="rounded-md border border-border bg-background px-2 py-1 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <label className="inline-flex flex-shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground">
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e): void => set("required", e.target.checked)}
            className="h-3.5 w-3.5 accent-foreground"
          />
          required
        </label>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove field"
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground/70 transition hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-border/40 px-2 py-2">
          <div>
            <label className="block text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
              Description
            </label>
            <input
              type="text"
              value={field.description ?? ""}
              onChange={(e): void => set("description", e.target.value)}
              placeholder="Hint to the model about this field"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {field.type === "enum" && (
            <EnumEditor
              values={field.enumValues ?? []}
              onChange={(next): void => set("enumValues", next)}
            />
          )}

          {field.type === "array" && field.itemType && (
            <div>
              <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
                Item type
              </label>
              <FieldRow
                field={field.itemType}
                expandSignal={expandSignal}
                onChange={(next): void => set("itemType", next)}
                onRemove={(): void => {
                  set("itemType", emptyField("item"))
                }}
              />
            </div>
          )}

          {field.type === "object" && (
            <div>
              <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
                Properties
              </label>
              <div className="space-y-1.5 pl-3">
                {(field.properties ?? []).map((p, i) => (
                  <FieldRow
                    key={p.id}
                    field={p}
                    expandSignal={expandSignal}
                    onChange={(next): void => {
                      const copy = (field.properties ?? []).slice()
                      copy[i] = next
                      set("properties", copy)
                    }}
                    onRemove={(): void => {
                      set(
                        "properties",
                        (field.properties ?? []).filter((_, j) => j !== i),
                      )
                    }}
                  />
                ))}
                <button
                  type="button"
                  onClick={(): void =>
                    set("properties", [...(field.properties ?? []), emptyField()])
                  }
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-background px-2 text-[11.5px] text-muted-foreground transition hover:border-foreground hover:text-foreground"
                >
                  <Plus className="h-3 w-3" aria-hidden strokeWidth={1.75} />
                  Add property
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EnumEditor({
  values,
  onChange,
}: {
  values: string[]
  onChange: (next: string[]) => void
}): JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
        Allowed values
      </label>
      <div className="space-y-1">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="text"
              value={v}
              onChange={(e): void => {
                const copy = values.slice()
                copy[i] = e.target.value
                onChange(copy)
              }}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={(): void => onChange(values.filter((_, j) => j !== i))}
              aria-label="Remove value"
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground/70 transition hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" aria-hidden strokeWidth={1.75} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={(): void => onChange([...values, ""])}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-background px-2 text-[11.5px] text-muted-foreground transition hover:border-foreground hover:text-foreground"
        >
          <Plus className="h-3 w-3" aria-hidden strokeWidth={1.75} />
          Add value
        </button>
      </div>
    </div>
  )
}
