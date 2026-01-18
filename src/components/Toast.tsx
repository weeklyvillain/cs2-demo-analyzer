import { useEffect } from 'react'
import { Check, X } from 'lucide-react'

interface ToastProps {
  message: string
  type?: 'success' | 'error' | 'info'
  isVisible: boolean
  onClose: () => void
  duration?: number
}

export default function Toast({
  message,
  type = 'success',
  isVisible,
  onClose,
  duration = 3000,
}: ToastProps) {
  useEffect(() => {
    if (isVisible) {
      const timer = setTimeout(() => {
        onClose()
      }, duration)
      return () => clearTimeout(timer)
    }
  }, [isVisible, duration, onClose])

  if (!isVisible) return null

  const bgColor =
    type === 'success'
      ? 'bg-green-900/90 border-green-500/50'
      : type === 'error'
      ? 'bg-red-900/90 border-red-500/50'
      : 'bg-blue-900/90 border-blue-500/50'

  const textColor =
    type === 'success'
      ? 'text-green-400'
      : type === 'error'
      ? 'text-red-400'
      : 'text-blue-400'

  const icon =
    type === 'success' ? (
      <Check size={18} className={textColor} />
    ) : type === 'error' ? (
      <X size={18} className={textColor} />
    ) : null

  return (
    <div
      className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg ${bgColor} transition-all duration-300 ease-in-out`}
      style={{
        animation: 'slideDown 0.3s ease-out',
      }}
    >
      {icon}
      <span className={`text-sm font-medium ${textColor}`}>{message}</span>
      <button
        onClick={onClose}
        className={`ml-2 p-1 rounded hover:bg-black/20 transition-colors ${textColor} opacity-70 hover:opacity-100`}
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </div>
  )
}
