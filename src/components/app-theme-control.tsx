import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { cn } from '../library/utils'
import { t } from '../shared/i18n'
import { applyAppTheme } from '../shared/appearance'
import type { AppTheme } from '../shared/settings'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

const appThemeOptions = ['system', 'light', 'dark'] as const

type AppThemeControlProps = {
  appTheme: AppTheme
  onThemeApplied?: (theme: AppTheme) => void
  onThemeSaved?: () => void
  onThemeSaveFailed?: () => void
  buttonClassName?: string
  iconClassName?: string
}

export function AppThemeControl({
  appTheme,
  onThemeApplied,
  onThemeSaved,
  onThemeSaveFailed,
  buttonClassName,
  iconClassName,
}: AppThemeControlProps) {
  async function applyTheme(nextTheme: AppTheme) {
    applyAppTheme(nextTheme)
    onThemeApplied?.(nextTheme)

    try {
      await chrome.storage.sync.set({ appTheme: nextTheme })
      onThemeSaved?.()
    } catch {
      onThemeSaveFailed?.()
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn('border-slate-300 bg-white text-slate-700 hover:bg-slate-50', buttonClassName)}
            aria-label={`${t('appTheme')}: ${getAppThemeLabel(appTheme)}`}
            title={getAppThemeLabel(appTheme)}
          />
        }
      >
        {getAppThemeIcon(appTheme, iconClassName)}
        <span className="sr-only">{t('appTheme')}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {appThemeOptions.map((theme) => (
          <DropdownMenuCheckboxItem
            key={theme}
            checked={appTheme === theme}
            onCheckedChange={(checked) => {
              if (checked) {
                void applyTheme(theme)
              }
            }}
          >
            {getAppThemeLabel(theme)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function getAppThemeLabel(theme: AppTheme) {
  if (theme === 'light') {
    return t('themeLight')
  }

  if (theme === 'dark') {
    return t('themeDark')
  }

  return t('themeSystem')
}

function getAppThemeIcon(theme: AppTheme, iconClassName?: string) {
  if (theme === 'light') {
    return <SunIcon className={cn('size-4.5', iconClassName)} aria-hidden="true" />
  }

  if (theme === 'dark') {
    return <MoonIcon className={cn('size-4.5', iconClassName)} aria-hidden="true" />
  }

  return <MonitorIcon className={cn('size-4.5', iconClassName)} aria-hidden="true" />
}