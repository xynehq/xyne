import xyneLogo from "@/assets/xyne_logo.png"

type Props = {
  className?: string
  withWordmark?: boolean
  size?: "sm" | "md" | "lg"
}

const dims = {
  sm: 16,
  md: 22,
  lg: 32,
} as const

export function BrandMark({
  className,
  withWordmark = true,
  size = "md",
}: Props): JSX.Element {
  const d = dims[size]
  return (
    <span
      className={"inline-flex items-center gap-2 " + (className ?? "")}
    >
      <img
        src={xyneLogo}
        alt="xyne"
        width={d}
        height={d}
        style={{ width: `${String(d)}px`, height: `${String(d)}px` }}
      />
      {withWordmark && (
        <span className="font-display text-[18px] leading-none tracking-tight text-foreground">
          xyne
        </span>
      )}
    </span>
  )
}
