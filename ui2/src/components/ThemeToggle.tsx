import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme, type ThemeMode } from "@/lib/theme"

const options: Array<{
  value: ThemeMode
  label: string
  icon: typeof Sun
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

export function ThemeToggle(): JSX.Element {
  const { theme, setTheme } = useTheme()
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="relative inline-flex items-center rounded-full border border-border bg-surface p-0.5 shadow-[inset_0_-1px_0_hsl(var(--border)/0.4)]"
    >
      {options.map((opt) => {
        const active = theme === opt.value
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => {
              setTheme(opt.value)
            }}
            className={
              "relative inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-200 " +
              (active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Icon className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </button>
        )
      })}
    </div>
  )
}
