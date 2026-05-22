export const translationCacheKeyPrefix = 'open-translate-cache'

export async function getTranslationCacheStats() {
  const items = await chrome.storage.local.get(null)
  const keys = Object.keys(items).filter(isTranslationCacheKey)

  return {
    count: keys.length,
  }
}

export async function clearTranslationCache() {
  const items = await chrome.storage.local.get(null)
  const keys = Object.keys(items).filter(isTranslationCacheKey)
  if (keys.length) {
    await chrome.storage.local.remove(keys)
  }

  return keys.length
}

function isTranslationCacheKey(key: string) {
  return key.startsWith(`${translationCacheKeyPrefix}:`)
}
