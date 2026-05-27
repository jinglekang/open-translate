import type { TranslationMode } from './settings'

export const targetLanguagePromptTag = '{{targetLanguage}}'

const defaultBaseTranslationPrompt = `You are a professional translation assistant. Translate the user's text into ${targetLanguagePromptTag}. Preserve the original formatting, proper nouns, and code blocks. Output only the translation without explanations.`

const elementContextPromptRules = `The input may contain protected inline placeholders in the exact form __OPEN_TRANSLATE_KEEP_0__, __OPEN_TRANSLATE_KEEP_1__, etc.
These placeholders represent inline HTML fragments such as code, links, or no-translate nodes.
Rules for protected placeholders:
1. Keep every placeholder exactly unchanged, including uppercase letters and underscores.
2. Do not translate, lowercase, split, wrap, or explain placeholders.
3. Preserve the same number of placeholders in the output.
4. Move placeholders only when needed for natural word order in ${targetLanguagePromptTag}.
5. Output only the translated text with the placeholders kept in place.

Some page text may be wrapped as:
<OPEN_TRANSLATE_CONTEXT>
surrounding text for meaning only
</OPEN_TRANSLATE_CONTEXT>
<OPEN_TRANSLATE_TEXT>
text to translate
</OPEN_TRANSLATE_TEXT>
When this wrapper is present, use the context only to understand meaning and translate only the text inside OPEN_TRANSLATE_TEXT. Do not output the context or wrapper tags.`

export function getDefaultBaseTranslationPromptTemplate() {
  return defaultBaseTranslationPrompt
}

export function getDefaultTranslationPromptTemplate(translationMode: TranslationMode) {
  return appendTranslationModePromptRules(defaultBaseTranslationPrompt, translationMode)
}

export function getTranslationSystemPrompt(
  customPrompt: string,
  targetLanguage: string,
  translationMode: TranslationMode,
) {
  const promptTemplate =
    customPrompt.trim() ||
    getDefaultTranslationPromptTemplate(translationMode)

  return renderTranslationPrompt(
    appendTranslationModePromptRules(promptTemplate, translationMode),
    targetLanguage,
  )
}

function appendTranslationModePromptRules(prompt: string, translationMode: TranslationMode) {
  if (translationMode !== 'element-context' || hasElementContextPromptRules(prompt)) {
    return prompt
  }

  return `${prompt}

${elementContextPromptRules}`
}

function hasElementContextPromptRules(prompt: string) {
  return (
    prompt.includes('__OPEN_TRANSLATE_KEEP_') ||
    prompt.includes('<OPEN_TRANSLATE_CONTEXT>') ||
    prompt.includes('<OPEN_TRANSLATE_TEXT>')
  )
}

function renderTranslationPrompt(prompt: string, targetLanguage: string) {
  return prompt.replaceAll(targetLanguagePromptTag, targetLanguage)
}
