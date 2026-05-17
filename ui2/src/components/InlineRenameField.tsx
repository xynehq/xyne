import { useInlineEdit } from "@/hooks/useInlineEdit"

type Props = {
  initial: string
  placeholder?: string
  onCommit: (next: string) => void | Promise<void>
  onCancel: () => void
  className?: string
  inputClassName?: string
}

export function InlineRenameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
  className,
  inputClassName,
}: Props): JSX.Element {
  const { value, setValue, inputRef, onKeyDown, onBlur } = useInlineEdit({
    initial,
    onCommit,
    onCancel,
  })
  return (
    <div
      className={
        className ?? "flex h-9 items-center rounded-lg bg-secondary px-2"
      }
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e): void => {
          setValue(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        placeholder={placeholder}
        aria-label="Edit"
        className={
          inputClassName ??
          "h-7 w-full min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-[13px] text-foreground focus:outline-none"
        }
      />
    </div>
  )
}
