// Drag-and-drop region. Wraps the main scroll area, shows an overlay while
// something is being dragged over the window, and yields the dropped files
// to the caller — preserving subfolder structure when the user drops an
// actual directory (via webkitGetAsEntry).

import { useRef, useState, type ReactNode } from "react"
import { Upload } from "lucide-react"
import { cn } from "@/lib/utils"
import type { IncomingFile } from "@/lib/kb"

type Props = {
  onDrop: (incoming: ReadonlyArray<IncomingFile>) => void
  // Caption shown in the overlay (typically the destination path).
  destinationLabel: string
  className?: string
  children: ReactNode
}

const readDirEntries = (
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const readBatch = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all)
          } else {
            all.push(...batch)
            readBatch()
          }
        },
        (err) => {
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    }
    readBatch()
  })

const fileFromEntry = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => {
    entry.file(resolve, (err) => {
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })

const walkEntry = async (
  entry: FileSystemEntry,
  base: string,
): Promise<IncomingFile[]> => {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry)
    return [{ file, relativePath: base + entry.name }]
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const children = await readDirEntries(reader)
    const all: IncomingFile[] = []
    for (const child of children) {
      const sub = await walkEntry(child, `${base}${entry.name}/`)
      all.push(...sub)
    }
    return all
  }
  return []
}

export function DropZone({
  onDrop,
  destinationLabel,
  className,
  children,
}: Props): JSX.Element {
  const [hovering, setHovering] = useState(false)
  // Child elements bubble dragenter/dragleave events; track depth so the
  // overlay only hides when the cursor actually leaves the outer container.
  const depth = useRef(0)

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    depth.current = 0
    setHovering(false)

    const items = e.dataTransfer.items
    const fallback = e.dataTransfer.files

    // Prefer the DataTransferItemList path — gives us folder support via
    // webkitGetAsEntry. Falls back to a flat list of files if unavailable.
    const entries: FileSystemEntry[] = []
    if (items.length > 0) {
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i]
        if (!it) continue
        const entry = it.webkitGetAsEntry()
        if (entry) {
          entries.push(entry)
        }
      }
    }

    if (entries.length > 0) {
      void (async (): Promise<void> => {
        const all: IncomingFile[] = []
        for (const e0 of entries) {
          const sub = await walkEntry(e0, "")
          all.push(...sub)
        }
        if (all.length > 0) {
          onDrop(all)
        }
      })()
      return
    }

    // No DataTransferItemList — pull plain Files.
    const flat: IncomingFile[] = []
    for (let i = 0; i < fallback.length; i += 1) {
      const f = fallback.item(i)
      if (f) {
        flat.push({ file: f, relativePath: f.name })
      }
    }
    if (flat.length > 0) {
      onDrop(flat)
    }
  }

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e): void => {
        // Only react when the drag actually carries files.
        if (!e.dataTransfer.types.includes("Files")) {
          return
        }
        depth.current += 1
        if (!hovering) {
          setHovering(true)
        }
      }}
      onDragOver={(e): void => {
        if (!e.dataTransfer.types.includes("Files")) {
          return
        }
        // Must call preventDefault to opt in as a drop target.
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={(): void => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) {
          setHovering(false)
        }
      }}
      onDrop={handleDrop}
    >
      {children}
      {hovering ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="animate-fade-up flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-ring/60 bg-surface-elevated px-6 py-5 text-center shadow-sm">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-secondary text-foreground">
              <Upload className="h-4 w-4" aria-hidden strokeWidth={1.75} />
            </span>
            <p className="text-[13.5px] font-medium text-foreground">
              Drop to add to{" "}
              <span className="text-foreground">{destinationLabel}</span>
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              Files and folders are uploaded with their structure preserved.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
