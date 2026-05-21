import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { t } from '../shared/i18n'
import { getActiveProfile, normalizeSettings } from '../shared/settings'
import type { TranslationDisplayMode, TranslationSettings } from '../shared/settings'
import './style.css'

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
    <main className="popup-shell">
      <header className="popup-header">
        <div>
          <p className="eyebrow">Open Translate</p>
          <h1>{t('popupTitle')}</h1>
        </div>
        <span className="status-dot" aria-label={t('extensionEnabled')} />
      </header>

      {settings && (
        <section className="switcher">
          <label>
            <span>{t('currentProfile')}</span>
            <select
              value={settings.activeProfileId}
              onChange={(event) => handleProfileChange(event.target.value)}
            >
              {settings.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>

          <div className="profile-card">
            <strong>{activeProfile?.name}</strong>
            <span>{activeProfile?.model || t('modelUnset')}</span>
            <code title={getEndpointPreview(activeProfile?.apiBaseUrl || '')}>
              {getEndpointPreview(activeProfile?.apiBaseUrl || '')}
            </code>
          </div>

          <fieldset className="display-mode">
            <legend>{t('displayMode')}</legend>
            <div>
              <button
                type="button"
                className={settings.displayMode === 'translation' ? 'active' : ''}
                onClick={() => handleDisplayModeChange('translation')}
              >
                {t('translationOnly')}
              </button>
              <button
                type="button"
                className={settings.displayMode === 'bilingual' ? 'active' : ''}
                onClick={() => handleDisplayModeChange('bilingual')}
              >
                {t('bilingual')}
              </button>
            </div>
          </fieldset>

          <button type="button" className="manage-button" onClick={openOptionsPage}>
            {t('manageProfiles')}
          </button>
        </section>
      )}

      <p className="status-message">{status}</p>
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
