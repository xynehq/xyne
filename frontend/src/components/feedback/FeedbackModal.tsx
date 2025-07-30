import React, { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MessageFeedback } from "shared/types"

// Simple checkbox component
const Checkbox = ({
  id,
  checked,
  onCheckedChange,
  children,
}: {
  id: string
  checked: boolean
  onCheckedChange: () => void
  children?: React.ReactNode
}) => (
  <div className="flex items-start space-x-3">
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={onCheckedChange}
      className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded flex-shrink-0"
    />
    {children && (
      <label
        htmlFor={id}
        className="text-sm leading-relaxed cursor-pointer flex-1"
      >
        {children}
      </label>
    )}
  </div>
)

// Map backend keys to front-end enum values
const FEEDBACK_QUESTIONS = {
  [MessageFeedback.Like]: [
    "Response time was quick",
    "Answer provided was accurate and to the point",
    "Citations were relevant and added value to the response",
  ],
  [MessageFeedback.Dislike]: [
    "No response was received or an error occurred",
    "Response took too long to load",
    "Answer was entirely incorrect",
    "Citations were inaccurate and not relevant to the content",
  ],
} as const

interface FeedbackModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (data: {
    type: MessageFeedback
    customFeedback?: string
    selectedOptions?: string[]
    shareChat?: boolean
  }) => void
  feedbackType: MessageFeedback
  messageId: string
  chatId: string // Add chatId for share functionality
}

export const FeedbackModal: React.FC<FeedbackModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  feedbackType,
  messageId,
  chatId,
}) => {
  const [customFeedback, setCustomFeedback] = useState("")
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [shareChat, setShareChat] = useState(false)

  const questions = FEEDBACK_QUESTIONS[feedbackType]
  const isPositiveFeedback = feedbackType === MessageFeedback.Like

  const handleOptionToggle = (option: string) => {
    setSelectedOptions((prev) =>
      prev.includes(option)
        ? prev.filter((o) => o !== option)
        : [...prev, option],
    )
  }

  const handleSubmit = () => {
    onSubmit({
      type: feedbackType,
      customFeedback: customFeedback.trim() || undefined,
      selectedOptions: selectedOptions.length > 0 ? selectedOptions : undefined,
      shareChat: shareChat,
    })

    // Reset form
    setCustomFeedback("")
    setSelectedOptions([])
    setShareChat(false)
    onClose()
  }

  const handleCancel = () => {
    setCustomFeedback("")
    setSelectedOptions([])
    setShareChat(false)
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleCancel}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {isPositiveFeedback
              ? "Thanks for letting us know!"
              : "We're sorry your experience wasn't the best"}
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {isPositiveFeedback
              ? "Your feedback helps us keep the good stuff coming."
              : "sharing your feedback helps us improve for everyone."}
          </p>
        </DialogHeader>

        <div className="space-y-6">
          {/* Predefined Questions */}
          <div>
            <p className="text-sm font-medium mb-4">
              {isPositiveFeedback
                ? "What did work well? Select all that apply. (optional)"
                : "Which of the following did you experience? Select all that apply. (optional)"}
            </p>
            <div className="space-y-3">
              {questions.map((question: string) => (
                <Checkbox
                  key={question}
                  id={question}
                  checked={selectedOptions.includes(question)}
                  onCheckedChange={() => handleOptionToggle(question)}
                >
                  {question}
                </Checkbox>
              ))}
            </div>
          </div>

          {/* Custom Feedback */}
          <div>
            <p className="text-sm font-medium mb-3">
              Please share any relevant details and suggest how we can improve
              (optional)
            </p>
            <Textarea
              placeholder="Provide some details or suggest improvements"
              value={customFeedback}
              onChange={(e) => setCustomFeedback(e.target.value)}
              className="min-h-[100px]"
            />
          </div>

          {/* Share Chat Option */}
          <div className="border-t pt-4">
            <Checkbox
              id="share-chat"
              checked={shareChat}
              onCheckedChange={() => setShareChat(!shareChat)}
            >
              <div>
                <span className="font-medium">
                  Allow sharing this chat for improvement purposes
                </span>
                <p className="text-xs text-muted-foreground mt-1">
                  This helps our team analyze the conversation to improve the
                  AI's responses. A secure link will be generated that only our
                  development team can access.
                </p>
              </div>
            </Checkbox>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>Send</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
