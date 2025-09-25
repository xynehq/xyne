import React from 'react'

export interface ConfirmationPopupProps {
  isVisible: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
  onConfirm: () => void
  onCancel: () => void
}

export const ConfirmationPopup: React.FC<ConfirmationPopupProps> = ({
  isVisible,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel
}) => {
  if (!isVisible) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl max-w-md w-full mx-4 p-8">
        {/* Title */}
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-3">
          {title}
        </h2>
        
        {/* Message */}
        <p className="text-gray-600 dark:text-gray-400 text-base leading-relaxed mb-8">
          {message}
        </p>
        
        {/* Action Buttons */}
        <div className="flex gap-3">
          {/* Refresh Button */}
          <button
            onClick={onConfirm}
            className="flex-1 px-6 py-3 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-full font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            {confirmText}
          </button>
          
          {/* Cancel Button */}
          <button
            onClick={onCancel}
            className="flex-1 px-6 py-3 text-white bg-black dark:bg-gray-700 rounded-full font-medium hover:bg-gray-800 dark:hover:bg-gray-600 transition-colors"
          >
            {cancelText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmationPopup