import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Mail, Calendar, FileText, X, Shield, CheckCircle, ExternalLink } from 'lucide-react'

export type GoogleService = 'gmail_read' | 'gmail_send' | 'calendar' | 'drive_read' | 'drive_file' | 'tasks'

interface PermissionScope {
  id: GoogleService
  label: string
  description: string
  icon: React.ReactNode
}

const PERMISSION_SCOPES: PermissionScope[] = [
  {
    id: 'gmail_read',
    label: 'Read Gmail',
    description: 'Access to read your emails and search through your inbox',
    icon: <Mail className="w-5 h-5" />,
  },
  {
    id: 'gmail_send',
    label: 'Send Email',
    description: 'Send emails on your behalf (always asks for confirmation)',
    icon: <Mail className="w-5 h-5" />,
  },
  {
    id: 'calendar',
    label: 'Calendar Access',
    description: 'Read events and create new calendar entries',
    icon: <Calendar className="w-5 h-5" />,
  },
  {
    id: 'drive_read',
    label: 'Read Drive Files',
    description: 'Access files and notes stored in Google Drive',
    icon: <FileText className="w-5 h-5" />,
  },
  {
    id: 'drive_file',
    label: 'Create Drive Files',
    description: 'Create and edit documents in your Drive',
    icon: <FileText className="w-5 h-5" />,
  },
]

interface PermissionRequestDialogProps {
  isOpen: boolean
  onClose: () => void
  service: 'gmail' | 'calendar' | 'drive' | 'google'
  authUrl?: string
  onConnect: () => void
}

export function PermissionRequestDialog({
  isOpen,
  onClose,
  service,
  authUrl,
  onConnect,
}: PermissionRequestDialogProps) {
  const getRelevantScopes = (): PermissionScope[] => {
    switch (service) {
      case 'gmail':
        return PERMISSION_SCOPES.filter((s) => s.id.startsWith('gmail'))
      case 'calendar':
        return PERMISSION_SCOPES.filter((s) => s.id === 'calendar')
      case 'drive':
        return PERMISSION_SCOPES.filter((s) => s.id.startsWith('drive'))
      case 'google':
      default:
        return PERMISSION_SCOPES
    }
  }

  const scopes = getRelevantScopes()
  const title = service === 'google' ? 'Connect Google Account' : `Connect ${service.charAt(0).toUpperCase() + service.slice(1)}`

  const handleConnect = () => {
    if (authUrl) {
      // Open OAuth in popup
      const width = 500
      const height = 600
      const left = window.screenX + (window.outerWidth - width) / 2
      const top = window.screenY + (window.outerHeight - height) / 2
      const popup = window.open(
        authUrl,
        'google-oauth',
        `width=${width},height=${height},left=${left},top=${top},popup=yes,toolbar=no,menubar=no`
      )

      if (popup) {
        // Poll for popup closure
        const checkClosed = setInterval(() => {
          if (popup.closed) {
            clearInterval(checkClosed)
            onConnect()
          }
        }, 500)
      }
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] w-full max-w-md"
          >
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0a0b18]/95 backdrop-blur-xl shadow-2xl">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20">
                    <Shield className="h-5 w-5 text-emerald-400" />
                  </div>
                  <div>
                    <h3 className="font-mono-display text-sm font-semibold text-white tracking-wide">
                      {title}
                    </h3>
                    <p className="text-[11px] text-white/50 font-mono">
                      Permission Required
                    </p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Content */}
              <div className="p-5 space-y-4">
                <p className="text-[13px] text-white/70 leading-relaxed">
                  To help you with this task, ENZO needs permission to access your Google account. 
                  The agent will be able to:
                </p>

                <div className="space-y-2">
                  {scopes.map((scope) => (
                    <div
                      key={scope.id}
                      className="flex items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                        {scope.icon}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold text-white/90">
                            {scope.label}
                          </span>
                        </div>
                        <p className="text-[11px] text-white/50 leading-relaxed mt-0.5">
                          {scope.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Security note */}
                <div className="flex items-start gap-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10 p-3">
                  <CheckCircle className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-white/60 leading-relaxed">
                    Your credentials are stored securely on your local machine only. 
                    ENZO never stores your data on external servers.
                  </p>
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-3 border-t border-white/10 px-5 py-4">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-[12px] font-medium text-white/60 hover:text-white transition-colors"
                >
                  Not Now
                </button>
                <button
                  onClick={handleConnect}
                  className="group flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-[12px] font-semibold text-black hover:bg-emerald-400 transition-all"
                >
                  <span>Connect</span>
                  <ExternalLink className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

// Inline permission prompt for embedding in chat
interface InlinePermissionPromptProps {
  service: 'gmail' | 'calendar' | 'drive'
  authUrl: string
  onConnect: () => void
  onDismiss: () => void
}

export function InlinePermissionPrompt({
  service,
  authUrl,
  onConnect,
  onDismiss,
}: InlinePermissionPromptProps) {
  const serviceConfig: Record<'gmail' | 'calendar' | 'drive', { icon: React.ReactNode; title: string; description: string }> = {
    gmail: {
      icon: <Mail className="w-5 h-5" />,
      title: 'Gmail Access Required',
      description: 'To read or send emails, ENZO needs permission to access your Gmail.',
    },
    calendar: {
      icon: <Calendar className="w-5 h-5" />,
      title: 'Calendar Access Required',
      description: 'To check your schedule or create events, ENZO needs calendar access.',
    },
    drive: {
      icon: <FileText className="w-5 h-5" />,
      title: 'Drive Access Required',
      description: 'To access your notes and files, ENZO needs Google Drive permission.',
    },
  }

  const config = serviceConfig[service]

  const handleConnect = () => {
    const width = 500
    const height = 600
    const left = window.screenX + (window.outerWidth - width) / 2
    const top = window.screenY + (window.outerHeight - height) / 2
    const popup = window.open(
      authUrl,
      'google-oauth',
      `width=${width},height=${height},left=${left},top=${top},popup=yes`
    )

    if (popup) {
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed)
          onConnect()
        }
      }, 500)
    }
  }

  return (
    <div className="my-3 rounded-xl border border-amber-500/20 bg-gradient-to-r from-amber-500/10 to-orange-500/5 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
          {config.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-mono-display text-[13px] font-semibold text-amber-300">
            {config.title}
          </h4>
          <p className="text-[12px] text-white/70 mt-1 leading-relaxed">
            {config.description}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={handleConnect}
              className="px-3 py-1.5 rounded-lg bg-amber-500 text-black text-[11px] font-semibold hover:bg-amber-400 transition-colors"
            >
              Grant Access
            </button>
            <button
              onClick={onDismiss}
              className="px-3 py-1.5 text-[11px] text-white/50 hover:text-white transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Confirmation dialog for write actions (send email, create event)
interface ConfirmationDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: string
  actionLabel: string
  details?: Record<string, string>
}

export function ConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  actionLabel,
  details,
}: ConfirmationDialogProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] w-full max-w-md"
          >
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0a0b18]/95 backdrop-blur-xl shadow-2xl p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
                  <Shield className="h-5 w-5" />
                </div>
                <h3 className="font-mono-display text-sm font-semibold text-white">
                  {title}
                </h3>
              </div>

              <p className="text-[13px] text-white/70 mb-4">
                {description}
              </p>

              {details && (
                <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 mb-4 space-y-2">
                  {Object.entries(details).map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                      <span className="text-[11px] text-white/40 shrink-0 w-20">{key}:</span>
                      <span className="text-[11px] text-white/80 truncate">{value}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-[12px] font-medium text-white/60 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={onConfirm}
                  className="px-4 py-2 rounded-xl bg-amber-500 text-black text-[12px] font-semibold hover:bg-amber-400 transition-colors"
                >
                  {actionLabel}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
