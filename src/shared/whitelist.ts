export const builtInNoTranslateRules = [
  'emptyText',
  'numbersAndSymbols',
  'emojiOnly',
  'urlOrEmail',
] as const

export function shouldSkipTranslation(sourceText: string, userWhitelist: string[]) {
  const normalizedText = sourceText.trim()
  if (!normalizedText || isBuiltInNoTranslateText(normalizedText)) {
    return true
  }

  return createUserWhitelistSet(userWhitelist).has(normalizedText)
}

export function createUserWhitelistSet(userWhitelist: string[]) {
  return new Set(userWhitelist.map((item) => item.trim()).filter(Boolean))
}

function isBuiltInNoTranslateText(text: string) {
  return (
    !hasLanguageLetter(text) ||
    isStandaloneUrl(text) ||
    isStandaloneEmail(text)
  )
}

function hasLanguageLetter(text: string) {
  return /\p{L}/u.test(text)
}

function isStandaloneUrl(text: string) {
  return /^(?:https?:\/\/|www\.)\S+$/iu.test(text)
}

function isStandaloneEmail(text: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)
}
