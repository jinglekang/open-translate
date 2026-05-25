import { StrictMode, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { clearTranslationCache, getTranslationCacheStats } from '../shared/cache'
import { getEndpointPreview } from '../shared/endpoint'
import { t } from '../shared/i18n'
import {
  createProfile,
  defaultSettings,
  getActiveProfile,
  normalizeSettings,
  profileFieldLimits,
  sanitizeSettings,
  translationBatchSegmentLimits,
  translationBatchTextLengthLimits,
  translationConcurrencyLimits,
} from '../shared/settings'
import type { TranslationProfile, TranslationSettings } from '../shared/settings'
import { builtInNoTranslateRules } from '../shared/whitelist'
import { Button } from '../components/ui/button'
import { StatusNotice } from '../components/status-notice'
import '../shared/style.css'

type OptionsTab = 'profiles' | 'cache' | 'whitelist'

export function Options() {
  const [settings, setSettings] = useState<TranslationSettings>(defaultSettings)
  const [editingId, setEditingId] = useState(defaultSettings.activeProfileId)
  const [activeTab, setActiveTab] = useState<OptionsTab>('profiles')
  const [cacheCount, setCacheCount] = useState(0)
  const [whitelistDraft, setWhitelistDraft] = useState(
    defaultSettings.userWhitelist.join('\n'),
  )
  const [status, setStatus] = useState(t('loadingSettings'))

  const editingProfile = useMemo(
    () =>
      settings.profiles.find((profile) => profile.id === editingId) ||
      getActiveProfile(settings),
    [editingId, settings],
  )
  const isChromeBuiltInProfile = editingProfile.provider === 'chrome-built-in'

  useEffect(() => {
    chrome.storage.sync.get(null).then((stored) => {
      const nextSettings = normalizeSettings(stored)
      setSettings(nextSettings)
      setEditingId(nextSettings.activeProfileId)
      setWhitelistDraft(nextSettings.userWhitelist.join('\n'))
      setStatus(t('settingsSynced'))
    })
    void refreshCacheStats()
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
    setWhitelistDraft(stored.userWhitelist.join('\n'))
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
        ...settings,
        profiles: [...settings.profiles, profile],
        activeProfileId: profile.id,
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
        ...settings,
        profiles: [...settings.profiles, profile],
        activeProfileId: profile.id,
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
      {
        ...settings,
        profiles,
        activeProfileId,
      },
      t('profileDeleted'),
      activeProfileId,
    )
  }

  async function activateProfile(profileId: string) {
    await saveSettings({ ...settings, activeProfileId: profileId }, t('activeProfileSet'), profileId)
  }

  async function saveWhitelist() {
    await saveSettings(
      {
        ...settings,
        userWhitelist: parseWhitelistDraft(whitelistDraft),
      },
      t('userWhitelistSaved'),
    )
  }

  async function refreshCacheStats() {
    const stats = await getTranslationCacheStats()
    setCacheCount(stats.count)
  }

  async function clearCache() {
    const removedCount = await clearTranslationCache()
    setCacheCount(0)
    setStatus(t('translationCacheCleared', String(removedCount)))
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
    <main className="min-h-screen bg-slate-50 px-7 py-7 text-slate-900">
      <header className="mx-auto mb-5 flex w-full max-w-260 items-center justify-between gap-4.5">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-blue-600">
            Open Translate
          </p>
          <h1 className="text-[28px] leading-tight font-semibold text-slate-900">
            {t('optionsTitle')}
          </h1>
        </div>
        {activeTab === 'profiles' && (
          <Button
            type="button"
            size="lg"
            className="h-9 rounded-md bg-blue-600 px-3.5 text-sm font-semibold text-white transition hover:bg-blue-700"
            onClick={addProfile}
          >
            {t('addProfile')}
          </Button>
        )}
      </header>

      <nav
        className="mx-auto mb-4 grid w-full max-w-260 grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-white p-1"
        aria-label={t('optionsTabs')}
      >
        {(['profiles', 'cache', 'whitelist'] as const).map((tab) => (
          <Button
            key={tab}
            type="button"
            variant={activeTab === tab ? 'default' : 'ghost'}
            className={
              activeTab === tab
                ? 'h-9 rounded-md bg-blue-600 text-sm font-semibold text-white'
                : 'h-9 rounded-md bg-transparent text-sm font-semibold text-slate-600 hover:bg-blue-50'
            }
            onClick={() => setActiveTab(tab)}
          >
            {t(`${tab}Tab`)}
          </Button>
        ))}
      </nav>

      {activeTab === 'profiles' && (
        <div className="mx-auto grid w-full max-w-260 grid-cols-[248px_minmax(0,1fr)] gap-4.5">
        <aside className="grid content-start gap-2" aria-label={t('profileListLabel')}>
          {settings.profiles.map((profile) => (
            <Button
              type="button"
              variant={profile.id === editingProfile.id ? 'default' : 'outline'}
              size="lg"
              key={profile.id}
              className={`relative grid h-auto min-h-17 w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1 overflow-hidden rounded-lg px-3 py-2.5 text-left transition before:absolute before:inset-y-2.25 before:left-0 before:w-0.75 before:rounded-r-full before:content-[''] ${profile.id === editingProfile.id
                ? 'border-blue-600 bg-blue-50 shadow-[0_0_0_3px_rgba(37,99,235,0.12)] before:bg-blue-600'
                : 'border-slate-200 bg-white before:bg-transparent hover:border-slate-300 hover:bg-slate-50'
                }`}
              onClick={() => setEditingId(profile.id)}
              title={`${profile.name} · ${
                profile.provider === 'chrome-built-in'
                  ? t('chromeBuiltInProvider')
                  : profile.model || t('modelUnset')
              }`}
            >
              <strong className="block max-w-full truncate text-sm leading-[1.35] font-semibold text-slate-900">
                {profile.name}
              </strong>
              <span className="block max-w-full truncate text-xs leading-[1.35] font-medium text-slate-500">
                {profile.provider === 'chrome-built-in'
                  ? t('chromeBuiltInProvider')
                  : t('modelPrefix', profile.model || t('modelUnset'))}
              </span>
            </Button>
          ))}
        </aside>

        <form
          className="grid gap-3.5 rounded-lg border border-slate-200 bg-white p-4.5"
          onSubmit={handleSubmit}
        >
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-9 rounded-md border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 disabled:cursor-default disabled:opacity-[0.55]"
              onClick={() => activateProfile(editingProfile.id)}
              disabled={settings.activeProfileId === editingProfile.id}
            >
              {t('setActive')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-9 rounded-md border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
              onClick={duplicateProfile}
            >
              {t('duplicate')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="lg"
              className="h-9 rounded-md border border-red-200 bg-red-50 px-3.5 text-sm font-semibold text-red-700 transition hover:bg-red-100"
              onClick={removeProfile}
            >
              {t('delete')}
            </Button>
          </div>

          <label className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-slate-600">{t('profileName')}</span>
            <input
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
              value={editingProfile.name}
              onChange={(event) => updateProfile('name', event.target.value)}
              placeholder={t('profileNamePlaceholder')}
              maxLength={profileFieldLimits.name}
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-slate-600">
              {t('translationProvider')}
            </span>
            <select
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
              value={editingProfile.provider}
              onChange={(event) =>
                updateProfile(
                  'provider',
                  event.target.value as TranslationProfile['provider'],
                )
              }
            >
              <option value="openai-compatible">{t('openAICompatibleProvider')}</option>
              <option value="chrome-built-in">{t('chromeBuiltInProvider')}</option>
            </select>
          </label>

          {isChromeBuiltInProfile && (
            <div className="grid gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <span className="text-[13px] font-semibold text-slate-600">
                {t('chromeBuiltInProvider')}
              </span>
              <p className="m-0 text-sm leading-5 text-slate-600">
                {t('chromeBuiltInDescription')}
              </p>
            </div>
          )}

          {!isChromeBuiltInProfile && (
          <label className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-slate-600">{t('apiBaseUrl')}</span>
            <input
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
              value={editingProfile.apiBaseUrl}
              onChange={(event) => updateProfile('apiBaseUrl', event.target.value)}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              maxLength={profileFieldLimits.apiBaseUrl}
            />
          </label>
          )}

          {isChromeBuiltInProfile ? (
            <label className="grid gap-1.5">
              <span className="text-[13px] font-semibold text-slate-600">
                {t('translationConcurrency')}
              </span>
              <input
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
                value={editingProfile.translationConcurrency}
                onChange={(event) =>
                  updateProfile('translationConcurrency', Number(event.target.value))
                }
                type="number"
                min={translationConcurrencyLimits.min}
                max={translationConcurrencyLimits.max}
                step={1}
              />
            </label>
          ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_128px] gap-3">
            <label className="grid min-w-0 gap-1.5">
              <span className="text-[13px] font-semibold text-slate-600">{t('modelName')}</span>
              <input
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
                value={editingProfile.model}
                onChange={(event) => updateProfile('model', event.target.value)}
                placeholder="gpt-4o-mini"
                spellCheck={false}
                maxLength={profileFieldLimits.model}
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-[13px] font-semibold text-slate-600">{t('translationConcurrency')}</span>
              <input
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
                value={editingProfile.translationConcurrency}
                onChange={(event) => updateProfile('translationConcurrency', Number(event.target.value))}
                type="number"
                min={translationConcurrencyLimits.min}
                max={translationConcurrencyLimits.max}
                step={1}
              />
            </label>
          </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1.5">
              <span className="text-[13px] font-semibold text-slate-600">
                {t('translationBatchSegments')}
              </span>
              <input
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
                value={editingProfile.translationBatchSegments}
                onChange={(event) =>
                  updateProfile('translationBatchSegments', Number(event.target.value))
                }
                type="number"
                min={translationBatchSegmentLimits.min}
                max={translationBatchSegmentLimits.max}
                step={1}
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-[13px] font-semibold text-slate-600">
                {t('translationBatchTextLength')}
              </span>
              <input
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
                value={editingProfile.translationBatchTextLength}
                onChange={(event) =>
                  updateProfile('translationBatchTextLength', Number(event.target.value))
                }
                type="number"
                min={translationBatchTextLengthLimits.min}
                max={translationBatchTextLengthLimits.max}
                step={1}
              />
            </label>
          </div>

          {!isChromeBuiltInProfile && (
          <label className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-slate-600">{t('apiKey')}</span>
            <input
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
              value={editingProfile.apiKey}
              onChange={(event) => updateProfile('apiKey', event.target.value)}
              placeholder="sk-..."
              type="password"
              spellCheck={false}
              maxLength={profileFieldLimits.apiKey}
            />
          </label>
          )}

          {!isChromeBuiltInProfile && (
          <label className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-slate-600">{t('customPrompt')}</span>
            <textarea
              className="min-h-28 w-full resize-y rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm leading-snug text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
              value={editingProfile.customPrompt}
              onChange={(event) => updateProfile('customPrompt', event.target.value)}
              placeholder={t('customPromptPlaceholder')}
              rows={5}
              maxLength={profileFieldLimits.customPrompt}
            />
          </label>
          )}

          {!isChromeBuiltInProfile && (
          <div className="grid gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <span className="text-[13px] font-semibold text-slate-600">{t('endpointPreview')}</span>
            <code className="break-all font-mono text-xs leading-relaxed text-slate-700">
              {getEndpointPreview(editingProfile.apiBaseUrl)}
            </code>
          </div>
          )}

          <Button
            type="submit"
            size="lg"
            className="h-9 rounded-md bg-blue-600 px-3.5 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            {t('saveProfile')}
          </Button>

          <StatusNotice message={status} />
        </form>
      </div>
      )}

      {activeTab === 'cache' && (
        <section className="mx-auto grid w-full max-w-260 gap-3.5 rounded-lg border border-slate-200 bg-white p-4.5">
          <div className="grid gap-1">
            <h2 className="text-lg font-semibold text-slate-900">{t('cacheSettings')}</h2>
            <p className="text-sm leading-5 text-slate-600">{t('cacheDescription')}</p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
            <div>
              <span className="block text-[13px] font-semibold text-slate-600">
                {t('translationCacheCount')}
              </span>
              <strong className="block text-2xl leading-tight font-semibold text-slate-900">
                {cacheCount}
              </strong>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-9 rounded-md border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                onClick={refreshCacheStats}
              >
                {t('refresh')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="lg"
                className="h-9 rounded-md border border-red-200 bg-red-50 px-3.5 text-sm font-semibold text-red-700 hover:bg-red-100"
                onClick={clearCache}
                disabled={!cacheCount}
              >
                {t('clearTranslationCache')}
              </Button>
            </div>
          </div>

          <StatusNotice message={status} />
        </section>
      )}

      {activeTab === 'whitelist' && (
        <section className="mx-auto grid w-full max-w-260 gap-3.5 rounded-lg border border-slate-200 bg-white p-4.5">
          <div className="grid gap-1">
            <h2 className="text-lg font-semibold text-slate-900">{t('whitelistSettings')}</h2>
            <p className="text-sm leading-5 text-slate-600">{t('whitelistDescription')}</p>
          </div>

          <label className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-slate-600">{t('userWhitelist')}</span>
            <textarea
              className="min-h-54 w-full resize-y rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm leading-6 text-slate-900 outline-none transition focus:border-blue-600 focus:ring-[3px] focus:ring-blue-100"
              value={whitelistDraft}
              onChange={(event) => setWhitelistDraft(event.target.value)}
              placeholder={t('userWhitelistPlaceholder')}
              rows={10}
            />
          </label>

          <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <span className="text-[13px] font-semibold text-slate-600">{t('builtInWhitelist')}</span>
            <div className="flex flex-wrap gap-1.5">
              {builtInNoTranslateRules.map((rule) => (
                <span
                  key={rule}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600"
                >
                  {t(`builtInWhitelist_${rule}`)}
                </span>
              ))}
            </div>
          </div>

          <Button
            type="button"
            size="lg"
            className="h-9 w-fit rounded-md bg-blue-600 px-3.5 text-sm font-semibold text-white hover:bg-blue-700"
            onClick={saveWhitelist}
          >
            {t('saveWhitelist')}
          </Button>

          <StatusNotice message={status} />
        </section>
      )}
    </main>
  )
}

function parseWhitelistDraft(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
)
