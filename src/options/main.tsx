import { StrictMode, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { t } from '../shared/i18n'
import {
  createProfile,
  defaultSettings,
  getActiveProfile,
  normalizeSettings,
  profileFieldLimits,
  sanitizeSettings,
} from '../shared/settings'
import type { TranslationProfile, TranslationSettings } from '../shared/settings'
import './style.css'

export function Options() {
  const [settings, setSettings] = useState<TranslationSettings>(defaultSettings)
  const [editingId, setEditingId] = useState(defaultSettings.activeProfileId)
  const [status, setStatus] = useState(t('loadingSettings'))

  const editingProfile = useMemo(
    () =>
      settings.profiles.find((profile) => profile.id === editingId) ||
      getActiveProfile(settings),
    [editingId, settings],
  )

  useEffect(() => {
    chrome.storage.sync.get(null).then((stored) => {
      const nextSettings = normalizeSettings(stored)
      setSettings(nextSettings)
      setEditingId(nextSettings.activeProfileId)
      setStatus(t('settingsSynced'))
    })
  }, [])

  async function saveSettings(
    nextSettings: TranslationSettings,
    message: string,
    nextEditingId = editingId,
  ) {
    let sanitizedSettings: TranslationSettings
    try {
      sanitizedSettings = sanitizeSettings(nextSettings)
      await chrome.storage.sync.set(sanitizedSettings)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settingsInvalid')
      setStatus(message)
      return
    }

    const stored = normalizeSettings(await chrome.storage.sync.get(null))

    if (
      stored.profiles.length !== sanitizedSettings.profiles.length ||
      stored.activeProfileId !== sanitizedSettings.activeProfileId
    ) {
      console.error('Open Translate settings save verification failed', {
        expected: sanitizedSettings,
        stored,
      })
      setStatus(t('saveFailed'))
      return
    }

    setSettings(stored)
    setEditingId(
      stored.profiles.some((profile) => profile.id === nextEditingId)
        ? nextEditingId
        : stored.activeProfileId,
    )
    setStatus(message)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await saveSettings(settings, t('profileSaved'))
  }

  async function addProfile() {
    const profile = createProfile()
    await saveSettings(
      {
        profiles: [...settings.profiles, profile],
        activeProfileId: profile.id,
        displayMode: settings.displayMode,
      },
      t('profileAdded'),
      profile.id,
    )
  }

  async function duplicateProfile() {
    const profile = {
      ...editingProfile,
      id: createProfile().id,
      name: t('copySuffix', editingProfile.name),
    }
    await saveSettings(
      {
        profiles: [...settings.profiles, profile],
        activeProfileId: profile.id,
        displayMode: settings.displayMode,
      },
      t('profileDuplicated'),
      profile.id,
    )
  }

  async function removeProfile() {
    if (settings.profiles.length <= 1) {
      setStatus(t('keepOneProfile'))
      return
    }

    const profiles = settings.profiles.filter((profile) => profile.id !== editingProfile.id)
    const activeProfileId =
      settings.activeProfileId === editingProfile.id
        ? profiles[0].id
        : settings.activeProfileId

    await saveSettings(
      { profiles, activeProfileId, displayMode: settings.displayMode },
      t('profileDeleted'),
      activeProfileId,
    )
  }

  async function activateProfile(profileId: string) {
    await saveSettings({ ...settings, activeProfileId: profileId }, t('activeProfileSet'), profileId)
  }

  function updateProfile<Key extends keyof TranslationProfile>(
    key: Key,
    value: TranslationProfile[Key],
  ) {
    setSettings((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === editingProfile.id ? { ...profile, [key]: value } : profile,
      ),
    }))
  }

  return (
    <main className="options-shell">
      <header className="options-header">
        <div>
          <p className="eyebrow">Open Translate</p>
          <h1>{t('optionsTitle')}</h1>
        </div>
        <button type="button" onClick={addProfile}>
          {t('addProfile')}
        </button>
      </header>

      <div className="layout">
        <aside className="profile-list" aria-label={t('profileListLabel')}>
          {settings.profiles.map((profile) => (
            <button
              type="button"
              key={profile.id}
              className={profile.id === editingProfile.id ? 'active' : ''}
              onClick={() => setEditingId(profile.id)}
              title={`${profile.name} · ${profile.model || t('modelUnset')}`}
            >
              <strong>{profile.name}</strong>
              <span>{t('modelPrefix', profile.model || t('modelUnset'))}</span>
            </button>
          ))}
        </aside>

        <form className="settings-form" onSubmit={handleSubmit}>
          <div className="form-toolbar">
            <button
              type="button"
              className="secondary"
              onClick={() => activateProfile(editingProfile.id)}
              disabled={settings.activeProfileId === editingProfile.id}
            >
              {t('setActive')}
            </button>
            <button type="button" className="secondary" onClick={duplicateProfile}>
              {t('duplicate')}
            </button>
            <button type="button" className="danger" onClick={removeProfile}>
              {t('delete')}
            </button>
          </div>

          <label>
            <span>{t('profileName')}</span>
            <input
              value={editingProfile.name}
              onChange={(event) => updateProfile('name', event.target.value)}
              placeholder={t('profileNamePlaceholder')}
              maxLength={profileFieldLimits.name}
            />
          </label>

          <label>
            <span>{t('apiBaseUrl')}</span>
            <input
              value={editingProfile.apiBaseUrl}
              onChange={(event) => updateProfile('apiBaseUrl', event.target.value)}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              maxLength={profileFieldLimits.apiBaseUrl}
            />
          </label>

          <label>
            <span>{t('modelName')}</span>
            <input
              value={editingProfile.model}
              onChange={(event) => updateProfile('model', event.target.value)}
              placeholder="gpt-4o-mini"
              spellCheck={false}
              maxLength={profileFieldLimits.model}
            />
          </label>

          <label>
            <span>{t('apiKey')}</span>
            <input
              value={editingProfile.apiKey}
              onChange={(event) => updateProfile('apiKey', event.target.value)}
              placeholder="sk-..."
              type="password"
              spellCheck={false}
              maxLength={profileFieldLimits.apiKey}
            />
          </label>

          <label>
            <span>{t('targetLanguage')}</span>
            <input
              value={editingProfile.targetLanguage}
              onChange={(event) => updateProfile('targetLanguage', event.target.value)}
              placeholder={t('targetLanguagePlaceholder')}
              maxLength={profileFieldLimits.targetLanguage}
            />
          </label>

          <label>
            <span>{t('customPrompt')}</span>
            <textarea
              value={editingProfile.customPrompt}
              onChange={(event) => updateProfile('customPrompt', event.target.value)}
              placeholder={t('customPromptPlaceholder')}
              rows={5}
              maxLength={profileFieldLimits.customPrompt}
            />
          </label>

          <div className="endpoint-preview">
            <span>{t('endpointPreview')}</span>
            <code>{getEndpointPreview(editingProfile.apiBaseUrl)}</code>
          </div>

          <button type="submit" className="primary">
            {t('saveProfile')}
          </button>

          <p className="status-message">{status}</p>
        </form>
      </div>
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
    <Options />
  </StrictMode>,
)
