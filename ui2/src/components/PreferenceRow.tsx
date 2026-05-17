import { Toggle } from "./Toggle"

type Props = {
  label: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}

// Composite row used inside the Account → Preferences card: title + helper
// text on the left, switch on the right. Generic enough to stack any number
// of boolean preferences in a styled container — preference identity stays
// at the call site so this row carries no feature-specific knowledge.
export function PreferenceRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: Props): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-foreground">{label}</div>
        <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
          {description}
        </p>
      </div>
      <Toggle
        checked={checked}
        onChange={onChange}
        ariaLabel={label}
        disabled={disabled}
      />
    </div>
  )
}
