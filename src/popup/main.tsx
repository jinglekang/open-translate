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
import { t } from '../shared/i18n'
import { getActiveProfile, normalizeSettings } from '../shared/settings'
import type { TranslationDisplayMode, TranslationSettings } from '../shared/settings'
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

  async function openOptionsPage() {
    await chrome.runtime.openOptionsPage()
  }

  return (
    <main className="w-80 bg-slate-50 p-[18px] text-slate-900">
      <header className="mb-[18px] flex items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-blue-600">
            Open Translate
          </p>
          <h1 className="text-xl leading-tight font-semibold text-slate-900">{t('popupTitle')}</h1>
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

          <div className="grid min-w-0 gap-1.5 rounded-lg border border-slate-200 bg-white p-3">
            <strong className="block truncate text-sm font-semibold text-slate-900">
              {activeProfile?.name}
            </strong>
            <span className="block truncate text-[13px] text-slate-600">
              {activeProfile?.model || t('modelUnset')}
            </span>
            <code
              className="block max-w-full break-all whitespace-normal font-mono text-xs leading-relaxed text-slate-700"
              title={getEndpointPreview(activeProfile?.apiBaseUrl || '')}
            >
              {getEndpointPreview(activeProfile?.apiBaseUrl || '')}
            </code>
          </div>

          <fieldset className="grid gap-2 border-0 p-0 m-0">
            <legend className="text-[13px] font-semibold text-slate-600">{t('displayMode')}</legend>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-slate-200 bg-white p-1">
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
            </div>
          </fieldset>

          <Button
            type="button"
            size="lg"
            className="h-9 rounded-md bg-blue-600 px-3 text-sm font-semibold text-white transition hover:bg-blue-700"
            onClick={openOptionsPage}
          >
            {t('manageProfiles')}
          </Button>
        </section>
      )}

      <p className="mt-3 min-h-5 text-[13px] text-slate-500">{status}</p>
    </main>
  )
}

function getEndpointPreview(apiBaseUrl: string) {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, '')
  if (!normalized) {
    return t('endpointUnset')
  }

  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
)
