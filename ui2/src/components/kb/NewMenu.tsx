// "+ New" toolbar entry. Owns the hidden file + folder pickers and yields
// the resulting File lists to the caller; the route decides what to do
// with them (enqueue uploads into the store, etc.).

import { useEffect, useRef } from "react"
import { ChevronDown, FolderPlus, FolderUp, Plus, Upload } from "lucide-react"
import { MenuPopover } from "@/components/MenuPopover"
import type { IncomingFile } from "@/lib/kb"

type Props = {
  onNewFolder: () => void
  onFiles: (incoming: ReadonlyArray<IncomingFile>) => void
  onFolder: (incoming: ReadonlyArray<IncomingFile>) => void
}

const toIncoming = (
  list: FileList | null,
  useRelative: boolean,
): IncomingFile[] => {
  if (!list) {
    return []
  }
  const out: IncomingFile[] = []
  for (let i = 0; i < list.length; i += 1) {
    const f = list.item(i)
    if (!f) {
      continue
    }
    // `webkitRelativePath` is the only way to recover folder structure from
    // a directory <input>. Plain file pickers leave it as "".
    const rel = useRelative && f.webkitRelativePath ? f.webkitRelativePath : f.name
    out.push({ file: f, relativePath: rel })
  }
  return out
}

export function NewMenu({
  onNewFolder,
  onFiles,
  onFolder,
}: Props): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)

  // `webkitdirectory` is non-standard, set imperatively to keep the JSX
  // attributes table happy under strict TS.
  useEffect((): void => {
    const el = folderInputRef.current
    if (!el) {
      return
    }
    el.setAttribute("webkitdirectory", "")
    el.setAttribute("directory", "")
  }, [])

  return (
    <>
      <MenuPopover
        align="right"
        trigger={({ open, toggle }): JSX.Element => (
          <button
            type="button"
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            className={
              "inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-3 text-[12.5px] font-medium text-foreground transition hover:bg-secondary/60 " +
              (open ? "bg-secondary/60" : "")
            }
          >
            <Plus className="h-3.5 w-3.5" aria-hidden strokeWidth={2} />
            <span>New</span>
            <ChevronDown className="h-3 w-3 opacity-60" aria-hidden strokeWidth={2} />
          </button>
        )}
        items={[
          {
            icon: FolderPlus,
            label: "New folder",
            onClick: onNewFolder,
          },
          {
            icon: Upload,
            label: "Upload files",
            onClick: (): void => {
              fileInputRef.current?.click()
            },
          },
          {
            icon: FolderUp,
            label: "Upload folder",
            onClick: (): void => {
              folderInputRef.current?.click()
            },
          },
        ]}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e): void => {
          const incoming = toIncoming(e.target.files, false)
          // Reset so picking the same file twice re-fires the change event.
          e.target.value = ""
          if (incoming.length > 0) {
            onFiles(incoming)
          }
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        hidden
        onChange={(e): void => {
          const incoming = toIncoming(e.target.files, true)
          e.target.value = ""
          if (incoming.length > 0) {
            onFolder(incoming)
          }
        }}
      />
    </>
  )
}
