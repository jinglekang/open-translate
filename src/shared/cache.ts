export const translationCacheKeyPrefix = 'open-translate-cache'
export const translationCacheIndexKey = `${translationCacheKeyPrefix}-index`
export const staleTranslationCacheDays = 30
export const maxTranslationCacheEntries = 10_000
export const cacheAccessRefreshIntervalMinutes = 1

export type TranslationCacheStats = {
  count: number
  metadataCount: number
  legacyCount: number
  approximateSize: number
  oldestAccessedAt?: number
  newestAccessedAt?: number
}

type TranslationCacheEntry = {
  translatedText: string
  createdAt?: number
  lastAccessedAt?: number
  size?: number
}

export async function getTranslationCacheStats() {
  const items = await chrome.storage.local.get(null)
  const keys = Object.keys(items).filter(isTranslationCacheKey)
  const stats: TranslationCacheStats = {
    count: keys.length,
    metadataCount: 0,
    legacyCount: 0,
    approximateSize: 0,
  }

  for (const key of keys) {
    const value = items[key]
    if (typeof value === 'string') {
      stats.legacyCount += 1
      stats.approximateSize += value.length
      continue
    }

    if (!isTranslationCacheEntry(value)) {
      continue
    }

    stats.metadataCount += 1
    stats.approximateSize += value.size ?? value.translatedText.length

    const accessedAt = value.lastAccessedAt ?? value.createdAt
    if (typeof accessedAt !== 'number') {
      continue
    }

    stats.oldestAccessedAt =
      stats.oldestAccessedAt === undefined
        ? accessedAt
        : Math.min(stats.oldestAccessedAt, accessedAt)
    stats.newestAccessedAt =
      stats.newestAccessedAt === undefined
        ? accessedAt
        : Math.max(stats.newestAccessedAt, accessedAt)
  }

  return stats
}

export async function clearTranslationCache() {
  const items = await chrome.storage.local.get(null)
  const keys = Object.keys(items).filter(isTranslationCacheKey)
  await chrome.storage.local.remove([...keys, translationCacheIndexKey])

  return keys.length
}

export async function deleteStaleTranslationCache(days = staleTranslationCacheDays) {
  const items = await chrome.storage.local.get(null)
  const keys = Object.keys(items).filter(isTranslationCacheKey)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const keysToRemove = keys.filter((key) => {
    const value = items[key]
    if (!isTranslationCacheEntry(value)) {
      return false
    }

    const accessedAt = value.lastAccessedAt ?? value.createdAt
    return typeof accessedAt === 'number' && accessedAt < cutoff
  })

  if (keysToRemove.length) {
    await chrome.storage.local.remove(keysToRemove)
  }

  await removeKeysFromCacheIndex(keysToRemove)
  return keysToRemove.length
}

function isTranslationCacheKey(key: string) {
  return key.startsWith(`${translationCacheKeyPrefix}:`)
}

function isTranslationCacheEntry(value: unknown): value is TranslationCacheEntry {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as TranslationCacheEntry).translatedText === 'string'
  )
}

async function removeKeysFromCacheIndex(keys: string[]) {
  if (!keys.length) {
    return
  }

  const stored = await chrome.storage.local.get(translationCacheIndexKey)
  const index = stored[translationCacheIndexKey]
  if (!index || typeof index !== 'object' || !Array.isArray((index as { keys?: unknown }).keys)) {
    return
  }

  const removedKeys = new Set(keys)
  await chrome.storage.local.set({
    [translationCacheIndexKey]: {
      keys: (index as { keys: unknown[] }).keys.filter(
        (key): key is string => typeof key === 'string' && !removedKeys.has(key),
      ),
    },
  })
}
