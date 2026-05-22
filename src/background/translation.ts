import { t } from '../shared/i18n'
import type { TranslationProfile } from '../shared/settings'
import { translationCacheKeyPrefix } from '../shared/cache'
import { shouldSkipTranslation } from '../shared/whitelist'

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type ChatCompletionsPayload = {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
  message?: string
}

const BATCH_SEPARATOR = '<OPEN_TRANSLATE_SEGMENT_BREAK>'

export async function translateText(
  sourceText: string,
  profile: TranslationProfile,
  targetLanguage: string,
  userWhitelist: string[],
) {
  if (shouldSkipTranslation(sourceText, userWhitelist)) {
    return sourceText
  }

  const cachedTranslation = await getCachedTranslation(sourceText, profile, targetLanguage)
  if (cachedTranslation) {
    return cachedTranslation
  }

  const payload = await requestChatCompletions(profile, [
    { role: 'system', content: getSystemPrompt(profile, targetLanguage) },
    { role: 'user', content: sourceText },
  ])

  const translatedText = payload?.choices?.[0]?.message?.content?.trim()
  if (!translatedText) {
    throw new Error(t('emptyTranslationResponse'))
  }

  await cacheTranslation(sourceText, translatedText, profile, targetLanguage)
  return translatedText
}

export async function translateTextBatch(
  sourceTexts: string[],
  profile: TranslationProfile,
  targetLanguage: string,
  userWhitelist: string[],
) {
  if (sourceTexts.length === 1) {
    return [await translateText(sourceTexts[0], profile, targetLanguage, userWhitelist)]
  }

  return translateUncachedBatchWithFallback(sourceTexts, profile, targetLanguage, userWhitelist)
}

export async function getCachedTranslations(
  sourceTexts: string[],
  profile: TranslationProfile,
  targetLanguage: string,
) {
  try {
    const cacheKeys = await Promise.all(
      sourceTexts.map((sourceText) => createTranslationCacheKey(sourceText, profile, targetLanguage)),
    )
    const cachedItems = await chrome.storage.local.get(cacheKeys)

    return cacheKeys.map((cacheKey) => {
      const cachedValue = cachedItems[cacheKey]
      return typeof cachedValue === 'string' ? cachedValue : undefined
    })
  } catch (error) {
    console.warn('Open Translate cache read failed', error)
    return sourceTexts.map(() => undefined)
  }
}

async function translateUncachedBatchWithFallback(
  sourceTexts: string[],
  profile: TranslationProfile,
  targetLanguage: string,
  userWhitelist: string[],
) {
  try {
    const translatedTexts = await requestBatchTranslations(sourceTexts, profile, targetLanguage)
    await Promise.all(
      sourceTexts.map((sourceText, index) =>
        cacheTranslation(sourceText, translatedTexts[index], profile, targetLanguage),
      ),
    )
    return translatedTexts
  } catch {
    return Promise.all(
      sourceTexts.map((sourceText) =>
        translateText(sourceText, profile, targetLanguage, userWhitelist),
      ),
    )
  }
}

async function requestBatchTranslations(
  sourceTexts: string[],
  profile: TranslationProfile,
  targetLanguage: string,
) {
  const payload = await requestChatCompletions(profile, [
    { role: 'system', content: getBatchSystemPrompt(profile, targetLanguage) },
    { role: 'user', content: sourceTexts.join(`\n\n${BATCH_SEPARATOR}\n\n`) },
  ])
  const content = payload?.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new Error(t('emptyTranslationResponse'))
  }

  const translatedTexts = content
    .split(new RegExp(`\\s*${BATCH_SEPARATOR}\\s*`, 'g'))
    .map((translatedText) => translatedText.trim())

  if (
    translatedTexts.length !== sourceTexts.length ||
    translatedTexts.some((translatedText) => !translatedText)
  ) {
    throw new Error(t('emptyTranslationResponse'))
  }

  return translatedTexts
}

async function getCachedTranslation(
  sourceText: string,
  profile: TranslationProfile,
  targetLanguage: string,
) {
  try {
    const cacheKey = await createTranslationCacheKey(sourceText, profile, targetLanguage)
    const cachedItems = await chrome.storage.local.get(cacheKey)
    const cachedValue = cachedItems[cacheKey]

    return typeof cachedValue === 'string' ? cachedValue : undefined
  } catch (error) {
    console.warn('Open Translate cache read failed', error)
    return undefined
  }
}

async function cacheTranslation(
  sourceText: string,
  translatedText: string,
  profile: TranslationProfile,
  targetLanguage: string,
) {
  try {
    const cacheKey = await createTranslationCacheKey(sourceText, profile, targetLanguage)
    await chrome.storage.local.set({ [cacheKey]: translatedText })
  } catch (error) {
    console.warn('Open Translate cache write failed', error)
  }
}

async function createTranslationCacheKey(
  sourceText: string,
  profile: TranslationProfile,
  targetLanguage: string,
) {
  const cacheInput = JSON.stringify({
    version: 1,
    profile: {
      endpoint: getChatCompletionsEndpoint(profile.apiBaseUrl),
      model: profile.model,
      targetLanguage,
      customPrompt: profile.customPrompt,
    },
    sourceText,
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheInput))
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return `${translationCacheKeyPrefix}:${hash}`
}

async function requestChatCompletions(
  profile: TranslationProfile,
  messages: ChatMessage[],
): Promise<ChatCompletionsPayload> {
  const endpoint = getChatCompletionsEndpoint(profile.apiBaseUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model,
      messages,
      temperature: 0.2,
    }),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const detail =
      payload?.error?.message ||
      payload?.message ||
      `${response.status} ${response.statusText}`
    throw new Error(t('apiRequestFailed', detail))
  }

  return payload
}

function getSystemPrompt(profile: TranslationProfile, targetLanguage: string) {
  return (
    profile.customPrompt.trim() ||
    `You are a professional translation assistant. Translate the user's text into ${targetLanguage}. Preserve the original formatting, proper nouns, and code blocks. Output only the translation without explanations.`
  )
}

function getBatchSystemPrompt(profile: TranslationProfile, targetLanguage: string) {
  return `${getSystemPrompt(profile, targetLanguage)}

The user input contains multiple text segments separated by ${BATCH_SEPARATOR}.
Translate every segment independently and keep the segment order unchanged.
Return exactly the same number of translated segments.
Output only translated text and use ${BATCH_SEPARATOR} as the separator between translated segments.
Do not add, remove, translate, wrap, or explain the separator.`
}

function getChatCompletionsEndpoint(apiBaseUrl: string) {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) {
    return normalized
  }

  return `${normalized}/chat/completions`
}
