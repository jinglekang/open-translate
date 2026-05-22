import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import { Button } from '../components/ui/button'
import { StatusNotice } from '../components/status-notice'
import { t } from '../shared/i18n'
import { getActiveProfile, normalizeSettings, profileFieldLimits } from '../shared/settings'
import type {
  PageTranslationScope,
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

  async function handlePageScopeChange(pageTranslationScope: PageTranslationScope) {
    if (!settings) {
      return
    }

    const nextSettings = { ...settings, pageTranslationScope }
    setSettings(nextSettings)
    await chrome.storage.sync.set({ pageTranslationScope })
    setStatus(
      pageTranslationScope === 'viewport'
        ? t('viewportTranslationEnabled')
        : t('visiblePageTranslationEnabled'),
    )
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
    <main className="w-80 bg-slate-50 p-4.5 text-slate-900">
      <header className="mb-4.5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl leading-tight font-semibold text-slate-900">
            {t('extensionName')}
          </h1>
        </div>
        <span
          className="mt-2 h-2.5 w-2.5 rounded-full bg-green-600 shadow-[0_0_0_4px_rgba(22,163,74,0.12)]"
          aria-label={t('extensionEnabled')}
        />
      </header>

      {settings && (
        <section className="grid gap-3">
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

          <div className="grid min-w-0 gap-2 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <strong className="block min-w-0 truncate text-sm font-semibold text-slate-900">
                {activeProfile?.name}
              </strong>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 rounded-md px-2 text-xs font-semibold text-blue-600 hover:bg-blue-50 hover:text-blue-700"
                onClick={openOptionsPage}
              >
                {t('manageProfiles')}
              </Button>
            </div>
            <span className="block truncate text-[13px] text-slate-600">
              {activeProfile?.model || t('modelUnset')}
            </span>
            <code
              className="block max-w-full break-all whitespace-normal font-mono text-xs leading-relaxed text-slate-700"
              title={activeProfile?.apiBaseUrl || t('endpointUnset')}
            >
              {activeProfile?.apiBaseUrl || t('endpointUnset')}
            </code>
          </div>

          <label className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-slate-600">{t('targetLanguage')}</span>
            <input
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
              value={settings.targetLanguage}
              onChange={(event) => void handleTargetLanguageChange(event.target.value)}
              placeholder={t('targetLanguagePlaceholder')}
              maxLength={profileFieldLimits.targetLanguage}
            />
          </label>

          <fieldset className="grid gap-2 border-0 p-0 m-0">
            <legend className="text-[13px] font-semibold text-slate-600">{t('displayMode')}</legend>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-slate-200 bg-white p-1">
              <Button
                type="button"
                size="default"
                variant={settings.displayMode === 'bilingual' ? 'default' : 'ghost'}
                className={
                  settings.displayMode === 'bilingual'
                    ? 'h-8 rounded-md bg-blue-600 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-blue-50'
                }
                onClick={() => handleDisplayModeChange('bilingual')}
              >
                {t('bilingual')}
              </Button>
              <Button
                type="button"
                size="default"
                variant={settings.displayMode === 'translation' ? 'default' : 'ghost'}
                className={
                  settings.displayMode === 'translation'
                    ? 'h-8 rounded-md bg-blue-600 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-blue-50'
                }
                onClick={() => handleDisplayModeChange('translation')}
              >
                {t('translationOnly')}
              </Button>
            </div>
          </fieldset>

          <fieldset className="grid gap-2 border-0 p-0 m-0">
            <legend className="text-[13px] font-semibold text-slate-600">
              {t('pageTranslationScope')}
            </legend>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-slate-200 bg-white p-1">
              <Button
                type="button"
                size="default"
                variant={settings.pageTranslationScope === 'viewport' ? 'default' : 'ghost'}
                className={
                  settings.pageTranslationScope === 'viewport'
                    ? 'h-8 rounded-md bg-blue-600 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-blue-50'
                }
                onClick={() => handlePageScopeChange('viewport')}
              >
                {t('viewport')}
              </Button>
              <Button
                type="button"
                size="default"
                variant={settings.pageTranslationScope === 'visible-page' ? 'default' : 'ghost'}
                className={
                  settings.pageTranslationScope === 'visible-page'
                    ? 'h-8 rounded-md bg-blue-600 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-blue-50'
                }
                onClick={() => handlePageScopeChange('visible-page')}
              >
                {t('visiblePage')}
              </Button>
            </div>
          </fieldset>
        </section>
      )}

      <StatusNotice className="mt-3" message={status} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
)
