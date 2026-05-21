export function t(messageName: string, substitutions?: string | string[]) {
  const message = chrome.i18n?.getMessage(messageName, substitutions)
  return message || messageName
}
