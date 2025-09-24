import React, { useEffect, useState } from 'react'
import { X, AlertCircle, CheckCircle, Info } from 'lucide-react'

export interface SnackbarProps {
  message: string
  type?: 'success' | 'error' | 'warning' | 'info'
  isVisible: boolean
  onClose: () => void
  duration?: number
  position?: 'top-center' | 'top-right' | 'bottom-center' | 'bottom-right'
}

export const Snackbar: React.FC<SnackbarProps> = ({
  message,
  type = 'info',
  isVisible,
  onClose,
  duration = 5000,
  position = 'top-center'
}) => {
  const [isShowing, setIsShowing] = useState(false)

  useEffect(() => {
    if (isVisible) {
      setIsShowing(true)
      const timer = setTimeout(() => {
        setIsShowing(false)
        setTimeout(onClose, 300) // Wait for exit animation
      }, duration)

      return () => clearTimeout(timer)
    } else {
      setIsShowing(false)
    }
  }, [isVisible, duration, onClose])

  if (!isVisible && !isShowing) return null

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle className="w-5 h-5 text-green-600" />
      case 'error':
        return <AlertCircle className="w-5 h-5 text-red-600" />
      case 'warning':
        return <AlertCircle className="w-5 h-5 text-yellow-600" />
      default:
        return <Info className="w-5 h-5 text-blue-600" />
    }
  }

  const getBackgroundColor = () => {
    switch (type) {
      case 'success':
        return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
      case 'error':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
      case 'warning':
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800'
      default:
        return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
    }
  }

  const getTextColor = () => {
    switch (type) {
      case 'success':
        return 'text-green-800 dark:text-green-200'
      case 'error':
        return 'text-red-800 dark:text-red-200'
      case 'warning':
        return 'text-yellow-800 dark:text-yellow-200'
      default:
        return 'text-blue-800 dark:text-blue-200'
    }
  }
//TODO: will refactor later
  const getPositionClasses = () => {
    switch (position) {
      case 'top-right':
        return 'top-4 right-4'
      case 'bottom-center':
        return 'bottom-4 left-1/2 transform -translate-x-1/2'
      case 'bottom-right':
        return 'bottom-4 right-4'
      default:
        return 'top-4 left-1/2 transform -translate-x-1/2'
    }
  }

  return (
    <div
      className={`fixed z-[9999] ${getPositionClasses()} transition-all duration-300 ease-in-out ${
        isShowing ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
      }`}
    >
      <div
        className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg max-w-md ${getBackgroundColor()}`}
      >
        {getIcon()}
        <div className={`flex-1 text-sm font-medium ${getTextColor()}`}>
          {message}
        </div>
        <button
          onClick={() => {
            setIsShowing(false)
            setTimeout(onClose, 300)
          }}
          className={`flex-shrink-0 p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors ${getTextColor()}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

export default Snackbar