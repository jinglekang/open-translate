import { z } from 'zod'

const trimmedString = z.string().trim()

export const profileFieldLimits = {
  name: 60,
  apiBaseUrl: 500,
  model: 120,
  apiKey: 500,
  targetLanguage: 40,
  customPrompt: 4000,
} as const

export const translationDisplayModeSchema = z.enum(['translation', 'bilingual'])
export type TranslationDisplayMode = z.infer<typeof translationDisplayModeSchema>

export const translationProfileSchema = z.object({
  id: trimmedString.min(1),
  name: trimmedString
    .min(1, '请填写配置名称')
    .max(profileFieldLimits.name, `配置名称不能超过 ${profileFieldLimits.name} 个字符`)
    .catch('未命名配置'),
  apiBaseUrl: trimmedString
    .min(1, '请填写接口地址')
    .max(
      profileFieldLimits.apiBaseUrl,
      `接口地址不能超过 ${profileFieldLimits.apiBaseUrl} 个字符`,
    )
    .catch('https://api.openai.com/v1'),
  model: trimmedString
    .min(1, '请填写模型名称')
    .max(profileFieldLimits.model, `模型名称不能超过 ${profileFieldLimits.model} 个字符`)
    .catch('gpt-4o-mini'),
  apiKey: trimmedString
    .max(profileFieldLimits.apiKey, `API Key 不能超过 ${profileFieldLimits.apiKey} 个字符`)
    .catch(''),
  targetLanguage: trimmedString
    .min(1, '请填写目标语言')
    .max(
      profileFieldLimits.targetLanguage,
      `目标语言不能超过 ${profileFieldLimits.targetLanguage} 个字符`,
    )
    .catch('简体中文'),
  customPrompt: trimmedString
    .max(
      profileFieldLimits.customPrompt,
      `自定义系统提示词不能超过 ${profileFieldLimits.customPrompt} 个字符`,
    )
    .catch(''),
})

export const translationSettingsSchema = z
  .object({
    profiles: z.array(translationProfileSchema).min(1),
    activeProfileId: trimmedString.min(1),
    displayMode: translationDisplayModeSchema.catch('translation'),
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
    }
  })

export type TranslationProfile = z.infer<typeof translationProfileSchema>
export type TranslationSettings = z.infer<typeof translationSettingsSchema>

export const defaultProfile: TranslationProfile = {
  id: 'default',
  name: '默认 OpenAI',
  apiBaseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  targetLanguage: '简体中文',
  customPrompt: '',
}

export const defaultSettings: TranslationSettings = {
  profiles: [defaultProfile],
  activeProfileId: defaultProfile.id,
  displayMode: 'translation',
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
    name: '新的接口配置',
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
        targetLanguage: legacyResult.data.targetLanguage || defaultProfile.targetLanguage,
        customPrompt: legacyResult.data.customPrompt || defaultProfile.customPrompt,
      },
    ],
    activeProfileId: defaultProfile.id,
    displayMode: 'translation',
  })
}

export function sanitizeSettings(settings: TranslationSettings): TranslationSettings {
  const settingsResult = translationSettingsSchema.safeParse(settings)
  if (settingsResult.success) {
    return settingsResult.data
  }

  throw new Error(settingsResult.error.issues[0]?.message || '接口配置无效')
}

export function validateProfileForUse(profile: TranslationProfile) {
  const result = translationProfileSchema
    .extend({
      apiBaseUrl: trimmedString
        .min(1, '请先在选项页填写接口地址')
        .max(
          profileFieldLimits.apiBaseUrl,
          `接口地址不能超过 ${profileFieldLimits.apiBaseUrl} 个字符`,
        ),
      model: trimmedString
        .min(1, '请先在选项页填写模型名称')
        .max(profileFieldLimits.model, `模型名称不能超过 ${profileFieldLimits.model} 个字符`),
      apiKey: trimmedString
        .min(1, '请先在选项页填写 API Key')
        .max(profileFieldLimits.apiKey, `API Key 不能超过 ${profileFieldLimits.apiKey} 个字符`),
    })
    .safeParse(profile)

  if (!result.success) {
    throw new Error(result.error.issues[0]?.message || '接口配置无效')
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
