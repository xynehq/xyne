import {
  ArrowRight,
  Atom,
  Globe,
  Infinity,
  Sparkles,
  Square,
} from "lucide-react"
import { useEffect, useRef, Dispatch, SetStateAction } from "react"

interface ChatBoxProps {
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  handleSend: (message: string) => void
  isStreaming: boolean
  isAgenticMode?: boolean
  setIsAgenticMode: Dispatch<SetStateAction<boolean>>
  handleStop?: () => void
  chatId?: string | null
}

export const ChatBox: React.FC<ChatBoxProps> = ({
  query,
  setQuery,
  handleSend,
  isStreaming = false,
  isAgenticMode = false,
  setIsAgenticMode,
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
    <div className="flex flex-col w-full border rounded-[20px] sticky bottom-[20px] bg-white max-w-3xl">
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
        className="flex ml-[16px] mr-[6px] mb-[6px] items-center pt-2 cursor-text"
        onClick={() => {
          inputRef?.current?.focus()
        }}
      >
        {/* <Attach className="text-[#464D53] cursor-pointer" />
        <Globe size={16} className="text-[#464D53] cursor-pointer" /> */}
        <div
          onClick={(e) => {
            e.stopPropagation()
            setIsAgenticMode(!isAgenticMode)
          }}
          className={`flex items-center justify-center rounded-full cursor-pointer mr-[18px]`}
        >
          <Infinity
            size={14}
            strokeWidth={2.4}
            className={`${isAgenticMode ? "text-blue-500" : "text-[#464D53]"} ${isAgenticMode ? "font-medium" : ""}`}
          />
          <span
            className={`text-[14px] leading-[16px] ml-[4px] select-none font-medium ${isAgenticMode ? "text-blue-500" : "text-[#464D53]"}`}
          >
            Agent
          </span>
        </div>
        {isStreaming && chatId ? (
          <button
            onClick={handleStop}
            style={{ marginLeft: "auto" }}
            className="flex bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-full w-[32px] h-[32px] items-center justify-center"
          >
            <Square className="text-white" size={16} />
          </button>
        ) : (
          <button
            disabled={isStreaming}
            onClick={() => handleSend(query)}
            style={{ marginLeft: "auto" }}
            className="flex bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-full w-[32px] h-[32px] items-center justify-center disabled:opacity-50"
          >
            <ArrowRight className="text-white" size={16} />
          </button>
        )}
      </div>
      <div className="absolute right-[14px] bottom-[10px] flex items-center"></div>
    </div>
  )
}
