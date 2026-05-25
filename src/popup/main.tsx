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
import { StatusNotice } from '../components/status-notice'
import { t } from '../shared/i18n'
import { getActiveProfile, normalizeSettings, profileFieldLimits } from '../shared/settings'
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
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1.5 rounded-md border-slate-300 bg-slate-100 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-200"
          onClick={openOptionsPage}
        >
          <SettingsIcon className="size-3.5" aria-hidden="true" />
          {t('openOptions')}
        </Button>
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
            {activeProfile?.provider !== 'chrome-built-in' && (
              <code
                className="block max-w-full break-all whitespace-normal font-mono text-xs leading-relaxed text-slate-700"
                title={activeProfile?.apiBaseUrl || t('endpointUnset')}
              >
                {activeProfile?.apiBaseUrl || t('endpointUnset')}
              </code>
            )}
          </div>

          <label className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-600">
              {t('targetLanguage')}
            </span>
            <input
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
              value={settings.targetLanguage}
              onChange={(event) => void handleTargetLanguageChange(event.target.value)}
              placeholder={t('targetLanguagePlaceholder')}
              maxLength={profileFieldLimits.targetLanguage}
            />
          </label>

          <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-600">{t('displayMode')}</span>
            <div className="grid min-w-0 grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-white p-1">
              <Button
                type="button"
                size="default"
                variant={settings.displayMode === 'bilingual' ? 'default' : 'ghost'}
                className={
                  settings.displayMode === 'bilingual'
                    ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
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
                    ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
                }
                onClick={() => handleDisplayModeChange('translation')}
              >
                {t('translationOnly')}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-600">
              {t('translationScope')}
            </span>
            <div className="grid min-w-0 grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-white p-1">
              <Button
                type="button"
                size="default"
                variant={settings.translationScope === 'viewport' ? 'default' : 'ghost'}
                className={
                  settings.translationScope === 'viewport'
                    ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
                }
                onClick={() => handleTranslationScopeChange('viewport')}
              >
                {t('viewport')}
              </Button>
              <Button
                type="button"
                size="default"
                variant={settings.translationScope === 'visible-page' ? 'default' : 'ghost'}
                className={
                  settings.translationScope === 'visible-page'
                    ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
                }
                onClick={() => handleTranslationScopeChange('visible-page')}
              >
                {t('visiblePage')}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-600">
              {t('translationMode')}
            </span>
            <div className="grid min-w-0 grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-white p-1">
              <Button
                type="button"
                size="default"
                variant={settings.translationMode === 'element-context' ? 'default' : 'ghost'}
                className={
                  settings.translationMode === 'element-context'
                    ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
                }
                onClick={() => handleTranslationModeChange('element-context')}
              >
                {t('wholeParagraphTranslationMode')}
              </Button>
              <Button
                type="button"
                size="default"
                variant={settings.translationMode === 'text-node' ? 'default' : 'ghost'}
                className={
                  settings.translationMode === 'text-node'
                    ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                    : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
                }
                onClick={() => handleTranslationModeChange('text-node')}
              >
                {t('textNodeTranslationMode')}
              </Button>
            </div>
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
