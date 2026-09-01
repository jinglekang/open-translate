import { StrictMode, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { applyAppTheme } from '../shared/appearance'
import {
  clearTranslationCache,
  deleteStaleTranslationCache,
  getTranslationCacheStats,
  pruneTranslationCache,
  staleTranslationCacheDays,
} from '../shared/cache'
import type { TranslationCacheStats } from '../shared/cache'
import { getEndpointPreview } from '../shared/endpoint'
import { setAppLanguage, t } from '../shared/i18n'
import { targetLanguageOptions } from '../shared/languages'
import { getDefaultBaseTranslationPromptTemplate } from '../shared/prompt'
import {
  createProfile,
  builtInTranslatorConcurrencyDefault,
  defaultOpenAICompatibleApiBaseUrl,
  defaultOpenAICompatibleModel,
  defaultSettings,
  getActiveProfile,
  normalizeSettings,
  profileFieldLimits,
  sanitizeSettings,
  minTranslationTextLengthLimits,
  translationCacheEntryLimits,
  translationBatchSegmentLimits,
  translationBatchTextLengthLimits,
  translationConcurrencyLimits,
} from '../shared/settings'
import type { TranslationProfile, TranslationSettings } from '../shared/settings'
import { builtInNoTranslateRules } from '../shared/whitelist'
import { AppLanguageControl } from '../components/app-language-control'
import { AppThemeControl } from '../components/app-theme-control'
import { Button } from '../components/ui/button'
import { Toaster } from '../components/ui/sonner'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import '../shared/style.css'

type OptionsTab = 'translators' | 'translation' | 'cache' | 'rules'

const emptyCacheStats: TranslationCacheStats = {
  count: 0,
  approximateSize: 0,
}
const translationCacheEntryPresets = [
  { value: 10_000, label: 'translationCacheEntriesPreset10000' },
  { value: 20_000, label: 'translationCacheEntriesPreset20000' },
  { value: 50_000, label: 'translationCacheEntriesPreset50000' },
  { value: 100_000, label: 'translationCacheEntriesPreset100000' },
] as const

export function Options() {
  const [settings, setSettings] = useState<TranslationSettings>(defaultSettings)
  const [editingId, setEditingId] = useState(defaultSettings.activeProfileId)
  const [activeTab, setActiveTab] = useState<OptionsTab>('translation')
  const [cacheStats, setCacheStats] = useState<TranslationCacheStats>(emptyCacheStats)
  const [whitelistDraft, setWhitelistDraft] = useState(
    formatCommaList(defaultSettings.userWhitelist),
  )
  const [noTranslateSelectorsDraft, setNoTranslateSelectorsDraft] = useState(
    formatCommaList(defaultSettings.noTranslateSelectors),
  )
  const editingProfile = useMemo(
    () =>
      settings.profiles.find((profile) => profile.id === editingId) ||
      getActiveProfile(settings),
    [editingId, settings],
  )
  const defaultCustomPrompt = getDefaultBaseTranslationPromptTemplate()
  const effectiveCustomPrompt =
    editingProfile.customPrompt || defaultCustomPrompt
  const isBuiltInTranslatorProfile = editingProfile.provider === 'built-in-translator'

  useEffect(() => {
    chrome.storage.sync.get(null).then((stored) => {
      const nextSettings = normalizeSettings(stored)
      setAppLanguage(nextSettings.appLanguage)
      applyAppTheme(nextSettings.appTheme)
      setSettings(nextSettings)
      setEditingId(nextSettings.activeProfileId)
      setWhitelistDraft(formatCommaList(nextSettings.userWhitelist))
      setNoTranslateSelectorsDraft(formatCommaList(nextSettings.noTranslateSelectors))
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
      toast.error(message)
      return
    }

    const stored = normalizeSettings(await chrome.storage.sync.get(null))

    if (
      stored.profiles.length !== sanitizedSettings.profiles.length ||
      stored.activeProfileId !== sanitizedSettings.activeProfileId ||
      stored.maxTranslationCacheEntries !== sanitizedSettings.maxTranslationCacheEntries
    ) {
      console.error('Open Translate settings save verification failed', {
        expected: sanitizedSettings,
        stored,
      })
      toast.error(t('saveFailed'))
      return
    }

    setSettings(stored)
    setAppLanguage(stored.appLanguage)
    applyAppTheme(stored.appTheme)
    setWhitelistDraft(formatCommaList(stored.userWhitelist))
    setNoTranslateSelectorsDraft(formatCommaList(stored.noTranslateSelectors))
    setEditingId(
      stored.profiles.some((profile) => profile.id === nextEditingId)
        ? nextEditingId
        : stored.activeProfileId,
    )
    toast.success(message)
    return stored
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
      toast.warning(t('keepOneProfile'))
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
        userWhitelist: parseCommaListDraft(whitelistDraft),
        noTranslateSelectors: parseCommaListDraft(noTranslateSelectorsDraft),
      },
      t('rulesSaved'),
    )
  }

  async function saveTranslationSettings() {
    await saveSettings(settings, t('translationSettingsSaved'))
  }

  async function saveCacheSettings() {
    const stored = await saveSettings(settings, t('cacheSettingsSaved'))
    if (!stored) {
      return
    }

    try {
      await pruneTranslationCache(stored.maxTranslationCacheEntries)
      await refreshCacheStats()
    } catch (error) {
      console.warn('Open Translate cache prune failed', error)
    }
  }

  function updateSetting<Key extends keyof TranslationSettings>(
    key: Key,
    value: TranslationSettings[Key],
  ) {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }))
  }

  async function refreshCacheStats() {
    const stats = await getTranslationCacheStats()
    setCacheStats(stats)
  }

  async function clearCache() {
    const removedCount = await clearTranslationCache()
    setCacheStats(emptyCacheStats)
    toast.success(t('translationCacheCleared', String(removedCount)))
  }

  async function deleteOldCache() {
    const removedCount = await deleteStaleTranslationCache()
    await refreshCacheStats()
    toast.success(t('staleTranslationCacheDeleted', String(removedCount)))
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

  function updateProfileProvider(provider: TranslationProfile['provider']) {
    setSettings((current) => ({
      ...current,
      profiles: current.profiles.map((profile) => {
        if (profile.id !== editingProfile.id) {
          return profile
        }

        if (provider === 'built-in-translator') {
          return {
            ...profile,
            provider,
            apiBaseUrl: '',
            model: '',
            apiKey: '',
            customPrompt: '',
            translationConcurrency: builtInTranslatorConcurrencyDefault,
          }
        }

        return {
          ...profile,
          provider,
          apiBaseUrl: profile.apiBaseUrl || defaultOpenAICompatibleApiBaseUrl,
          model: profile.model || defaultOpenAICompatibleModel,
        }
      }),
    }))
  }

  return (
    <main className="min-h-screen bg-slate-50 px-7 py-7 text-slate-900">
      <header className="mx-auto mb-5 flex w-full max-w-300 items-center justify-between gap-4.5">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-500">
            Open Translate
          </p>
          <h1 className="text-[28px] leading-tight font-semibold text-slate-900">
            {t('optionsTitle')}
          </h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <AppLanguageControl
            appLanguage={settings.appLanguage}
            onLanguageApplied={(appLanguage) =>
              setSettings((current) => ({ ...current, appLanguage }))
            }
            onLanguageSaved={() => toast.success(t('languageSaved'))}
            onLanguageSaveFailed={() => toast.error(t('saveFailed'))}
            buttonClassName="size-9 rounded-full"
          />

          <AppThemeControl
            appTheme={settings.appTheme}
            onThemeApplied={(appTheme) => setSettings((current) => ({ ...current, appTheme }))}
            onThemeSaved={() => toast.success(t('appearanceSaved'))}
            onThemeSaveFailed={() => toast.error(t('saveFailed'))}
            buttonClassName="size-9 rounded-full"
          />
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-300 grid-cols-[220px_minmax(0,1fr)] items-start gap-5">
        <nav
          className="sticky top-7 grid gap-1 rounded-lg border border-slate-200 bg-white p-2"
          aria-label={t('optionsTabs')}
        >
          {(['translation', 'translators', 'rules', 'cache'] as const).map((tab) => (
            <Button
              key={tab}
              type="button"
              variant={activeTab === tab ? 'default' : 'ghost'}
              className={
                activeTab === tab
                  ? 'h-10 justify-start rounded-md bg-slate-800 px-3 text-sm font-semibold text-white'
                  : 'h-10 justify-start rounded-md bg-transparent px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100'
              }
              onClick={() => setActiveTab(tab)}
            >
              {t(`${tab}Tab`)}
            </Button>
          ))}
        </nav>

        <div className="min-w-0">
          {activeTab === 'translators' && (
            <div className="grid w-full grid-cols-[248px_minmax(0,1fr)] gap-4.5">
              <aside className="grid content-start gap-2" aria-label={t('profileListLabel')}>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-9 w-full rounded-md border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
                  onClick={addProfile}
                >
                  {t('addProfile')}
                </Button>
                {settings.profiles.map((profile) => (
                  <Button
                    type="button"
                    variant={profile.id === editingProfile.id ? 'default' : 'outline'}
                    size="lg"
                    key={profile.id}
                    className={`relative grid h-auto min-h-17 w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1 overflow-hidden rounded-lg px-3 py-2.5 text-left transition before:absolute before:inset-y-2.25 before:left-0 before:w-0.75 before:rounded-r-full before:content-[''] ${profile.id === editingProfile.id
                      ? 'border-slate-400 bg-slate-100 shadow-[0_0_0_3px_rgba(71,85,105,0.12)] before:bg-slate-800'
                      : 'border-slate-200 bg-white before:bg-transparent hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    onClick={() => setEditingId(profile.id)}
                    title={`${profile.name} · ${profile.provider === 'built-in-translator'
                      ? t('builtInTranslatorProvider')
                      : profile.model || t('modelUnset')
                      }`}
                  >
                    <strong className="block max-w-full truncate text-sm leading-[1.35] font-semibold text-slate-900">
                      {profile.name}
                    </strong>
                    <span className="block max-w-full truncate text-xs leading-[1.35] font-medium text-slate-500">
                      {profile.provider === 'built-in-translator'
                        ? t('builtInTranslatorProvider')
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
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
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
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
                    value={editingProfile.provider}
                    onChange={(event) =>
                      updateProfileProvider(event.target.value as TranslationProfile['provider'])
                    }
                  >
                    <option value="built-in-translator">{t('builtInTranslatorProvider')}</option>
                    <option value="openai-compatible">{t('openAICompatibleProvider')}</option>
                  </select>
                </label>

                {isBuiltInTranslatorProfile && (
                  <div className="grid gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                    <span className="text-[13px] font-semibold text-slate-600">
                      {t('builtInTranslatorProvider')}
                    </span>
                    <p className="m-0 text-sm leading-5 text-slate-600">
                      {t('builtInTranslatorDescription')}
                    </p>
                  </div>
                )}

                {!isBuiltInTranslatorProfile && (
                  <label className="grid gap-1.5">
                    <span className="text-[13px] font-semibold text-slate-600">{t('apiBaseUrl')}</span>
                    <input
                      className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
                      value={editingProfile.apiBaseUrl}
                      onChange={(event) => updateProfile('apiBaseUrl', event.target.value)}
                      placeholder={defaultOpenAICompatibleApiBaseUrl}
                      spellCheck={false}
                      maxLength={profileFieldLimits.apiBaseUrl}
                    />
                  </label>
                )}

                {!isBuiltInTranslatorProfile && (
                  <label className="grid gap-1.5">
                    <span className="text-[13px] font-semibold text-slate-600">{t('modelName')}</span>
                    <input
                      className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
                      value={editingProfile.model}
                      onChange={(event) => updateProfile('model', event.target.value)}
                      placeholder={defaultOpenAICompatibleModel}
                      spellCheck={false}
                      maxLength={profileFieldLimits.model}
                    />
                  </label>
                )}

                <div className="grid grid-cols-3 gap-3">
                  <label className="grid min-w-0 gap-1.5">
                    <span className="text-[13px] leading-4 font-semibold text-slate-600">{t('translationConcurrency')}</span>
                    <input
                      className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
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

                  <label className="grid gap-1.5">
                    <span className="text-[13px] leading-4 font-semibold text-slate-600">
                      {t('translationBatchSegments')}
                    </span>
                    <input
                      className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
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
                    <span className="text-[13px] leading-4 font-semibold text-slate-600">
                      {t('translationBatchTextLength')}
                    </span>
                    <input
                      className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
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

                {!isBuiltInTranslatorProfile && (
                  <label className="grid gap-1.5">
                    <span className="text-[13px] font-semibold text-slate-600">{t('apiKey')}</span>
                    <input
                      className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
                      value={editingProfile.apiKey}
                      onChange={(event) => updateProfile('apiKey', event.target.value)}
                      placeholder="sk-..."
                      type="password"
                      spellCheck={false}
                      maxLength={profileFieldLimits.apiKey}
                    />
                  </label>
                )}

                {!isBuiltInTranslatorProfile && (
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] font-semibold text-slate-600">{t('customPrompt')}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 rounded-md border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        onClick={() => updateProfile('customPrompt', '')}
                        disabled={!editingProfile.customPrompt}
                      >
                        {t('restoreDefaultPrompt')}
                      </Button>
                    </div>
                    <textarea
                      className="min-h-28 w-full resize-y rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm leading-snug text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
                      value={effectiveCustomPrompt}
                      onChange={(event) => {
                        const value = event.target.value
                        updateProfile('customPrompt', value === defaultCustomPrompt ? '' : value)
                      }}
                      placeholder={defaultCustomPrompt}
                      rows={5}
                      maxLength={profileFieldLimits.customPrompt}
                    />
                  </div>
                )}

                {!isBuiltInTranslatorProfile && (
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
                  className="h-9 w-fit rounded-md bg-slate-800 px-3.5 text-sm font-semibold text-white transition hover:bg-slate-700"
                >
                  {t('saveProfile')}
                </Button>

              </form>
            </div>
          )}

          {activeTab === 'translation' && (
            <section className="grid w-full gap-3.5 rounded-lg border border-slate-200 bg-white p-4.5">
              <div className="grid gap-1">
                <h2 className="text-lg font-semibold text-slate-900">
                  {t('translationSettings')}
                </h2>
                <p className="text-sm leading-5 text-slate-600">
                  {t('translationSettingsDescription')}
                </p>
              </div>

              <div className="grid max-w-72 gap-1.5">
                <span className="text-[13px] font-semibold text-slate-600">
                  {t('targetLanguage')}
                </span>
                <Select
                  value={settings.targetLanguage}
                  onValueChange={(value) => {
                    if (!value) {
                      return
                    }

                    updateSetting('targetLanguage', value)
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

              <label className="grid max-w-72 gap-1.5">
                <span className="text-[13px] font-semibold text-slate-600">
                  {t('minTranslationTextLength')}
                </span>
                <input
                  className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
                  value={settings.minTranslationTextLength}
                  onChange={(event) =>
                    updateSetting('minTranslationTextLength', Number(event.target.value))
                  }
                  type="number"
                  min={minTranslationTextLengthLimits.min}
                  max={minTranslationTextLengthLimits.max}
                  step={1}
                />
              </label>

              <fieldset className="grid gap-2 border-0 p-0 m-0">
                <legend className="text-[13px] font-semibold text-slate-600">
                  {t('displayMode')}
                </legend>
                <p className="m-0 text-xs leading-5 text-slate-500">
                  {t(
                    settings.displayMode === 'bilingual'
                      ? 'bilingualDescription'
                      : 'translationOnlyDescription',
                  )}
                </p>
                <div className="grid max-w-96 grid-cols-2 gap-1.5 rounded-lg border border-slate-200 bg-white p-1">
                  <Button
                    type="button"
                    size="default"
                    variant={settings.displayMode === 'bilingual' ? 'default' : 'ghost'}
                    className={
                      settings.displayMode === 'bilingual'
                        ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                        : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
                    }
                    onClick={() => updateSetting('displayMode', 'bilingual')}
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
                    onClick={() => updateSetting('displayMode', 'translation')}
                  >
                    {t('translationOnly')}
                  </Button>
                </div>
              </fieldset>

              <fieldset className="grid gap-2 border-0 p-0 m-0">
                <legend className="text-[13px] font-semibold text-slate-600">
                  {t('translationScope')}
                </legend>
                <p className="m-0 text-xs leading-5 text-slate-500">
                  {t(
                    settings.translationScope === 'viewport'
                      ? 'viewportDescription'
                      : 'visiblePageDescription',
                  )}
                </p>
                <div className="grid max-w-96 grid-cols-2 gap-1.5 rounded-lg border border-slate-200 bg-white p-1">
                  <Button
                    type="button"
                    size="default"
                    variant={settings.translationScope === 'viewport' ? 'default' : 'ghost'}
                    className={
                      settings.translationScope === 'viewport'
                        ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                        : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
                    }
                    onClick={() => updateSetting('translationScope', 'viewport')}
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
                    onClick={() => updateSetting('translationScope', 'visible-page')}
                  >
                    {t('visiblePage')}
                  </Button>
                </div>
              </fieldset>

              <fieldset className="grid gap-2 border-0 p-0 m-0">
                <legend className="text-[13px] font-semibold text-slate-600">
                  {t('translationMode')}
                </legend>
                <p className="m-0 text-xs leading-5 text-slate-500">
                  {t(
                    settings.translationMode === 'element-context'
                      ? 'wholeParagraphTranslationModeDescription'
                      : 'textNodeTranslationModeDescription',
                  )}
                </p>
                <div className="grid max-w-96 grid-cols-2 gap-1.5 rounded-lg border border-slate-200 bg-white p-1">
                  <Button
                    type="button"
                    size="default"
                    variant={
                      settings.translationMode === 'element-context' ? 'default' : 'ghost'
                    }
                    className={
                      settings.translationMode === 'element-context'
                        ? 'h-8 rounded-md bg-slate-800 text-sm font-semibold text-white'
                        : 'h-8 rounded-md bg-transparent text-sm font-semibold text-slate-600 transition hover:bg-slate-100'
                    }
                    onClick={() => updateSetting('translationMode', 'element-context')}
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
                    onClick={() => updateSetting('translationMode', 'text-node')}
                  >
                    {t('textNodeTranslationMode')}
                  </Button>
                </div>
              </fieldset>

              <Button
                type="button"
                size="lg"
                className="h-9 w-fit rounded-md bg-slate-800 px-3.5 text-sm font-semibold text-white hover:bg-slate-700"
                onClick={saveTranslationSettings}
              >
                {t('saveTranslationSettings')}
              </Button>

            </section>
          )}

          {activeTab === 'cache' && (
            <section className="grid w-full gap-3.5 rounded-lg border border-slate-200 bg-white p-4.5">
              <div className="grid gap-1">
                <h2 className="text-lg font-semibold text-slate-900">{t('cacheSettings')}</h2>
                <p className="text-sm leading-5 text-slate-600">{t('cacheDescription')}</p>
              </div>

              <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="text-sm font-semibold text-slate-800">{t('cacheOverview')}</h3>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-md border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      onClick={refreshCacheStats}
                    >
                      {t('refresh')}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="h-8 rounded-md border border-red-200 bg-red-50 px-3 text-xs font-semibold text-red-700 hover:bg-red-100"
                      onClick={clearCache}
                      disabled={!cacheStats.count}
                    >
                      {t('clearTranslationCache')}
                    </Button>
                  </div>
                </div>
                <div className="grid sm:grid-cols-3">
                  <div className="px-4 py-3.5">
                    <span className="block text-xs font-semibold text-slate-500">
                      {t('translationCacheCount')}
                    </span>
                    <strong className="block text-2xl leading-tight font-semibold text-slate-900">
                      {formatNumber(cacheStats.count)}
                    </strong>
                  </div>
                  <div className="border-t border-slate-200 px-4 py-3.5 sm:border-t-0 sm:border-l">
                    <CacheStatItem
                      label={t('translationCacheApproximateSize')}
                      value={formatCacheSize(cacheStats.approximateSize)}
                    />
                  </div>
                  <div className="border-t border-slate-200 px-4 py-3.5 sm:border-t-0 sm:border-l">
                    <CacheStatItem
                      label={t('translationCacheLastAccess')}
                      value={formatCacheDate(cacheStats.newestAccessedAt)}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="grid gap-1">
                  <h3 className="text-sm font-semibold text-slate-800">
                    {t('staleTranslationCacheCleanup')}
                  </h3>
                  <p className="text-xs leading-5 text-slate-500">
                    {t('deleteStaleTranslationCacheDescription', String(staleTranslationCacheDays))}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-9 shrink-0 rounded-md border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                  onClick={deleteOldCache}
                  disabled={!cacheStats.count}
                >
                  {t('deleteStaleTranslationCache')}
                </Button>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <label className="grid gap-1" htmlFor="max-translation-cache-entries">
                  <span className="text-sm font-semibold text-slate-800">
                    {t('maxTranslationCacheEntries')}
                  </span>
                  <span className="text-xs leading-5 text-slate-500">
                    {t('maxTranslationCacheEntriesDescription')}
                  </span>
                </label>
                <div className="mt-3 grid gap-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      id="max-translation-cache-entries"
                      className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200 sm:max-w-60"
                      value={settings.maxTranslationCacheEntries}
                      onChange={(event) =>
                        updateSetting('maxTranslationCacheEntries', Number(event.target.value))
                      }
                      type="number"
                      min={translationCacheEntryLimits.min}
                      max={translationCacheEntryLimits.max}
                      step={1}
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {translationCacheEntryPresets.map((preset) => {
                        const isSelected = settings.maxTranslationCacheEntries === preset.value

                        return (
                          <Button
                            key={preset.value}
                            type="button"
                            variant={isSelected ? 'secondary' : 'outline'}
                            size="lg"
                            className={
                              isSelected
                                ? 'h-9 min-w-14 rounded-md border border-slate-400 bg-slate-200 px-3 text-sm font-semibold text-slate-900 hover:bg-slate-200'
                                : 'h-9 min-w-14 rounded-md border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100'
                            }
                            aria-pressed={isSelected}
                            onClick={() =>
                              updateSetting('maxTranslationCacheEntries', preset.value)
                            }
                          >
                            {t(preset.label)}
                          </Button>
                        )
                      })}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="lg"
                    className="h-9 w-fit rounded-md bg-slate-800 px-3.5 text-sm font-semibold text-white hover:bg-slate-700"
                    onClick={saveCacheSettings}
                  >
                    {t('saveCacheSettings')}
                  </Button>
                </div>
              </div>

            </section>
          )}

          {activeTab === 'rules' && (
            <section className="grid w-full gap-3.5 rounded-lg border border-slate-200 bg-white p-4.5">
              <div className="grid gap-1">
                <h2 className="text-lg font-semibold text-slate-900">{t('rulesSettings')}</h2>
                <p className="text-sm leading-5 text-slate-600">{t('rulesDescription')}</p>
              </div>

              <label className="grid gap-1.5">
                <span className="text-[13px] font-semibold text-slate-600">{t('userWhitelist')}</span>
                <textarea
                  className="min-h-24 w-full resize-y rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm leading-6 text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
                  value={whitelistDraft}
                  onChange={(event) => setWhitelistDraft(event.target.value)}
                  placeholder={t('userWhitelistPlaceholder')}
                  rows={4}
                />
              </label>

              <label className="grid gap-1.5">
                <span className="text-[13px] font-semibold text-slate-600">
                  {t('noTranslateSelectors')}
                </span>
                <textarea
                  className="min-h-24 w-full resize-y rounded-md border border-slate-300 bg-white px-2.5 py-2 font-mono text-sm leading-6 text-slate-900 outline-none transition focus:border-slate-400 focus:ring-[3px] focus:ring-slate-200"
                  value={noTranslateSelectorsDraft}
                  onChange={(event) => setNoTranslateSelectorsDraft(event.target.value)}
                  placeholder={t('noTranslateSelectorsPlaceholder')}
                  rows={4}
                  spellCheck={false}
                />
              </label>

              <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <span className="text-[13px] font-semibold text-slate-600">{t('builtInRules')}</span>
                <div className="flex flex-wrap gap-1.5">
                  {builtInNoTranslateRules.map((rule) => (
                    <span
                      key={rule}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600"
                    >
                      {t(`builtInRule_${rule}`)}
                    </span>
                  ))}
                </div>
              </div>

              <Button
                type="button"
                size="lg"
                className="h-9 w-fit rounded-md bg-slate-800 px-3.5 text-sm font-semibold text-white hover:bg-slate-700"
                onClick={saveWhitelist}
              >
                {t('saveRules')}
              </Button>

            </section>
          )}
        </div>
      </div>
      <Toaster position="top-center" />
    </main>
  )
}

function parseCommaListDraft(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatCommaList(items: readonly string[]) {
  return items.join(', ')
}

function CacheStatItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span className="block text-[12px] font-semibold text-slate-500">{label}</span>
      <strong className="block truncate text-base font-semibold text-slate-900">{value}</strong>
    </div>
  )
}

function formatCacheSize(size: number) {
  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

function formatCacheDate(value?: number) {
  if (!value) {
    return '-'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
)
