import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LanguagesIcon, SettingsIcon } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import { Button } from '../components/ui/button'
import { AppThemeControl } from '../components/app-theme-control'
import { StatusNotice } from '../components/status-notice'
import { applyAppTheme } from '../shared/appearance'
import { setAppLanguage, t } from '../shared/i18n'
import { targetLanguageOptions } from '../shared/languages'
import { getActiveProfile, normalizeSettings } from '../shared/settings'
import type {
  TranslationMode,
  TranslationScope,
  TranslationDisplayMode,
  TranslationSettings,
} from '../shared/settings'
import '../shared/style.css'

export function Popup() {
  const [settings, setSettings] = useState<TranslationSettings | null>(null)
  const [status, setStatus] = useState(t('loadingSettings'))

  const activeProfile = useMemo(
    () => (settings ? getActiveProfile(settings) : null),
    [settings],
  )

  useEffect(() => {
    chrome.storage.sync.get(null).then((stored) => {
      const nextSettings = normalizeSettings(stored)
      setAppLanguage(nextSettings.appLanguage)
      applyAppTheme(nextSettings.appTheme)
      setSettings(nextSettings)
      setStatus(t('chooseCurrentProfile'))
    })
  }, [])

  async function handleProfileChange(profileId: string) {
    if (!settings) {
      return
    }

    const nextSettings = { ...settings, activeProfileId: profileId }
    setSettings(nextSettings)
    await chrome.storage.sync.set({ activeProfileId: profileId })
    setStatus(t('profileSwitched'))
  }

  async function handleDisplayModeChange(displayMode: TranslationDisplayMode) {
    if (!settings) {
      return
    }

    const nextSettings = { ...settings, displayMode }
    setSettings(nextSettings)
    await chrome.storage.sync.set({ displayMode })
    setStatus(displayMode === 'translation' ? t('translationOnlyEnabled') : t('bilingualEnabled'))
  }

  async function handleTranslationScopeChange(translationScope: TranslationScope) {
    if (!settings) {
      return
    }

    const nextSettings = { ...settings, translationScope }
    setSettings(nextSettings)
    await chrome.storage.sync.set({ translationScope })
    setStatus(
      translationScope === 'viewport'
        ? t('viewportTranslationEnabled')
        : t('visiblePageTranslationEnabled'),
    )
  }

  async function handleTranslationModeChange(translationMode: TranslationMode) {
    if (!settings) {
      return
    }

    const nextSettings = { ...settings, translationMode }
    setSettings(nextSettings)
    await chrome.storage.sync.set({ translationMode })
    setStatus(t('translationSettingsSaved'))
  }

  async function handleTargetLanguageChange(targetLanguage: string) {
    if (!settings) {
      return
    }

    const nextSettings = { ...settings, targetLanguage }
    setSettings(nextSettings)
    await chrome.storage.sync.set({ targetLanguage })
  }

  async function openOptionsPage() {
    await chrome.runtime.openOptionsPage()
  }

  return (
    <main className="w-82 bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-slate-200 bg-slate-100 text-slate-700">
            <LanguagesIcon className="size-4" aria-hidden="true" />
          </span>
          <h1 className="truncate text-base leading-tight font-semibold text-slate-900">
            {t('popupTitle')}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {settings && (
            <>
              <AppThemeControl
                appTheme={settings.appTheme}
                onThemeApplied={(appTheme) =>
                  setSettings((current) =>
                    current ? { ...current, appTheme } : current,
                  )
                }
                onThemeSaved={() => setStatus(t('appearanceSaved'))}
                onThemeSaveFailed={() => setStatus(t('saveFailed'))}
                buttonClassName="size-8 rounded-md bg-slate-100 hover:bg-slate-200"
                iconClassName="size-4"
              />
            </>
          )}

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 rounded-md border-slate-300 bg-slate-100 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-200"
            onClick={openOptionsPage}
          >
            <SettingsIcon className="size-3.5" aria-hidden="true" />
            {t('openOptions')}
          </Button>
        </div>
      </header>

      {settings && (
        <section className="grid gap-2.5 p-4 pb-0">
          <label className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-slate-600">{t('currentProfile')}</span>
            <Select
              value={settings.activeProfileId}
              onValueChange={(value) => {
                if (!value) {
                  return
                }

                void handleProfileChange(value)
              }}
            >
              <SelectTrigger className="h-9 w-full rounded-md border-slate-300 bg-white px-2.5 text-sm text-slate-900">
                <SelectValue>{activeProfile?.name ?? ''}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {settings.profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <div className="grid min-w-0 gap-1.5 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="block min-w-0 truncate text-[13px] font-semibold text-slate-700">
                {activeProfile?.provider === 'chrome-built-in'
                  ? t('chromeBuiltInProvider')
                  : activeProfile?.model || t('modelUnset')}
              </span>
              <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">
                {settings.activeProfileId === activeProfile?.id ? t('activeProfile') : ''}
              </span>
            </div>
            {activeProfile?.provider === 'chrome-built-in' ? (
              <p className="m-0 text-xs leading-5 text-slate-600">
                {t('chromeBuiltInFirstUseNotice')}
              </p>
            ) : (
              <code
                className="block max-w-full break-all whitespace-normal font-mono text-xs leading-relaxed text-slate-700"
                title={activeProfile?.apiBaseUrl || t('endpointUnset')}
              >
                {activeProfile?.apiBaseUrl || t('endpointUnset')}
              </code>
            )}
          </div>

          <div className="grid grid-cols-2 items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-600">
              {t('targetLanguage')}
            </span>
            <Select
              value={settings.targetLanguage}
              onValueChange={(value) => {
                if (!value) {
                  return
                }

                void handleTargetLanguageChange(value)
              }}
            >
              <SelectTrigger className="h-9 w-full rounded-md border-slate-300 bg-white px-2.5 text-sm text-slate-900">
                <SelectValue>{settings.targetLanguage}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {targetLanguageOptions.map((language) => (
                  <SelectItem key={language.value} value={language.value}>
                    {language.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-600">{t('displayMode')}</span>
            <Select
              value={settings.displayMode}
              onValueChange={(value) => {
                if (!value) {
                  return
                }

                void handleDisplayModeChange(value as TranslationDisplayMode)
              }}
            >
              <SelectTrigger className="h-9 w-full rounded-md border-slate-300 bg-white px-2.5 text-sm text-slate-900">
                <SelectValue>
                  {settings.displayMode === 'bilingual' ? t('bilingual') : t('translationOnly')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bilingual">{t('bilingual')}</SelectItem>
                <SelectItem value="translation">{t('translationOnly')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-600">
              {t('translationScope')}
            </span>
            <Select
              value={settings.translationScope}
              onValueChange={(value) => {
                if (!value) {
                  return
                }

                void handleTranslationScopeChange(value as TranslationScope)
              }}
            >
              <SelectTrigger className="h-9 w-full rounded-md border-slate-300 bg-white px-2.5 text-sm text-slate-900">
                <SelectValue>
                  {settings.translationScope === 'viewport' ? t('viewport') : t('visiblePage')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewport">{t('viewport')}</SelectItem>
                <SelectItem value="visible-page">{t('visiblePage')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-600">
              {t('translationMode')}
            </span>
            <Select
              value={settings.translationMode}
              onValueChange={(value) => {
                if (!value) {
                  return
                }

                void handleTranslationModeChange(value as TranslationMode)
              }}
            >
              <SelectTrigger className="h-9 w-full rounded-md border-slate-300 bg-white px-2.5 text-sm text-slate-900">
                <SelectValue>
                  {settings.translationMode === 'element-context'
                    ? t('wholeParagraphTranslationMode')
                    : t('textNodeTranslationMode')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="element-context">{t('wholeParagraphTranslationMode')}</SelectItem>
                <SelectItem value="text-node">{t('textNodeTranslationMode')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </section>
      )}

      <div className="p-4 pt-3">
        <StatusNotice message={status} />
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
)
