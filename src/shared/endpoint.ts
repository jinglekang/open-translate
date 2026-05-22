import { t } from './i18n'

export function getEndpointPreview(apiBaseUrl: string) {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, '')
  if (!normalized) {
    return t('endpointUnset')
  }

  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}
