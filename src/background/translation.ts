import { t } from '../shared/i18n'
import type { TranslationProfile } from '../shared/settings'

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

const CACHE_KEY_PREFIX = 'open-translate-cache'

export async function translateText(
  sourceText: string,
  profile: TranslationProfile,
  targetLanguage: string,
) {
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

async function getCachedTranslation(
  sourceText: string,
  profile: TranslationProfile,
  targetLanguage: string,
) {
  const cacheKey = await createTranslationCacheKey(sourceText, profile, targetLanguage)
  const cachedItems = await chrome.storage.local.get(cacheKey)
  const cachedValue = cachedItems[cacheKey]

  return typeof cachedValue === 'string' ? cachedValue : undefined
}

async function cacheTranslation(
  sourceText: string,
  translatedText: string,
  profile: TranslationProfile,
  targetLanguage: string,
) {
  const cacheKey = await createTranslationCacheKey(sourceText, profile, targetLanguage)
  await chrome.storage.local.set({ [cacheKey]: translatedText })
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

  return `${CACHE_KEY_PREFIX}:${hash}`
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

function getChatCompletionsEndpoint(apiBaseUrl: string) {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) {
    return normalized
  }

  return `${normalized}/chat/completions`
}
