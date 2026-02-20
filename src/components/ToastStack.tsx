import { useEffect } from 'react'
import { Check, X } from 'lucide-react'
import { useToast } from '../contexts/ToastContext'

export default function ToastStack() {
  const { toasts, removeToast } = useToast()

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed top-16 right-4 z-50 flex flex-col gap-2 max-w-sm"
      style={{ animation: 'slideDown 0.2s ease-out' }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

function ToastItem({
  toast,
  onClose,
}: {
  toast: { id: string; message: string; type: 'success' | 'error' | 'info'; duration?: number }
  onClose: () => void
}) {
  const duration = toast.duration ?? 5000

  useEffect(() => {
    const timer = setTimeout(onClose, duration)
    return () => clearTimeout(timer)
  }, [duration, onClose])

  const bgColor =
    toast.type === 'success'
      ? 'bg-green-900/90 border-green-500/50'
      : toast.type === 'error'
        ? 'bg-red-900/90 border-red-500/50'
        : 'bg-blue-900/90 border-blue-500/50'

  const textColor =
    toast.type === 'success'
      ? 'text-green-400'
      : toast.type === 'error'
        ? 'text-red-400'
        : 'text-blue-400'

  const icon =
    toast.type === 'success' ? (
      <Check size={18} className={textColor} />
    ) : toast.type === 'error' ? (
      <X size={18} className={textColor} />
    ) : null

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg ${bgColor} transition-all duration-300 ease-in-out`}
    >
      {icon}
      <span className={`text-sm font-medium flex-1 ${textColor}`}>{toast.message}</span>
      <button
        onClick={onClose}
        className={`p-1 rounded hover:bg-black/20 transition-colors ${textColor} opacity-70 hover:opacity-100`}
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </div>
  )
}
