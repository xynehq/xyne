import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"

type Args = {
  initial: string
  onCommit: (next: string) => void | Promise<void>
  onCancel: () => void
}

type Result = {
  value: string
  setValue: (next: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void
  onBlur: () => void
}

export function useInlineEdit({ initial, onCommit, onCancel }: Args): Result {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const doneRef = useRef(false)

  useEffect((): void => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    void onCommit(value.trim())
  }
  const cancel = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }

  return {
    value,
    setValue,
    inputRef,
    onKeyDown: (e): void => {
      if (e.key === "Enter") {
        e.preventDefault()
        commit()
      } else if (e.key === "Escape") {
        e.preventDefault()
        cancel()
      }
    },
    onBlur: commit,
  }
}
