import enMessages from '../../public/_locales/en/messages.json'
import zhCnMessages from '../../public/_locales/zh_CN/messages.json'
import type { AppLanguage } from './settings'

type MessageEntry = {
  message: string
  placeholders?: Record<string, { content: string }>
}

const localeMessages: Record<Exclude<AppLanguage, 'system'>, Record<string, MessageEntry>> = {
  en: enMessages,
  zh_CN: zhCnMessages,
}

let appLanguage: AppLanguage = 'system'

export function setAppLanguage(language: AppLanguage) {
  appLanguage = language

  if (typeof document !== 'undefined') {
    document.documentElement.lang =
      language === 'system' ? chrome.i18n?.getMessage('@@ui_locale') || navigator.language : language
  }
}

export function t(messageName: string, substitutions?: string | string[]) {
  if (appLanguage !== 'system') {
    const entry = localeMessages[appLanguage][messageName]

    if (entry) {
      return formatMessage(entry, substitutions)
    }
  }

  const message = chrome.i18n?.getMessage(messageName, substitutions)
  return message || messageName
}

function formatMessage(entry: MessageEntry, substitutions?: string | string[]) {
  const values = Array.isArray(substitutions)
    ? substitutions
    : substitutions === undefined
      ? []
      : [substitutions]

  return Object.entries(entry.placeholders || {}).reduce((message, [name, placeholder]) => {
    const match = /^\$(\d+)$/.exec(placeholder.content)
    const value = match ? values[Number(match[1]) - 1] : undefined

    return value === undefined
      ? message
      : message.replaceAll(`$${name.toUpperCase()}$`, value)
  }, entry.message)
}
