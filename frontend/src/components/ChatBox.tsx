import {
  ArrowRight,
  LoaderCircle,
  File,
  Trash2,
  Globe,
  Paperclip,
} from "lucide-react"
import { useEffect, useRef } from "react"

interface ChatBoxProps {
  query: string
  setQuery: (query: string) => void
  handleSend: (messageToSend: string) => void
  stagedFiles: File[]
  handleFileRemove: (index: number) => void
  handleFileSelection: (event: React.ChangeEvent<HTMLInputElement>) => void
  loading: boolean
  isStreaming?: boolean
}

export const getFileTypeName = (fileType: string): string => {
  if (fileType === "application/pdf") {
    return "PDF"
  } else {
    return ""
  }
}

export const ChatBox = ({
  query,
  setQuery,
  handleSend,
  stagedFiles,
  handleFileRemove,
  handleFileSelection,
  loading,
  isStreaming = false,
}: ChatBoxProps) => {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
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
    <div className="flex flex-col w-full border rounded-[20px] sticky bottom-[20px] bg-white">
      <div className="relative flex-col items-center">
        {stagedFiles?.length > 0 && (
          <div className="flex w-full">
            <ul className="flex overflow-x-auto space-x-4 p-2">
              {stagedFiles.map((file, index) => (
                <li
                  key={index}
                  className="flex items-center p-2 border rounded border-gray-300 min-w-[200px] max-w-[200px]"
                >
                  <div className="flex items-center justify-center w-8 h-8 mr-2 bg-gray-100 rounded">
                    <File className="text-black" size={16} />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-gray-700 truncate max-w-[100px]">
                      {file.name}
                    </span>
                    <span className="text-xs font-medium text-gray-700 truncate max-w-[100px]">
                      {getFileTypeName(file.type) ?? null}
                    </span>
                  </div>
                  <button
                    className="ml-auto text-sm"
                    onClick={() => handleFileRemove(index)}
                  >
                    <Trash2
                      className="text-red-500 hover:text-red-700"
                      size={16}
                    />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex">
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
                if (!isStreaming) {
                  handleSend(query)
                }
              }
            }}
            style={{
              height: "auto",
              minHeight: "40px",
              maxHeight: "108px",
            }}
          />
        </div>
      </div>
      <div
        className="flex ml-[16px] mr-[6px] mb-[6px] items-center space-x-3 pt-2 cursor-text"
        onClick={() => {
          inputRef?.current?.focus()
        }}
      >
        <button onClick={() => fileInputRef.current!.click()}>
          <Paperclip size={16} className="text-[#464D53] cursor-pointer" />
        </button>
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: "none" }}
          onChange={handleFileSelection}
          multiple
        />

        <Globe size={16} className="text-[#464D53] cursor-pointer" />
        {loading ? (
          <span
            style={{ marginLeft: "auto" }}
            className="flex mr-6 bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-full w-[32px] h-[32px] items-center justify-center"
          >
            <LoaderCircle className="text-white animate-spin" size={16} />
          </span>
        ) : (
          <button
            disabled={isStreaming}
            onClick={() => handleSend(query)}
            style={{ marginLeft: "auto" }}
            className={`flex mr-6 bg-[#464B53] text-white ${!isStreaming ? "hover:bg-[#5a5f66]" : ""}  rounded-full w-[32px] h-[32px] items-center justify-center disabled:opacity-50`}
          >
            <ArrowRight className="text-white" size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
