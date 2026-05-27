import { t } from '../shared/i18n'
import type { TranslationMode, TranslationProfile } from '../shared/settings'
import {
  cacheAccessRefreshIntervalMinutes,
  maxTranslationCacheEntries,
  translationCacheIndexKey,
  translationCacheKeyPrefix,
} from '../shared/cache'
import { getTranslationSystemPrompt } from '../shared/prompt'
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
const CONTEXT_TAG_PATTERN = /<OPEN_TRANSLATE_CONTEXT>[\s\S]*?<\/OPEN_TRANSLATE_CONTEXT>/gi
const CONTEXT_TEXT_PATTERN =
  /<OPEN_TRANSLATE_TEXT>([\s\S]*?)<\/OPEN_TRANSLATE_TEXT>/i
const CONTEXT_WRAPPER_PATTERN = /<\/?OPEN_TRANSLATE_(?:CONTEXT|TEXT)>/gi
const cacheAccessRefreshInterval = cacheAccessRefreshIntervalMinutes * 60 * 1000

type TranslationCacheEntry = {
  translatedText: string
  createdAt: number
  lastAccessedAt: number
  size: number
}

type TranslationCacheIndex = {
  keys: string[]
}

export async function translateText(
  sourceText: string,
  profile: TranslationProfile,
  targetLanguage: string,
  userWhitelist: string[],
  minTranslationTextLength: number,
  translationMode: TranslationMode = 'text-node',
) {
  if (shouldSkipTranslation(sourceText, userWhitelist, minTranslationTextLength)) {
    return sourceText
  }

  const cachedTranslation = await getCachedTranslation(
    sourceText,
    profile,
    targetLanguage,
    translationMode,
  )
  if (cachedTranslation) {
    return normalizeTranslationOutput(sourceText, cachedTranslation)
  }

  const payload = await requestChatCompletions(profile, [
    { role: 'system', content: getSystemPrompt(profile, targetLanguage, translationMode) },
    { role: 'user', content: sourceText },
  ])

  const translatedText = normalizeTranslationOutput(
    sourceText,
    payload?.choices?.[0]?.message?.content?.trim() || '',
  )
  if (!translatedText) {
    throw new Error(t('emptyTranslationResponse'))
  }

  await cacheTranslation(sourceText, translatedText, profile, targetLanguage, translationMode)
  return translatedText
}

export async function translateTextBatch(
  sourceTexts: string[],
  profile: TranslationProfile,
  targetLanguage: string,
  userWhitelist: string[],
  minTranslationTextLength: number,
  translationMode: TranslationMode = 'text-node',
) {
  if (sourceTexts.length === 1) {
    return [await translateText(
      sourceTexts[0],
      profile,
      targetLanguage,
      userWhitelist,
      minTranslationTextLength,
      translationMode,
    )]
  }

  return translateUncachedBatchWithFallback(
    sourceTexts,
    profile,
    targetLanguage,
    userWhitelist,
    minTranslationTextLength,
    translationMode,
  )
}

export async function getCachedTranslations(
  sourceTexts: string[],
  profile: TranslationProfile,
  targetLanguage: string,
  translationMode: TranslationMode = 'text-node',
) {
  try {
    const cacheKeys = await Promise.all(
      sourceTexts.map((sourceText) =>
        createTranslationCacheKey(sourceText, profile, targetLanguage, translationMode),
      ),
    )
    const cachedItems = await chrome.storage.local.get(cacheKeys)
    const now = Date.now()
    const updates: Record<string, TranslationCacheEntry> = {}
    const hitKeys: string[] = []

    const translations = cacheKeys.map((cacheKey, index) => {
      const cachedValue = cachedItems[cacheKey]
      const translatedText = readCachedTranslationValue(cachedValue)
      if (!translatedText) {
        return undefined
      }

      hitKeys.push(cacheKey)
      if (shouldRefreshCacheAccess(cachedValue, now)) {
        updates[cacheKey] = createCacheEntry(
          normalizeTranslationOutput(sourceTexts[index], translatedText),
          now,
          getCacheEntryCreatedAt(cachedValue, now),
        )
      }

      return normalizeTranslationOutput(sourceTexts[index], translatedText)
    })

    await persistCacheAccessUpdates(updates, hitKeys)
    return translations
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
  minTranslationTextLength: number,
  translationMode: TranslationMode,
) {
  try {
    const translatedTexts = await requestBatchTranslations(
      sourceTexts,
      profile,
      targetLanguage,
      translationMode,
    )
    await Promise.all(
      sourceTexts.map((sourceText, index) =>
        cacheTranslation(
          sourceText,
          normalizeTranslationOutput(sourceText, translatedTexts[index]),
          profile,
          targetLanguage,
          translationMode,
        ),
      ),
    )
    return sourceTexts.map((sourceText, index) =>
      normalizeTranslationOutput(sourceText, translatedTexts[index]),
    )
  } catch {
    return Promise.all(
      sourceTexts.map((sourceText) =>
        translateText(
          sourceText,
          profile,
          targetLanguage,
          userWhitelist,
          minTranslationTextLength,
          translationMode,
        ),
      ),
    )
  }
}

async function requestBatchTranslations(
  sourceTexts: string[],
  profile: TranslationProfile,
  targetLanguage: string,
  translationMode: TranslationMode,
) {
  const payload = await requestChatCompletions(profile, [
    {
      role: 'system',
      content: getBatchSystemPrompt(profile, targetLanguage, translationMode),
    },
    { role: 'user', content: sourceTexts.join(`\n\n${BATCH_SEPARATOR}\n\n`) },
  ])
  const content = payload?.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new Error(t('emptyTranslationResponse'))
  }

  const translatedTexts = content
    .split(new RegExp(`\\s*${BATCH_SEPARATOR}\\s*`, 'g'))
    .map((translatedText, index) =>
      normalizeTranslationOutput(sourceTexts[index] || '', translatedText.trim()),
    )

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
  translationMode: TranslationMode = 'text-node',
) {
  try {
    const cacheKey = await createTranslationCacheKey(
      sourceText,
      profile,
      targetLanguage,
      translationMode,
    )
    const cachedItems = await chrome.storage.local.get(cacheKey)
    const cachedValue = cachedItems[cacheKey]
    const translatedText = readCachedTranslationValue(cachedValue)
    if (!translatedText) {
      return undefined
    }

    const normalizedText = normalizeTranslationOutput(sourceText, translatedText)
    const now = Date.now()
    if (shouldRefreshCacheAccess(cachedValue, now)) {
      await persistCacheAccessUpdates(
        {
          [cacheKey]: createCacheEntry(
            normalizedText,
            now,
            getCacheEntryCreatedAt(cachedValue, now),
          ),
        },
        [cacheKey],
      )
    }

    return normalizedText
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
  translationMode: TranslationMode,
) {
  try {
    const cacheKey = await createTranslationCacheKey(
      sourceText,
      profile,
      targetLanguage,
      translationMode,
    )
    await chrome.storage.local.set({
      [cacheKey]: createCacheEntry(translatedText, Date.now()),
    })
    await addTranslationCacheKeys([cacheKey])
    await pruneTranslationCache()
  } catch (error) {
    console.warn('Open Translate cache write failed', error)
  }
}

function readCachedTranslationValue(value: unknown) {
  if (typeof value === 'string') {
    return value
  }

  if (
    value &&
    typeof value === 'object' &&
    typeof (value as TranslationCacheEntry).translatedText === 'string'
  ) {
    return (value as TranslationCacheEntry).translatedText
  }

  return undefined
}

function shouldRefreshCacheAccess(value: unknown, now: number) {
  if (typeof value === 'string') {
    return true
  }

  return (
    value &&
    typeof value === 'object' &&
    (
      typeof (value as TranslationCacheEntry).lastAccessedAt !== 'number' ||
      now - (value as TranslationCacheEntry).lastAccessedAt > cacheAccessRefreshInterval
    )
  )
}

function getCacheEntryCreatedAt(value: unknown, fallback: number) {
  return (
    value &&
    typeof value === 'object' &&
    typeof (value as TranslationCacheEntry).createdAt === 'number'
  )
    ? (value as TranslationCacheEntry).createdAt
    : fallback
}

function createCacheEntry(
  translatedText: string,
  lastAccessedAt: number,
  createdAt = lastAccessedAt,
): TranslationCacheEntry {
  return {
    translatedText,
    createdAt,
    lastAccessedAt,
    size: translatedText.length,
  }
}

async function persistCacheAccessUpdates(
  updates: Record<string, TranslationCacheEntry>,
  hitKeys: string[],
) {
  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates)
  }

  if (hitKeys.length) {
    await addTranslationCacheKeys(hitKeys)
  }
}

async function addTranslationCacheKeys(keys: string[]) {
  const index = await getTranslationCacheIndex()
  const existingKeys = new Set(index.keys)
  let didChange = false

  for (const key of keys) {
    if (!existingKeys.has(key)) {
      existingKeys.add(key)
      didChange = true
    }
  }

  if (didChange) {
    await setTranslationCacheIndex([...existingKeys])
  }
}

async function pruneTranslationCache() {
  const index = await getTranslationCacheIndex()
  if (index.keys.length <= maxTranslationCacheEntries) {
    return
  }

  const cachedItems = await chrome.storage.local.get(index.keys)
  const entries = index.keys
    .map((key) => ({
      key,
      value: cachedItems[key],
      lastAccessedAt: getCacheEntryLastAccessedAt(cachedItems[key]),
    }))
    .filter((entry) => entry.lastAccessedAt !== undefined)
    .sort((a, b) => a.lastAccessedAt! - b.lastAccessedAt!)

  const staleKeys = index.keys.filter((key) => !readCachedTranslationValue(cachedItems[key]))
  const overflowCount = Math.max(0, entries.length - maxTranslationCacheEntries)
  const lruKeys = entries.slice(0, overflowCount).map((entry) => entry.key)
  const keysToRemove = [...new Set([...staleKeys, ...lruKeys])]
  if (!keysToRemove.length) {
    return
  }

  await chrome.storage.local.remove(keysToRemove)
  const removedKeys = new Set(keysToRemove)
  await setTranslationCacheIndex(index.keys.filter((key) => !removedKeys.has(key)))
}

function getCacheEntryLastAccessedAt(value: unknown) {
  if (typeof value === 'string') {
    return 0
  }

  return (
    value &&
    typeof value === 'object' &&
    typeof (value as TranslationCacheEntry).lastAccessedAt === 'number'
  )
    ? (value as TranslationCacheEntry).lastAccessedAt
    : undefined
}

async function getTranslationCacheIndex(): Promise<TranslationCacheIndex> {
  const stored = await chrome.storage.local.get(translationCacheIndexKey)
  const index = stored[translationCacheIndexKey]
  if (!index || typeof index !== 'object' || !Array.isArray((index as TranslationCacheIndex).keys)) {
    return { keys: [] }
  }

  return {
    keys: (index as TranslationCacheIndex).keys.filter(
      (key): key is string =>
        typeof key === 'string' &&
        key.startsWith(`${translationCacheKeyPrefix}:`),
    ),
  }
}

async function setTranslationCacheIndex(keys: string[]) {
  await chrome.storage.local.set({
    [translationCacheIndexKey]: {
      keys,
    } satisfies TranslationCacheIndex,
  })
}

async function createTranslationCacheKey(
  sourceText: string,
  profile: TranslationProfile,
  targetLanguage: string,
  translationMode: TranslationMode,
) {
  const cacheInput = JSON.stringify({
    profile: {
      endpoint: getChatCompletionsEndpoint(profile.apiBaseUrl),
      model: profile.model,
      targetLanguage,
      customPrompt: profile.customPrompt,
      translationMode,
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

function normalizeTranslationOutput(sourceText: string, translatedText: string) {
  if (!hasContextWrapper(sourceText)) {
    return translatedText.trim()
  }

  const textMatch = translatedText.match(CONTEXT_TEXT_PATTERN)
  if (textMatch?.[1]) {
    return textMatch[1].trim()
  }

  return translatedText
    .replace(CONTEXT_TAG_PATTERN, '')
    .replace(CONTEXT_WRAPPER_PATTERN, '')
    .trim()
}

function hasContextWrapper(sourceText: string) {
  return /<OPEN_TRANSLATE_CONTEXT>/i.test(sourceText)
}

function getSystemPrompt(
  profile: TranslationProfile,
  targetLanguage: string,
  translationMode: TranslationMode,
) {
  return getTranslationSystemPrompt(profile.customPrompt, targetLanguage, translationMode)
}

function getBatchSystemPrompt(
  profile: TranslationProfile,
  targetLanguage: string,
  translationMode: TranslationMode,
) {
  return `${getSystemPrompt(profile, targetLanguage, translationMode)}

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
