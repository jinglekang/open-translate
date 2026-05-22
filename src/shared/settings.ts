import { z } from 'zod'
import { t } from './i18n'

const trimmedString = z.string().trim()

export const profileFieldLimits = {
  name: 60,
  apiBaseUrl: 500,
  model: 120,
  apiKey: 500,
  targetLanguage: 40,
  customPrompt: 4000,
} as const
export const translationConcurrencyLimits = {
  min: 1,
  default: 4,
  max: 8,
} as const

export const translationDisplayModeSchema = z.enum(['translation', 'bilingual'])
export type TranslationDisplayMode = z.infer<typeof translationDisplayModeSchema>
export const pageTranslationScopeSchema = z.enum(['visible-page', 'viewport'])
export type PageTranslationScope = z.infer<typeof pageTranslationScopeSchema>

export const translationProfileSchema = z.object({
  id: trimmedString.min(1),
  name: trimmedString
    .min(1, t('profileNameRequired'))
    .max(profileFieldLimits.name, t('profileNameTooLong', String(profileFieldLimits.name)))
    .catch(t('untitledProfile')),
  apiBaseUrl: trimmedString
    .min(1, t('apiBaseUrlRequired'))
    .max(
      profileFieldLimits.apiBaseUrl,
      t('apiBaseUrlTooLong', String(profileFieldLimits.apiBaseUrl)),
    )
    .catch('https://api.openai.com/v1'),
  model: trimmedString
    .min(1, t('modelNameRequired'))
    .max(profileFieldLimits.model, t('modelNameTooLong', String(profileFieldLimits.model)))
    .catch('gpt-4o-mini'),
  apiKey: trimmedString
    .max(profileFieldLimits.apiKey, t('apiKeyTooLong', String(profileFieldLimits.apiKey)))
    .catch(''),
  translationConcurrency: z.coerce
    .number()
    .int(t('translationConcurrencyInvalid'))
    .min(translationConcurrencyLimits.min, t('translationConcurrencyInvalid'))
    .max(translationConcurrencyLimits.max, t('translationConcurrencyInvalid'))
    .catch(translationConcurrencyLimits.default),
  customPrompt: trimmedString
    .max(
      profileFieldLimits.customPrompt,
      t('customPromptTooLong', String(profileFieldLimits.customPrompt)),
    )
    .catch(''),
})

export const translationSettingsSchema = z
  .object({
    profiles: z.array(translationProfileSchema).min(1),
    activeProfileId: trimmedString.min(1),
    displayMode: translationDisplayModeSchema.catch('bilingual'),
    pageTranslationScope: pageTranslationScopeSchema.catch('viewport'),
    targetLanguage: trimmedString
      .min(1, t('targetLanguageRequired'))
      .max(
        profileFieldLimits.targetLanguage,
        t('targetLanguageTooLong', String(profileFieldLimits.targetLanguage)),
      )
      .catch('简体中文'),
  })
  .transform((settings) => {
    const activeProfileId = settings.profiles.some(
      (profile) => profile.id === settings.activeProfileId,
    )
      ? settings.activeProfileId
      : settings.profiles[0].id

    return {
      profiles: settings.profiles,
      activeProfileId,
      displayMode: settings.displayMode,
      pageTranslationScope: settings.pageTranslationScope,
      targetLanguage: settings.targetLanguage,
    }
  })

export type TranslationProfile = z.infer<typeof translationProfileSchema>
export type TranslationSettings = z.infer<typeof translationSettingsSchema>

export const defaultProfile: TranslationProfile = {
  id: 'default',
  name: t('defaultProfileName'),
  apiBaseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  translationConcurrency: translationConcurrencyLimits.default,
  customPrompt: '',
}

export const defaultSettings: TranslationSettings = {
  profiles: [defaultProfile],
  activeProfileId: defaultProfile.id,
  displayMode: 'bilingual',
  pageTranslationScope: 'viewport',
  targetLanguage: '简体中文',
}

const legacySettingsSchema = z.object({
  apiBaseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  targetLanguage: z.string().optional(),
  customPrompt: z.string().optional(),
})

export function createProfile(): TranslationProfile {
  return {
    ...defaultProfile,
    id: `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: t('newProfileName'),
    apiKey: '',
  }
}

export function normalizeSettings(stored: unknown): TranslationSettings {
  const settingsResult = translationSettingsSchema.safeParse(stored)
  if (settingsResult.success) {
    return settingsResult.data
  }

  const storedObject = z.record(z.string(), z.unknown()).safeParse(stored)
  if (!storedObject.success) {
    return defaultSettings
  }

  const legacyResult = legacySettingsSchema.safeParse(storedObject.data)
  if (!legacyResult.success) {
    return defaultSettings
  }

  return sanitizeSettings({
    profiles: [
      {
        ...defaultProfile,
        apiBaseUrl: legacyResult.data.apiBaseUrl || defaultProfile.apiBaseUrl,
        model: legacyResult.data.model || defaultProfile.model,
        apiKey: legacyResult.data.apiKey || defaultProfile.apiKey,
        customPrompt: legacyResult.data.customPrompt || defaultProfile.customPrompt,
      },
    ],
    activeProfileId: defaultProfile.id,
    displayMode: 'bilingual',
    pageTranslationScope: 'viewport',
    targetLanguage: legacyResult.data.targetLanguage || defaultSettings.targetLanguage,
  })
}

export function sanitizeSettings(settings: TranslationSettings): TranslationSettings {
  const settingsResult = translationSettingsSchema.safeParse(settings)
  if (settingsResult.success) {
    return settingsResult.data
  }

  throw new Error(settingsResult.error.issues[0]?.message || t('settingsInvalid'))
}

export function validateProfileForUse(profile: TranslationProfile) {
  const result = translationProfileSchema
    .extend({
      apiBaseUrl: trimmedString
        .min(1, t('missingApiBaseUrl'))
        .max(
          profileFieldLimits.apiBaseUrl,
          t('apiBaseUrlTooLong', String(profileFieldLimits.apiBaseUrl)),
        ),
      model: trimmedString
        .min(1, t('missingModel'))
        .max(profileFieldLimits.model, t('modelNameTooLong', String(profileFieldLimits.model))),
      apiKey: trimmedString
        .min(1, t('missingApiKey'))
        .max(profileFieldLimits.apiKey, t('apiKeyTooLong', String(profileFieldLimits.apiKey))),
    })
    .safeParse(profile)

  if (!result.success) {
    throw new Error(result.error.issues[0]?.message || t('settingsInvalid'))
  }

  return result.data as TranslationProfile
}

export function getActiveProfile(settings: TranslationSettings) {
  return (
    settings.profiles.find((profile) => profile.id === settings.activeProfileId) ||
    settings.profiles[0] ||
    defaultProfile
  )
}
