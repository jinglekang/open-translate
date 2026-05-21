import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getActiveProfile, normalizeSettings } from '../shared/settings'
import type { TranslationSettings } from '../shared/settings'
import './style.css'

export function Popup() {
  const [settings, setSettings] = useState<TranslationSettings | null>(null)
  const [status, setStatus] = useState('正在读取配置...')

  const activeProfile = useMemo(
    () => (settings ? getActiveProfile(settings) : null),
    [settings],
  )

  useEffect(() => {
    chrome.storage.sync.get(null).then((stored) => {
      const nextSettings = normalizeSettings(stored)
      setSettings(nextSettings)
      setStatus('选择当前翻译接口')
    })
  }, [])

  async function handleProfileChange(profileId: string) {
    if (!settings) {
      return
    }

    const nextSettings = { ...settings, activeProfileId: profileId }
    setSettings(nextSettings)
    await chrome.storage.sync.set({ activeProfileId: profileId })
    setStatus('已切换当前接口')
  }

  async function openOptionsPage() {
    await chrome.runtime.openOptionsPage()
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div>
          <p className="eyebrow">Open Translate</p>
          <h1>选择翻译接口</h1>
        </div>
        <span className="status-dot" aria-label="扩展已启用" />
      </header>

      {settings && (
        <section className="switcher">
          <label>
            <span>当前配置</span>
            <select
              value={settings.activeProfileId}
              onChange={(event) => handleProfileChange(event.target.value)}
            >
              {settings.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>

          <div className="profile-card">
            <strong>{activeProfile?.name}</strong>
            <span>{activeProfile?.model || '未设置模型'}</span>
            <code title={getEndpointPreview(activeProfile?.apiBaseUrl || '')}>
              {getEndpointPreview(activeProfile?.apiBaseUrl || '')}
            </code>
          </div>

          <button type="button" onClick={openOptionsPage}>
            管理接口配置
          </button>
        </section>
      )}

      <p className="status-message">{status}</p>
    </main>
  )
}

function getEndpointPreview(apiBaseUrl: string) {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, '')
  if (!normalized) {
    return '未设置接口地址'
  }

  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
)
