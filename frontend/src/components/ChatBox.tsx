import { ArrowRight, Globe, Square } from "lucide-react"
import { useEffect, useRef } from "react"
import Attach from "@/assets/attach.svg?react"

interface ChatBoxProps {
  query: string
  setQuery: (query: string) => void
  handleSend: (messageToSend: string) => void
  isStreaming?: boolean
  handleStop?: () => void
  chatId?: string | null
}

export const ChatBox = ({
  query,
  setQuery,
  handleSend,
  isStreaming = false,
  handleStop,
  chatId,
}: ChatBoxProps) => {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      if (query) {
        const length = query.length
        inputRef.current.setSelectionRange(length, length)
      }
    }
  }, [])
  return (
    <div className="flex flex-col w-full border rounded-[20px] sticky bottom-[20px] bg-white  max-w-3xl">
      <div className="relative flex items-center">
        <textarea
          ref={inputRef}
          rows={1}
          placeholder="Ask anything across apps..."
          value={query}
          className="flex-grow resize-none bg-transparent outline-none text-[15px] font-[450] leading-[24px] text-[#1C1D1F] placeholder-[#ACBCCC] pl-[16px] pt-[14px] max-h-[108px] overflow-auto"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              handleSend(query)
            }
          }}
          style={{
            height: "auto",
            minHeight: "40px",
            maxHeight: "108px",
          }}
        />
      </div>
      <div
        className="flex ml-[16px] mr-[6px] mb-[6px] items-center space-x-3 pt-2 cursor-text"
        onClick={() => {
          inputRef?.current?.focus()
        }}
      >
        <Attach className="text-[#464D53] cursor-pointer" />
        <Globe size={16} className="text-[#464D53] cursor-pointer" />
        {isStreaming && chatId ? (
          <button
            onClick={handleStop}
            style={{ marginLeft: "auto" }}
            className="flex mr-6 bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-full w-[32px] h-[32px] items-center justify-center"
          >
            <Square className="text-white" size={16} />
          </button>
        ) : (
          <button
            disabled={isStreaming}
            onClick={() => handleSend(query)}
            style={{ marginLeft: "auto" }}
            className="flex mr-6 bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-full w-[32px] h-[32px] items-center justify-center disabled:opacity-50"
          >
            <ArrowRight className="text-white" size={16} />
          </button>
        )}
      </div>
    </div>
  )
}