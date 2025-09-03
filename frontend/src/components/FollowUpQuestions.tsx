import React, { useState, useEffect, useCallback, useRef } from "react"
import { api } from "@/api"

interface FollowUpQuestionsProps {
  chatId: string
  messageId: string
  onQuestionClick: (question: string) => void
  isStreaming?: boolean
  onQuestionsLoaded?: () => void
}

export const FollowUpQuestions: React.FC<FollowUpQuestionsProps> = ({
  chatId,
  messageId,
  onQuestionClick,
  isStreaming = false,
  onQuestionsLoaded,
}) => {
  const [questions, setQuestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastFetchRef = useRef<string | null>(null)

  // Auto-scroll when questions appear
  useEffect(() => {
    if (questions.length > 0 && onQuestionsLoaded) {
      // Small delay to allow animation to start
      const timer = setTimeout(() => {
        onQuestionsLoaded()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [questions.length, onQuestionsLoaded])

  useEffect(() => {
    if (chatId && messageId && !isStreaming) {
      // Clear any existing timeout
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current)
      }

      // Create a unique key for this fetch request
      const fetchKey = `${chatId}-${messageId}`

      // Only fetch if we haven't already fetched for this message
      if (lastFetchRef.current !== fetchKey) {
        // Add a small delay to debounce rapid state changes
        fetchTimeoutRef.current = setTimeout(() => {
          fetchFollowUpQuestions(fetchKey)
        }, 300)
      }
    } else {
      // Clear questions when streaming starts
      setQuestions([])
      setError(null)
      setLoading(false)

      // Clear any pending fetch
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current)
        fetchTimeoutRef.current = null
      }
    }

    // Cleanup function
    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current)
        fetchTimeoutRef.current = null
      }
    }
  }, [chatId, messageId, isStreaming])

  const fetchFollowUpQuestions = useCallback(
    async (fetchKey: string) => {
      if (!chatId || !messageId || isStreaming) return

      // Double-check that this request is still valid
      if (lastFetchRef.current === fetchKey) {
        return // Already fetched for this message
      }

      setLoading(true)
      setError(null)
      lastFetchRef.current = fetchKey

      try {
        const response = await api.chat["followup-questions"].$post({
          json: {
            chatId,
            messageId,
          },
        })

        if (response.ok) {
          const data = await response.json()
          setQuestions(data.followUpQuestions || [])
        } else {
          setError("Failed to generate follow-up questions")
        }
      } catch (err) {
        console.error("Error fetching follow-up questions:", err)
        setError("Failed to generate follow-up questions")
      } finally {
        setLoading(false)
      }
    },
    [chatId, messageId, isStreaming],
  )

  if (isStreaming || (!loading && questions.length === 0 && !error)) {
    return null
  }

  return (
    <div className="mt-3 ml-[52px] opacity-0 animate-fade-in-up">
      <div className="mb-2">
        <span className="font-light select-none leading-[14px] tracking-[0.02em] text-[12px] text-[#9EAEBE] font-mono">
          RELATED
        </span>
      </div>

      {loading && (
        <div className="text-[#9EAEBE] text-[14px]">
          Generating follow-up questions...
        </div>
      )}

      {error && <div className="text-[#EF4444] text-[14px]">{error}</div>}

      {questions.length > 0 && (
        <div className="flex flex-wrap gap-2 justify-start">
          {questions.map((question, index) => (
            <button
              key={index}
              onClick={() => onQuestionClick(question)}
              className="inline-flex items-center px-3 py-2 text-[15px] text-[#1C1D1F] dark:text-[#F1F3F4] bg-[#F5F9FC] dark:bg-[#2A2B2E] hover:bg-[#E5E7EB] dark:hover:bg-[#3A3B3E] rounded-lg transition-all duration-300 ease-out cursor-pointer font-medium text-left opacity-0 translate-y-2 hover:scale-[1.02] hover:shadow-sm animate-slide-in-up"
              style={{
                animationDelay: `${index * 150 + 200}ms`,
              }}
            >
              {question}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
