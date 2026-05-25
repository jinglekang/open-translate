export type TargetLanguageOption = {
  value: string
  builtInCode: string
}

export const targetLanguageOptions = [
  {
    value: '简体中文',
    builtInCode: 'zh',
  },
  {
    value: '繁體中文',
    builtInCode: 'zh-Hant',
  },
  {
    value: 'English',
    builtInCode: 'en',
  },
  {
    value: '日本語',
    builtInCode: 'ja',
  },
  {
    value: '한국어',
    builtInCode: 'ko',
  },
  {
    value: 'Français',
    builtInCode: 'fr',
  },
  {
    value: 'Deutsch',
    builtInCode: 'de',
  },
  {
    value: 'Español',
    builtInCode: 'es',
  },
  {
    value: 'Русский',
    builtInCode: 'ru',
  },
  {
    value: 'Português',
    builtInCode: 'pt',
  },
  {
    value: 'Italiano',
    builtInCode: 'it',
  },
] as const satisfies readonly TargetLanguageOption[]

export const targetLanguageValues = targetLanguageOptions.map((option) => option.value) as [
  string,
  ...string[],
]
export const defaultTargetLanguage = targetLanguageOptions[0].value

const builtInLanguageCodes = new Map<string, string>(
  targetLanguageOptions.map((option) => [option.value, option.builtInCode]),
)

export function normalizeBuiltInTargetLanguageCode(targetLanguage: string) {
  return builtInLanguageCodes.get(targetLanguage) || 'zh'
}
