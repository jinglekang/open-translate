const builtInLanguageAliases = new Map<string, string>([
  ['简体中文', 'zh'],
  ['中文', 'zh'],
  ['中国语', 'zh'],
  ['繁体中文', 'zh-Hant'],
  ['英文', 'en'],
  ['英语', 'en'],
  ['日文', 'ja'],
  ['日语', 'ja'],
  ['韩文', 'ko'],
  ['韩语', 'ko'],
  ['法文', 'fr'],
  ['法语', 'fr'],
  ['德文', 'de'],
  ['德语', 'de'],
  ['西班牙文', 'es'],
  ['西班牙语', 'es'],
  ['俄文', 'ru'],
  ['俄语', 'ru'],
  ['葡萄牙文', 'pt'],
  ['葡萄牙语', 'pt'],
  ['意大利文', 'it'],
  ['意大利语', 'it'],
  ['simplified chinese', 'zh'],
  ['chinese', 'zh'],
  ['traditional chinese', 'zh-Hant'],
  ['english', 'en'],
  ['japanese', 'ja'],
  ['korean', 'ko'],
  ['french', 'fr'],
  ['german', 'de'],
  ['spanish', 'es'],
  ['russian', 'ru'],
  ['portuguese', 'pt'],
  ['italian', 'it'],
])

export function normalizeBuiltInTargetLanguageCode(targetLanguage: string) {
  const normalized = targetLanguage.trim()
  const alias = builtInLanguageAliases.get(normalized.toLowerCase()) ||
    builtInLanguageAliases.get(normalized)

  if (alias) {
    return alias
  }

  return normalized || 'zh'
}
