export const translationCacheKeyPrefix = 'open-translate-cache'
export const translationCacheIndexKey = `${translationCacheKeyPrefix}-index`
export const staleTranslationCacheDays = 30
export const cacheAccessRefreshIntervalMinutes = 1

export type TranslationCacheStats = {
  count: number
  approximateSize: number
  oldestAccessedAt?: number
  newestAccessedAt?: number
}

type TranslationCacheEntry = {
  translatedText: string
  createdAt: number
  lastAccessedAt: number
  size: number
}

export async function getTranslationCacheStats() {
  const items = await chrome.storage.local.get(null)
  const stats: TranslationCacheStats = {
    count: 0,
    approximateSize: 0,
  }

  for (const key of Object.keys(items).filter(isTranslationCacheKey)) {
    const value = items[key]
    if (!isTranslationCacheEntry(value)) {
      continue
    }

    stats.count += 1
    stats.approximateSize += value.size

    stats.oldestAccessedAt =
      stats.oldestAccessedAt === undefined
        ? value.lastAccessedAt
        : Math.min(stats.oldestAccessedAt, value.lastAccessedAt)
    stats.newestAccessedAt =
      stats.newestAccessedAt === undefined
        ? value.lastAccessedAt
        : Math.max(stats.newestAccessedAt, value.lastAccessedAt)
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

    return value.lastAccessedAt < cutoff
  })

  if (keysToRemove.length) {
    await chrome.storage.local.remove(keysToRemove)
  }

  await removeKeysFromCacheIndex(keysToRemove)
  return keysToRemove.length
}

export async function pruneTranslationCache(maxEntries: number) {
  const stored = await chrome.storage.local.get(translationCacheIndexKey)
  const index = stored[translationCacheIndexKey]
  if (!index || typeof index !== 'object' || !Array.isArray((index as { keys?: unknown }).keys)) {
    return 0
  }

  const keys = (index as { keys: unknown[] }).keys.filter(
    (key): key is string => typeof key === 'string' && isTranslationCacheKey(key),
  )
  const normalizedMaxEntries = Math.max(1, Math.floor(maxEntries))
  if (keys.length <= normalizedMaxEntries) {
    return 0
  }

  const cachedItems = await chrome.storage.local.get(keys)
  const entries = keys
    .map((key) => ({
      key,
      value: cachedItems[key],
      lastAccessedAt: getTranslationCacheLastAccessedAt(cachedItems[key]),
    }))
    .filter((entry) => entry.lastAccessedAt !== undefined)
    .sort((a, b) => a.lastAccessedAt! - b.lastAccessedAt!)

  const invalidKeys = keys.filter((key) => !isTranslationCacheEntry(cachedItems[key]))
  const overflowCount = Math.max(0, entries.length - normalizedMaxEntries)
  const lruKeys = entries.slice(0, overflowCount).map((entry) => entry.key)
  const keysToRemove = [...new Set([...invalidKeys, ...lruKeys])]
  if (!keysToRemove.length) {
    return 0
  }

  await chrome.storage.local.remove(keysToRemove)
  const removedKeys = new Set(keysToRemove)
  await chrome.storage.local.set({
    [translationCacheIndexKey]: {
      keys: keys.filter((key) => !removedKeys.has(key)),
    },
  })

  return keysToRemove.length
}

function isTranslationCacheKey(key: string) {
  return key.startsWith(`${translationCacheKeyPrefix}:`)
}

function isTranslationCacheEntry(value: unknown): value is TranslationCacheEntry {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as TranslationCacheEntry).translatedText === 'string' &&
    typeof (value as TranslationCacheEntry).createdAt === 'number' &&
    typeof (value as TranslationCacheEntry).lastAccessedAt === 'number' &&
    typeof (value as TranslationCacheEntry).size === 'number'
  )
}

function getTranslationCacheLastAccessedAt(value: unknown) {
  return isTranslationCacheEntry(value) ? value.lastAccessedAt : undefined
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
