import { LanguagesIcon } from 'lucide-react'
import { cn } from '../library/utils'
import { setAppLanguage, t } from '../shared/i18n'
import type { AppLanguage } from '../shared/settings'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

const appLanguageOptions = ['system', 'zh_CN', 'en'] as const

type AppLanguageControlProps = {
  appLanguage: AppLanguage
  onLanguageApplied?: (language: AppLanguage) => void
  onLanguageSaved?: () => void
  onLanguageSaveFailed?: () => void
  buttonClassName?: string
  iconClassName?: string
  textIconClassName?: string
}

export function AppLanguageControl({
  appLanguage,
  onLanguageApplied,
  onLanguageSaved,
  onLanguageSaveFailed,
  buttonClassName,
  iconClassName,
  textIconClassName,
}: AppLanguageControlProps) {
  async function applyLanguage(nextLanguage: AppLanguage) {
    setAppLanguage(nextLanguage)
    onLanguageApplied?.(nextLanguage)

    try {
      await chrome.storage.sync.set({ appLanguage: nextLanguage })
      onLanguageSaved?.()
    } catch {
      onLanguageSaveFailed?.()
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
            aria-label={`${t('appLanguage')}: ${getAppLanguageLabel(appLanguage)}`}
            title={getAppLanguageLabel(appLanguage)}
          />
        }
      >
        {getAppLanguageIcon(appLanguage, iconClassName, textIconClassName)}
        <span className="sr-only">{t('appLanguage')}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {appLanguageOptions.map((language) => (
          <DropdownMenuCheckboxItem
            key={language}
            checked={appLanguage === language}
            onCheckedChange={(checked) => {
              if (checked) {
                void applyLanguage(language)
              }
            }}
          >
            {getAppLanguageLabel(language)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function getAppLanguageLabel(language: AppLanguage) {
  if (language === 'zh_CN') {
    return t('languageZhCn')
  }

  if (language === 'en') {
    return t('languageEn')
  }

  return t('languageSystem')
}

function getAppLanguageIcon(
  language: AppLanguage,
  iconClassName?: string,
  textIconClassName?: string,
) {
  if (language === 'system') {
    return <LanguagesIcon className={cn('size-4.5', iconClassName)} aria-hidden="true" />
  }

  return (
    <span className={cn('text-sm leading-none font-semibold', textIconClassName)} aria-hidden="true">
      {language === 'zh_CN' ? '中' : 'EN'}
    </span>
  )
}