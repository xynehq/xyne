// Tiny paper-like preview card for a file. Each format gets a subtly different
// interior so the card itself communicates "this is a spreadsheet / a slide
// deck / an archive" before the user reads the filename. Banner uses
// information-bearing color (pdf=red, xlsx=green, …) — the only place we let
// non-neutral color in; the surrounding chrome stays on xyne tokens.

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export type FileFormat =
  | "doc"
  | "docx"
  | "pdf"
  | "md"
  | "mdx"
  | "csv"
  | "xls"
  | "xlsx"
  | "txt"
  | "ppt"
  | "pptx"
  | "zip"
  | "rar"
  | "tar"
  | "gz"
  | "code"
  | "html"
  | "js"
  | "jsx"
  | "tsx"
  | "ts"
  | "css"
  | "json"
  | "img"
  | "png"
  | "jpg"
  | "jpeg"
  | "gif"
  | "webp"
  | "mp4"
  | "mov"
  | "webm"
  | "mp3"
  | "wav"
  | "flac"
  | "video"

type Props = {
  format: FileFormat | string
  size?: "sm" | "md"
}

const BANNER: Record<string, string> = {
  doc: "bg-blue-500 text-white",
  docx: "bg-blue-500 text-white",
  pdf: "bg-red-500 text-white",
  md: "bg-neutral-600 text-white",
  mdx: "bg-neutral-600 text-white",
  txt: "bg-gray-500 text-white",
  csv: "bg-teal-700 text-white",
  xls: "bg-emerald-600 text-white",
  xlsx: "bg-emerald-600 text-white",
  ppt: "bg-orange-500 text-white",
  pptx: "bg-orange-500 text-white",
  zip: "bg-purple-500 text-white",
  rar: "bg-purple-600 text-white",
  tar: "bg-yellow-600 text-white",
  gz: "bg-yellow-700 text-white",
  html: "bg-orange-600 text-white",
  js: "bg-yellow-600 text-white",
  jsx: "bg-blue-600 text-white",
  css: "bg-blue-600 text-white",
  json: "bg-yellow-500 text-white",
  tsx: "bg-blue-600 text-white",
  ts: "bg-blue-600 text-white",
  code: "bg-orange-600 text-white",
  img: "bg-pink-500 text-white",
  png: "bg-neutral-600 text-white",
  jpg: "bg-green-700 text-white",
  jpeg: "bg-green-700 text-white",
  gif: "bg-pink-600 text-white",
  webp: "bg-pink-500 text-white",
  mp4: "bg-green-700 text-white",
  mov: "bg-green-700 text-white",
  webm: "bg-green-700 text-white",
  mp3: "bg-fuchsia-600 text-white",
  wav: "bg-fuchsia-600 text-white",
  flac: "bg-fuchsia-700 text-white",
  video: "bg-green-700 text-white",
}

const DefaultLines = (): JSX.Element => (
  <div className="space-y-1.5">
    <div className="flex gap-2">
      <div className="h-0.5 w-1/2 rounded-full bg-foreground/20" />
    </div>
    <div className="flex gap-1">
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
    </div>
    <div className="flex gap-1">
      <div className="h-0.5 w-1/2 rounded-full bg-foreground/10" />
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
    </div>
    <div className="flex gap-1">
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
    </div>
    <div className="flex gap-1">
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
      <div className="h-0.5 w-1/2 rounded-full bg-foreground/10" />
    </div>
    <div className="flex gap-1">
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
    </div>
  </div>
)

const MarkdownInterior = (): JSX.Element => (
  <div className="space-y-1.5">
    <div className="flex items-center gap-1">
      <div className="text-[10px] font-bold text-foreground/30">#</div>
      <div className="h-0.5 w-6 rounded-full bg-foreground/20" />
    </div>
    <div className="space-y-1">
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
      <div className="h-0.5 w-7 rounded-full bg-foreground/10" />
    </div>
    <div className="space-y-1">
      <div className="h-0.5 w-8 rounded-full bg-foreground/10" />
      <div className="h-0.5 w-4 rounded-full bg-foreground/10" />
      <div className="h-0.5 w-1/3 rounded-full bg-foreground/10" />
    </div>
  </div>
)

const SpreadsheetInterior = (): JSX.Element => (
  <div className="space-y-0.5">
    <div className="grid grid-cols-3 gap-0.5">
      <div className="h-2 bg-foreground/20" />
      <div className="h-2 bg-foreground/20" />
      <div className="h-2 bg-foreground/20" />
    </div>
    <div className="grid grid-cols-3 gap-0.5">
      <div className="h-2 bg-foreground/5" />
      <div className="h-2 bg-foreground/5" />
      <div className="h-2 bg-foreground/5" />
      <div className="h-2 bg-foreground/5" />
      <div className="h-2 bg-foreground/5" />
      <div className="h-2 bg-foreground/5" />
    </div>
    <div className="grid grid-cols-3 gap-0.5">
      <div className="h-2 bg-foreground/5" />
      <div className="h-2 bg-foreground/5" />
    </div>
    <div className="grid grid-cols-3 gap-0.5">
      <div className="h-2 bg-foreground/5" />
    </div>
  </div>
)

const CsvInterior = (): JSX.Element => (
  <>
    <div className="mb-2 grid grid-cols-3 gap-0.5">
      <div className="h-1.5 rounded-full bg-foreground/20" />
      <div className="h-1.5 rounded-full bg-foreground/20" />
      <div className="h-1.5 rounded-full bg-foreground/20" />
    </div>
    <div className="space-y-1.5">
      <div className="grid grid-cols-3 gap-0.5">
        <div className="h-1 rounded-full bg-foreground/5" />
        <div className="h-1 rounded-full bg-foreground/5" />
        <div className="h-1 rounded-full bg-foreground/5" />
      </div>
      <div className="grid grid-cols-3 gap-0.5">
        <div className="h-1 rounded-full bg-foreground/5" />
        <div className="h-1 rounded-full bg-foreground/5" />
        <div className="h-1 rounded-full bg-foreground/5" />
      </div>
      <div className="grid grid-cols-3 gap-0.5">
        <div className="h-1 rounded-full bg-foreground/5" />
        <div className="h-1 rounded-full bg-foreground/5" />
      </div>
      <div className="grid grid-cols-3 gap-0.5">
        <div className="h-1 rounded-full bg-foreground/5" />
      </div>
    </div>
  </>
)

const ArchiveInterior = (): JSX.Element => (
  <div className="relative flex h-full flex-col items-center justify-center">
    <div className="space-y-0">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="flex overflow-hidden rounded-full">
          <div
            className={cn(
              "size-1.5",
              i % 2 === 0 ? "bg-foreground/20" : "bg-foreground/5",
            )}
          />
          <div
            className={cn(
              "size-1.5",
              i % 2 === 0 ? "bg-foreground/5" : "bg-foreground/20",
            )}
          />
        </div>
      ))}
    </div>
  </div>
)

const SlideInterior = (): JSX.Element => (
  <>
    <div className="mb-1.5 space-y-1 rounded border border-border bg-foreground/5 p-1">
      <div className="flex justify-center gap-1">
        <div className="size-3 rounded-sm bg-orange-400/40" />
      </div>
      <div className="mx-auto h-[3px] w-8 rounded-full bg-foreground/15" />
    </div>
    <div className="mb-1 flex justify-center gap-1">
      <div className="h-[3px] w-8 rounded-full bg-foreground/15" />
      <div className="h-[3px] w-4 rounded-full bg-foreground/15" />
    </div>
    <div className="space-y-1">
      <div className="h-[3px] w-4 rounded-full bg-foreground/15" />
      <div className="h-[3px] w-5 rounded-full bg-foreground/15" />
    </div>
  </>
)

const ImageInterior = (): JSX.Element => (
  <div className="mb-1.5 space-y-1 rounded border border-border bg-foreground/5 p-1">
    <div className="flex justify-center gap-1">
      <div className="size-3 rounded-sm bg-yellow-400/40" />
    </div>
    <div className="mx-auto mt-1 h-[3px] w-4 rounded-full bg-foreground/15" />
    <div className="mx-auto h-[3px] w-8 rounded-full bg-foreground/15" />
  </div>
)

const VideoInterior = (): JSX.Element => (
  <div className="mb-1.5 space-y-1 rounded border border-border bg-foreground/5 p-1">
    <div className="flex justify-center gap-1">
      <div className="size-0 border-y-[5px] border-l-8 border-y-transparent border-l-green-400/60" />
    </div>
    <div className="mx-auto mt-1 h-[3px] w-4 rounded-full bg-foreground/15" />
    <div className="mx-auto h-[3px] w-8 rounded-full bg-foreground/15" />
  </div>
)

const AudioInterior = (): JSX.Element => (
  <div className="flex h-full items-end justify-center gap-[3px] py-1">
    {[3, 6, 4, 8, 5, 7, 4, 6, 3].map((h, i) => (
      <div
        key={i}
        className="w-[2px] rounded-full bg-fuchsia-400/60"
        style={{ height: `${h * 3}px` }}
      />
    ))}
  </div>
)

const CodeInterior = (): JSX.Element => (
  <div className="space-y-1">
    <div className="flex items-center gap-0.5">
      <div className="font-mono text-[5px] text-foreground/30">&lt;</div>
      <div className="h-[3px] w-3 rounded-full bg-emerald-400/60" />
      <div className="font-mono text-[5px] text-foreground/30">&gt;</div>
    </div>
    <div className="flex items-center gap-0.5 pl-1">
      <div className="font-mono text-[5px] text-foreground/30">&lt;</div>
      <div className="h-[3px] w-2.5 rounded-full bg-sky-400/60" />
      <div className="font-mono text-[5px] text-foreground/30">&gt;</div>
    </div>
    <div className="flex items-center gap-0.5 pl-1">
      <div className="font-mono text-[5px] text-foreground/30">&lt;/</div>
      <div className="h-[3px] w-2.5 rounded-full bg-sky-400/60" />
      <div className="font-mono text-[5px] text-foreground/30">&gt;</div>
    </div>
    <div className="flex items-center gap-0.5">
      <div className="font-mono text-[5px] text-foreground/30">&lt;</div>
      <div className="h-[3px] w-1 rounded-full bg-emerald-400/60" />
      <div className="font-mono text-[5px] text-foreground/30">/&gt;</div>
    </div>
  </div>
)

const CssInterior = (): JSX.Element => (
  <div className="space-y-1">
    <div className="font-mono text-[6px] text-foreground/40">{"{"}</div>
    <div className="flex items-center gap-1 pl-1.5">
      <div className="h-[3px] w-3 rounded-full bg-sky-400/60" />
      <div className="h-[3px] w-4 rounded-full bg-sky-400/60" />
    </div>
    <div className="flex items-center gap-1 pl-1.5">
      <div className="h-[3px] w-4 rounded-full bg-sky-400/60" />
      <div className="h-[3px] w-2 rounded-full bg-sky-400/60" />
    </div>
    <div className="flex items-center gap-1 pl-1.5">
      <div className="h-[3px] w-3 rounded-full bg-sky-400/60" />
      <div className="h-[3px] w-4 rounded-full bg-sky-400/60" />
    </div>
    <div className="font-mono text-[6px] text-foreground/40">{"}"}</div>
  </div>
)

const JsonInterior = (): JSX.Element => (
  <div className="space-y-1">
    <div className="font-mono text-[6px] text-foreground/40">{"{"}</div>
    <div className="flex items-center gap-1 pl-1.5">
      <div className="h-[3px] w-3 rounded-full bg-foreground/20" />
      <div className="h-[3px] w-4 rounded-full bg-foreground/20" />
    </div>
    <div className="flex items-center gap-1 pl-1.5">
      <div className="h-[3px] w-4 rounded-full bg-foreground/10" />
      <div className="h-[3px] w-2 rounded-full bg-foreground/10" />
    </div>
    <div className="flex items-center gap-1 pl-1.5">
      <div className="h-[3px] w-3 rounded-full bg-foreground/10" />
      <div className="h-[3px] w-4 rounded-full bg-foreground/10" />
    </div>
    <div className="flex items-center gap-1 pl-1.5">
      <div className="h-[3px] w-3 rounded-full bg-foreground/10" />
    </div>
    <div className="font-mono text-[6px] text-foreground/40">{"}"}</div>
  </div>
)

const interiorFor = (fmt: string): ReactNode => {
  switch (fmt) {
    case "md":
    case "mdx":
      return <MarkdownInterior />
    case "xls":
    case "xlsx":
      return <SpreadsheetInterior />
    case "csv":
      return <CsvInterior />
    case "zip":
    case "rar":
    case "tar":
    case "gz":
      return <ArchiveInterior />
    case "ppt":
    case "pptx":
      return <SlideInterior />
    case "img":
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return <ImageInterior />
    case "mp4":
    case "mov":
    case "webm":
    case "video":
      return <VideoInterior />
    case "mp3":
    case "wav":
    case "flac":
      return <AudioInterior />
    case "html":
    case "js":
    case "jsx":
    case "tsx":
    case "ts":
    case "code":
      return <CodeInterior />
    case "css":
      return <CssInterior />
    case "json":
      return <JsonInterior />
    default:
      return <DefaultLines />
  }
}

export function FileCard({ format, size = "md" }: Props): JSX.Element {
  const fmt = format.toLowerCase()
  const banner = BANNER[fmt] ?? "bg-zinc-500 text-white"
  const dims =
    size === "sm" ? "w-9 h-[3rem] p-1.5 space-y-2" : "w-14 h-[4.5rem] p-2 space-y-3"
  const bannerPos =
    size === "sm"
      ? "-right-1.5 bottom-1 text-[7px] px-1 py-px"
      : "-right-2 bottom-1.5 text-[8px] px-1.5 py-0.5"
  return (
    <div aria-hidden className="relative size-fit">
      <div
        className={cn(
          "absolute z-[2] rounded font-medium uppercase tracking-wide",
          bannerPos,
          banner,
        )}
      >
        {fmt}
      </div>
      <div
        className={cn(
          "relative z-[1] overflow-hidden rounded-md bg-surface ring-1 ring-border dark:bg-secondary",
          dims,
        )}
      >
        {interiorFor(fmt)}
      </div>
    </div>
  )
}
