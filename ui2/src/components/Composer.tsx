import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react"
import { useNavigate } from "@tanstack/react-router"
import { ArrowUp, Paperclip, Square } from "lucide-react"
import { ModelSelector } from "./ModelSelector"
import { AgentSelector } from "./AgentSelector"
import { ThinkingSelector } from "./ThinkingSelector"

type Props = {
  autoFocus?: boolean
  /**
   * When set, the composer assumes a chat is already in progress and submits
   * inline (caller is responsible for accepting the new message). Otherwise
   * the composer navigates to a freshly minted thread.
   */
  onSubmit?: (text: string) => void
  placeholder?: string
  /**
   * Seed the textarea with text from the outside (e.g. "Retry" prefilling the
   * last user message). Bump `key` to push a new seed even if `text` is the
   * same as before.
   */
  seed?: { text: string; key: number } | undefined
  hideDisclaimer?: boolean | undefined
  /**
   * When true, an assistant turn is streaming. We keep the textarea editable
   * (the user can compose their next message), but block submission and swap
   * the send button for a "stop" affordance ringed by an outline spinner.
   * Interrupt isn't wired server-side yet, so the stop button is visual only
   * — it just signals that we know they want to send and we're holding it.
   */
  pending?: boolean
  /** Called when the user clicks the stop button while `pending` is true.
   *  Should request a server-side interrupt of the in-flight assistant run. */
  onStop?: () => void
}

const newChatId = (): string => {
  // small, URL-safe id — replace with backendv2's id when wired up
  return (
    crypto.randomUUID().split("-")[0] ?? Math.random().toString(36).slice(2)
  )
}

export function Composer({
  autoFocus,
  onSubmit,
  placeholder = "Ask anything",
  seed,
  pending = false,
  onStop,
  hideDisclaimer,
}: Props): JSX.Element {
  const [value, setValue] = useState("")
  const navigate = useNavigate()
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const lastSeedKey = useRef<number | null>(null)

  // Seed: external prefill (e.g., Retry → last user message text).
  useEffect((): void => {
    if (!seed) {
      return
    }
    if (seed.key === lastSeedKey.current) {
      return
    }
    lastSeedKey.current = seed.key
    setValue(seed.text)
    requestAnimationFrame(() => {
      ref.current?.focus()
      const el = ref.current
      if (el) {
        el.selectionStart = el.value.length
        el.selectionEnd = el.value.length
      }
    })
  }, [seed])

  // Auto-grow textarea
  useEffect((): void => {
    const el = ref.current
    if (!el) {
      return
    }
    el.style.height = "0px"
    el.style.height = `${String(Math.min(el.scrollHeight, 200))}px`
  }, [value])

  useEffect((): void => {
    if (autoFocus) {
      ref.current?.focus()
    }
  }, [autoFocus])

  const submit = (): void => {
    if (pending) {
      return
    }
    const trimmed = value.trim()
    if (!trimmed) {
      return
    }
    if (onSubmit) {
      onSubmit(trimmed)
      setValue("")
      return
    }
    const id = newChatId()
    void navigate({
      to: "/c/$chatId",
      params: { chatId: id },
      search: { q: trimmed },
    })
    setValue("")
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    submit()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const canSend = value.trim().length > 0

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div className="group flex flex-col gap-1 rounded-3xl border border-border bg-surface-elevated px-3 pb-2 pt-3 shadow-[0_1px_0_hsl(var(--border)/0.5),0_8px_24px_-12px_hsl(var(--ring)/0.25)] transition focus-within:border-ring focus-within:shadow-[0_1px_0_hsl(var(--ring)/0.5),0_12px_30px_-12px_hsl(var(--ring)/0.35)]">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          className="min-h-[40px] resize-none bg-transparent px-2 py-1 text-[15px] leading-6 placeholder:text-muted-foreground/80 focus:outline-none"
        />

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Attach file"
            title="Attach"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Paperclip className="h-4 w-4" aria-hidden strokeWidth={1.75} />
          </button>

          <div className="ml-auto flex items-center gap-1.5">
            <AgentSelector />
            <ThinkingSelector />
            <ModelSelector />

            {pending ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                title="Stop"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90"
              >
                <Square
                  className="h-2.5 w-2.5 fill-current"
                  aria-hidden
                  strokeWidth={0}
                />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send"
                title="Send"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              >
                <ArrowUp className="h-4 w-4" aria-hidden strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
      {hideDisclaimer ? null : (
        <p className="mt-2 text-center text-[11px] text-muted-foreground/80">
          Xyne can make mistakes. Verify important details.
        </p>
      )}
    </form>
  )
}
