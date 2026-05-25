import { z } from 'zod'
import { t } from './i18n'
import { defaultTargetLanguage, targetLanguageValues } from './languages'

const trimmedString = z.string().trim()

export const profileFieldLimits = {
  name: 60,
  apiBaseUrl: 500,
  model: 120,
  apiKey: 500,
  customPrompt: 4000,
  userWhitelistItem: 160,
  userWhitelistItems: 200,
  noTranslateSelectorItem: 200,
  noTranslateSelectors: 100,
} as const
export const minTranslationTextLengthLimits = {
  min: 1,
  default: 2,
  max: 100,
} as const
export const translationConcurrencyLimits = {
  min: 1,
  default: 4,
  max: 8,
} as const
export const translationBatchSegmentLimits = {
  min: 1,
  default: 4,
  max: 8,
} as const
export const translationBatchTextLengthLimits = {
  min: 1,
  default: 1200,
  max: 4000,
} as const

export const translationDisplayModeSchema = z.enum(['translation', 'bilingual'])
export type TranslationDisplayMode = z.infer<typeof translationDisplayModeSchema>
export const targetLanguageSchema = z.enum(targetLanguageValues)
export const translationScopeSchema = z.enum(['visible-page', 'viewport'])
export type TranslationScope = z.infer<typeof translationScopeSchema>
export const translationModeSchema = z.enum(['text-node', 'element-context'])
export type TranslationMode = z.infer<typeof translationModeSchema>
export const translationProviderSchema = z.enum(['chrome-built-in', 'openai-compatible'])
export type TranslationProvider = z.infer<typeof translationProviderSchema>

export const defaultUserWhitelist = [
  'OpenAI',
  'ChatGPT',
  'GitHub',
  'GPT',
  'API',
  'JSON',
  'JavaScript',
  'TypeScript',
  'HTML',
  'CSS',
] as const

export const defaultNoTranslateSelectors = [
  'pre',
  'code',
  '[contenteditable="true"]',
] as const

export const translationProfileSchema = z.object({
  id: trimmedString.min(1),
  provider: translationProviderSchema.catch('chrome-built-in'),
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
  translationBatchSegments: z.coerce
    .number()
    .int(t('translationBatchSegmentsInvalid'))
    .min(translationBatchSegmentLimits.min, t('translationBatchSegmentsInvalid'))
    .max(translationBatchSegmentLimits.max, t('translationBatchSegmentsInvalid'))
    .catch(translationBatchSegmentLimits.default),
  translationBatchTextLength: z.coerce
    .number()
    .int(t('translationBatchTextLengthInvalid'))
    .min(translationBatchTextLengthLimits.min, t('translationBatchTextLengthInvalid'))
    .max(translationBatchTextLengthLimits.max, t('translationBatchTextLengthInvalid'))
    .catch(translationBatchTextLengthLimits.default),
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
    translationScope: translationScopeSchema.catch('viewport'),
    translationMode: translationModeSchema.catch('element-context'),
    targetLanguage: targetLanguageSchema.catch(defaultTargetLanguage),
    userWhitelist: z
      .array(
        trimmedString
          .min(1)
          .max(profileFieldLimits.userWhitelistItem, t('userWhitelistItemTooLong')),
      )
      .max(profileFieldLimits.userWhitelistItems, t('userWhitelistTooMany'))
      .catch([...defaultUserWhitelist]),
    noTranslateSelectors: z
      .array(
        trimmedString
          .min(1)
          .max(profileFieldLimits.noTranslateSelectorItem, t('noTranslateSelectorTooLong')),
      )
      .max(profileFieldLimits.noTranslateSelectors, t('noTranslateSelectorsTooMany'))
      .catch([...defaultNoTranslateSelectors]),
    minTranslationTextLength: z.coerce
      .number()
      .int(t('minTranslationTextLengthInvalid'))
      .min(minTranslationTextLengthLimits.min, t('minTranslationTextLengthInvalid'))
      .max(minTranslationTextLengthLimits.max, t('minTranslationTextLengthInvalid'))
      .catch(minTranslationTextLengthLimits.default),
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
      translationScope: settings.translationScope,
      translationMode: settings.translationMode,
      targetLanguage: settings.targetLanguage,
      userWhitelist: [...new Set(settings.userWhitelist)],
      noTranslateSelectors: [...new Set(settings.noTranslateSelectors)],
      minTranslationTextLength: settings.minTranslationTextLength,
    }
  })

export type TranslationProfile = z.infer<typeof translationProfileSchema>
export type TranslationSettings = z.infer<typeof translationSettingsSchema>

export const defaultProfile: TranslationProfile = {
  id: 'default',
  provider: 'chrome-built-in',
  name: t('defaultProfileName'),
  apiBaseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  translationConcurrency: translationConcurrencyLimits.default,
  translationBatchSegments: translationBatchSegmentLimits.default,
  translationBatchTextLength: translationBatchTextLengthLimits.default,
  customPrompt: '',
}

export const defaultSettings: TranslationSettings = {
  profiles: [defaultProfile],
  activeProfileId: defaultProfile.id,
  displayMode: 'bilingual',
  translationScope: 'viewport',
  translationMode: 'element-context',
  targetLanguage: defaultTargetLanguage,
  userWhitelist: [...defaultUserWhitelist],
  noTranslateSelectors: [...defaultNoTranslateSelectors],
  minTranslationTextLength: minTranslationTextLengthLimits.default,
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
    translationScope: 'viewport',
    translationMode: defaultSettings.translationMode,
    targetLanguage: legacyResult.data.targetLanguage || defaultSettings.targetLanguage,
    userWhitelist: [...defaultSettings.userWhitelist],
    noTranslateSelectors: [...defaultSettings.noTranslateSelectors],
    minTranslationTextLength: defaultSettings.minTranslationTextLength,
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
  if (profile.provider === 'chrome-built-in') {
    const result = translationProfileSchema.safeParse(profile)
    if (!result.success) {
      throw new Error(result.error.issues[0]?.message || t('settingsInvalid'))
    }

    return result.data as TranslationProfile
  }

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
