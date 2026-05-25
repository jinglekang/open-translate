import type { AppTheme } from './settings'

export function applyAppTheme(theme: AppTheme) {
  const root = document.documentElement
  root.classList.toggle('light', theme === 'light')
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme === 'system' ? '' : theme
}
