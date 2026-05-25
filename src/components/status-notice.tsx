import { InfoIcon } from 'lucide-react'

import { cn } from '../library/utils'

type StatusNoticeProps = {
  className?: string
  message: string
}

export function StatusNotice({ className, message }: StatusNoticeProps) {
  return (
    <div
      className={cn(
        'relative flex min-h-10 items-start gap-2 overflow-hidden rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06)]',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <span className="absolute inset-y-1.5 left-0 w-0.75 rounded-r-full bg-slate-500" />
      <span className="mt-0.25 grid size-5 shrink-0 place-items-center rounded-full bg-white text-slate-500 shadow-[0_0_0_1px_rgba(71,85,105,0.14)]">
        <InfoIcon className="size-3.5" aria-hidden="true" />
      </span>
      <p className="min-w-0 text-[13px] leading-5 font-medium">{message}</p>
    </div>
  )
}
