import React, { useState, useEffect } from "react"
import { api } from "@/api"

interface FollowUpQuestionsProps {
  chatId: string
  messageId: string
  onQuestionClick: (question: string) => void
  isVisible: boolean
  isStreaming?: boolean
  onQuestionsLoaded?: () => void
}

export const FollowUpQuestions: React.FC<FollowUpQuestionsProps> = ({
  chatId,
  messageId,
  onQuestionClick,
  isVisible,
  isStreaming = false,
  onQuestionsLoaded,
}) => {
  const [questions, setQuestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    // Only fetch if visible, not streaming, and all required data is available
    if (isVisible && chatId && messageId && !isStreaming) {
      fetchFollowUpQuestions()
    }
    // Clear questions when streaming starts or component becomes invisible
    if (isStreaming || !isVisible) {
      setQuestions([])
      setError(null)
      setLoading(false)
    }
  }, [isVisible, chatId, messageId, isStreaming])

  const fetchFollowUpQuestions = async () => {
    if (!chatId || !messageId || isStreaming) return

    setLoading(true)
    setError(null)

    try {
      const response = await api.chat["followup-questions"].$post({
        json: { chatId, messageId },
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
  }

  if (
    !isVisible ||
    isStreaming ||
    (!loading && questions.length === 0 && !error)
  ) {
    return null
  }

  return (
    <>
      <style>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        @keyframes slideInUp {
          from {
            opacity: 0;
            transform: translateY(15px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
      <div className="mt-3 ml-[52px] opacity-0 animate-[fadeInUp_0.6s_ease-out_forwards]">
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
                className="inline-flex items-center px-3 py-2 text-[15px] text-[#1C1D1F] dark:text-[#F1F3F4] bg-[#F5F9FC] dark:bg-[#2A2B2E] hover:bg-[#E5E7EB] dark:hover:bg-[#3A3B3E] rounded-lg transition-all duration-300 ease-out cursor-pointer font-medium text-left opacity-0 translate-y-2 hover:scale-[1.02] hover:shadow-sm"
                style={{
                  animation: `slideInUp 0.5s ease-out ${index * 150 + 200}ms forwards`,
                }}
              >
                {question}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
