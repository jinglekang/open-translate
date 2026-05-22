# open-translate — AGENTS.md

**Chrome MV3 translation extension** — an open-source Chrome extension using OpenAI-compatible large model APIs. Built with Vite 8, React 19, Tailwind v4, shadcn/ui (base-nova style with `@base-ui/react`), TypeScript ~6.0, Zod v4, ESLint v10 (flat config).

## Quick commands

```bash
pnpm dev          # Start Vite dev server
pnpm build        # tsc -b && vite build (typecheck + build)
pnpm lint         # ESLint flat config on src/
```

- **No test framework** — the repo has zero tests. No formatter configured either.
- No CI, no pre-commit hooks.

## Build quirks

- `tsc -b` is part of `build` (project references mode), so type errors will fail the build.
- The `vite.config.ts` has a custom `moveExtensionPages()` plugin that moves `dist/src/{popup,options}/index.html` → `dist/{popup,options}/index.html`, then deletes `dist/src/`. This is needed because Vite preserves the source directory tree for multi-entry HTML builds.
- Four Vite entries → four output files:
  | source | output |
  |---|---|
  | `src/popup/index.html` | `dist/popup/index.html` |
  | `src/options/index.html` | `dist/options/index.html` |
  | `src/background/index.ts` | `dist/service-worker.js` |
  | `src/page/runtime.ts` | `dist/page-runtime.js` |

## Extension architecture (4 entry points)

1. **Service worker** (`src/background/index.ts`) — MV3 background, sets up context menus, handles translation requests, injects page-runtime.js into web pages.
2. **Page runtime** (`src/page/runtime.ts`) — injected into web pages via `chrome.scripting.executeScript`. Uses `MutationObserver` + `TreeWalker` to translate visible text nodes.
3. **Popup** (`src/popup/main.tsx`) — React 19 app for the extension popup (profile selector, target language, display mode toggle).
4. **Options** (`src/options/main.tsx`) — React 19 app with 3 tabs: API Profiles, Cache, Whitelist.

All pages share the `public/manifest.json` (MV3, `default_locale: "zh_CN"`).

## Key patterns and conventions

- **Settings** live in `chrome.storage.sync`, validated with Zod v4 schemas in `src/shared/settings.ts`. There is a `normalizeSettings()` function that migrates legacy flat config to the current profile-based model.
- **Translation API**: OpenAI-compatible `/chat/completions`. Text segments are joined with `<OPEN_TRANSLATE_SEGMENT_BREAK>` separator and split on response. Concurrent request pool with configurable concurrency (1–8). Default temperature 0.2.
- **Cache**: SHA-256 keyed, stored in `chrome.storage.session`.
- **`@` path alias** → `src/`, configured in both `tsconfig.json` and `vite.config.ts`.
- **shadcn/ui** uses `@base-ui/react` primitives (not Radix). Installed via `shadcn` CLI with `base-nova` style.
- **`src/shared/whitelist.ts`** has built-in no-translate rules and user-definable whitelist. Defaults include common tech terms (OpenAI, GitHub, JSON, etc.).

## Directory layout

```
src/
  background/index.ts   — Service worker (696 lines)
  page/runtime.ts       — Page content script (491 lines)
  popup/main.tsx        — Popup UI (244 lines)
  options/main.tsx      — Options page (526 lines)
  shared/               — Settings, cache, i18n, whitelist, utility types, CSS
  types/chrome.d.ts     — Chrome API type declarations
  components/           — shadcn/ui components + custom components
public/
  manifest.json
  _locales/{en,zh_CN}/messages.json
  images/
```
