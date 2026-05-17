import { cn } from "@/lib/utils"

type Props = {
  checked: boolean
  onChange: (next: boolean) => void
  ariaLabel: string
  disabled?: boolean
}

// Generic two-state switch. Mirrors the iOS toggle pattern — rail color flips
// on state, thumb slides between edges. Kept primitive-shaped (no preference-
// or feature-specific props) so it can be reused anywhere a boolean control
// is needed.
export function Toggle({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: Props): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(): void => {
        onChange(!checked)
      }}
      className={cn(
        "relative inline-flex h-[22px] w-10 flex-shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        checked ? "bg-primary" : "bg-border",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "block h-[18px] w-[18px] rounded-full bg-background shadow-sm transition-transform duration-200 ease-out",
          checked ? "translate-x-[18px]" : "translate-x-0",
        )}
      />
    </button>
  )
}
