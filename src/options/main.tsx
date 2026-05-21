import { StrictMode, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createProfile,
  defaultSettings,
  getActiveProfile,
  normalizeSettings,
  profileFieldLimits,
  sanitizeSettings,
} from '../shared/settings'
import type { TranslationProfile, TranslationSettings } from '../shared/settings'
import './style.css'

export function Options() {
  const [settings, setSettings] = useState<TranslationSettings>(defaultSettings)
  const [editingId, setEditingId] = useState(defaultSettings.activeProfileId)
  const [status, setStatus] = useState('正在读取配置...')

  const editingProfile = useMemo(
    () =>
      settings.profiles.find((profile) => profile.id === editingId) ||
      getActiveProfile(settings),
    [editingId, settings],
  )

  useEffect(() => {
    chrome.storage.sync.get(null).then((stored) => {
      const nextSettings = normalizeSettings(stored)
      setSettings(nextSettings)
      setEditingId(nextSettings.activeProfileId)
      setStatus('配置会自动同步到当前浏览器账号')
    })
  }, [])

  async function saveSettings(
    nextSettings: TranslationSettings,
    message: string,
    nextEditingId = editingId,
  ) {
    let sanitizedSettings: TranslationSettings
    try {
      sanitizedSettings = sanitizeSettings(nextSettings)
      await chrome.storage.sync.set(sanitizedSettings)
    } catch (error) {
      const message = error instanceof Error ? error.message : '接口配置无效'
      setStatus(message)
      return
    }

    const stored = normalizeSettings(await chrome.storage.sync.get(null))

    if (
      stored.profiles.length !== sanitizedSettings.profiles.length ||
      stored.activeProfileId !== sanitizedSettings.activeProfileId
    ) {
      console.error('Open Translate settings save verification failed', {
        expected: sanitizedSettings,
        stored,
      })
      setStatus('保存失败，请重试')
      return
    }

    setSettings(stored)
    setEditingId(
      stored.profiles.some((profile) => profile.id === nextEditingId)
        ? nextEditingId
        : stored.activeProfileId,
    )
    setStatus(message)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await saveSettings(settings, '已保存接口配置')
  }

  async function addProfile() {
    const profile = createProfile()
    await saveSettings(
      {
        profiles: [...settings.profiles, profile],
        activeProfileId: profile.id,
      },
      '已新增接口配置',
      profile.id,
    )
  }

  async function duplicateProfile() {
    const profile = {
      ...editingProfile,
      id: createProfile().id,
      name: `${editingProfile.name} 副本`,
    }
    await saveSettings(
      {
        profiles: [...settings.profiles, profile],
        activeProfileId: profile.id,
      },
      '已复制接口配置',
      profile.id,
    )
  }

  async function removeProfile() {
    if (settings.profiles.length <= 1) {
      setStatus('至少保留一个接口配置')
      return
    }

    const profiles = settings.profiles.filter((profile) => profile.id !== editingProfile.id)
    const activeProfileId =
      settings.activeProfileId === editingProfile.id
        ? profiles[0].id
        : settings.activeProfileId

    await saveSettings({ profiles, activeProfileId }, '已删除接口配置', activeProfileId)
  }

  async function activateProfile(profileId: string) {
    await saveSettings({ ...settings, activeProfileId: profileId }, '已设为当前翻译接口', profileId)
  }

  function updateProfile<Key extends keyof TranslationProfile>(
    key: Key,
    value: TranslationProfile[Key],
  ) {
    setSettings((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === editingProfile.id ? { ...profile, [key]: value } : profile,
      ),
    }))
  }

  return (
    <main className="options-shell">
      <header className="options-header">
        <div>
          <p className="eyebrow">Open Translate</p>
          <h1>接口配置</h1>
        </div>
        <button type="button" onClick={addProfile}>
          新增配置
        </button>
      </header>

      <div className="layout">
        <aside className="profile-list" aria-label="接口配置列表">
          {settings.profiles.map((profile) => (
            <button
              type="button"
              key={profile.id}
              className={profile.id === editingProfile.id ? 'active' : ''}
              onClick={() => setEditingId(profile.id)}
              title={`${profile.name} · ${profile.model || '未设置模型'}`}
            >
              <strong>{profile.name}</strong>
              <span>模型：{profile.model || '未设置'}</span>
            </button>
          ))}
        </aside>

        <form className="settings-form" onSubmit={handleSubmit}>
          <div className="form-toolbar">
            <button
              type="button"
              className="secondary"
              onClick={() => activateProfile(editingProfile.id)}
              disabled={settings.activeProfileId === editingProfile.id}
            >
              设为当前
            </button>
            <button type="button" className="secondary" onClick={duplicateProfile}>
              复制
            </button>
            <button type="button" className="danger" onClick={removeProfile}>
              删除
            </button>
          </div>

          <label>
            <span>配置名称</span>
            <input
              value={editingProfile.name}
              onChange={(event) => updateProfile('name', event.target.value)}
              placeholder="例如 OpenAI、DeepSeek、内网模型"
              maxLength={profileFieldLimits.name}
            />
          </label>

          <label>
            <span>接口地址</span>
            <input
              value={editingProfile.apiBaseUrl}
              onChange={(event) => updateProfile('apiBaseUrl', event.target.value)}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              maxLength={profileFieldLimits.apiBaseUrl}
            />
          </label>

          <label>
            <span>模型名称</span>
            <input
              value={editingProfile.model}
              onChange={(event) => updateProfile('model', event.target.value)}
              placeholder="gpt-4o-mini"
              spellCheck={false}
              maxLength={profileFieldLimits.model}
            />
          </label>

          <label>
            <span>API Key</span>
            <input
              value={editingProfile.apiKey}
              onChange={(event) => updateProfile('apiKey', event.target.value)}
              placeholder="sk-..."
              type="password"
              spellCheck={false}
              maxLength={profileFieldLimits.apiKey}
            />
          </label>

          <label>
            <span>目标语言</span>
            <input
              value={editingProfile.targetLanguage}
              onChange={(event) => updateProfile('targetLanguage', event.target.value)}
              placeholder="简体中文"
              maxLength={profileFieldLimits.targetLanguage}
            />
          </label>

          <label>
            <span>自定义系统提示词</span>
            <textarea
              value={editingProfile.customPrompt}
              onChange={(event) => updateProfile('customPrompt', event.target.value)}
              placeholder="留空时使用默认翻译提示词"
              rows={5}
              maxLength={profileFieldLimits.customPrompt}
            />
          </label>

          <div className="endpoint-preview">
            <span>请求端点</span>
            <code>{getEndpointPreview(editingProfile.apiBaseUrl)}</code>
          </div>

          <button type="submit" className="primary">
            保存配置
          </button>

          <p className="status-message">{status}</p>
        </form>
      </div>
    </main>
  )
}

function getEndpointPreview(apiBaseUrl: string) {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, '')
  if (!normalized) {
    return '未设置'
  }

  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
)
