# open-translate — Project Notes for Agents

Open Translate is an open-source Chrome MV3 translation extension. It is built with Vite, React, Tailwind v4, shadcn/ui style components, TypeScript, Zod, and ESLint.

This file records project-specific requirements and decisions so future sessions can continue without rediscovering them.

## Commands

```bash
pnpm dev
pnpm build
pnpm lint
```

- `pnpm build` runs `tsc -b` and then Vite, so type errors fail the build.
- There is currently no test framework and no formatter.
- After code changes, run `pnpm build`, `pnpm lint`, and `git diff --check`.

## Extension Entries

- `src/background/index.ts`: MV3 service worker. Owns context menus, settings lookup, page runtime injection, selected-text translation, API translation, cache-aware batch pipeline, and page progress notices.
- `src/page/runtime.ts`: injected page runtime. Owns initial collection, mutation collection, scroll collection, node state, applying translations, restoring original text, and Chrome Built-in AI page translation.
- `src/popup/main.tsx`: quick settings popup. Keep it compact. It should expose current translator, target language, display mode, translation scope, translation mode, and an Options entry.
- `src/options/main.tsx`: full settings page. It uses left navigation and right content, with menu order: translators, translation, rules, cache.
- `src/shared/settings.ts`: Zod schemas, defaults, validation, and settings normalization.
- `src/background/translation.ts`: OpenAI-compatible request logic, batching, prompt construction, cache keys, and cache reads/writes.
- `public/_locales/{zh_CN,en}/messages.json`: all user-visible strings.

Vite outputs fixed extension files:

| Source | Output |
|---|---|
| `src/background/index.ts` | `dist/service-worker.js` |
| `src/page/runtime.ts` | `dist/page-runtime.js` |
| `src/popup/index.html` | `dist/popup/index.html` |
| `src/options/index.html` | `dist/options/index.html` |

`dist/page-runtime.js` must remain self-contained because it is injected with `chrome.scripting.executeScript({ files: ["page-runtime.js"] })`.

## Product Requirements

- Popup and Options should automatically follow the browser/system color scheme with `prefers-color-scheme`; do not add a manual theme switch unless explicitly requested.
- Default target language is Simplified Chinese.
- Target language choices in Popup should come from `src/shared/languages.ts`; Chrome Built-in AI target language codes should be derived from those same canonical options. Do not add legacy alias compatibility unless explicitly requested.
- Default display mode is bilingual.
- Default translation scope is viewport.
- Default translation mode is whole paragraph.
- Popup labels use left-label/right-control rows.
- Popup title is "Quick Settings" / "快速设置", not the product name.
- Options title is "Extension Settings" / "扩展设置", not "API Profiles" / "接口配置".
- Options left nav order is:
  1. Translators / 翻译接口
  2. Translation / 翻译设置
  3. Rules / 规则设置
  4. Cache / 缓存设置
- Avoid UI copy that says the whole Options page is only API configuration. The page now includes translation, rules, and cache settings.

## Translation Behavior

- Selected-text translation is single-request translation. Do not batch selected text.
- Page translation and dynamic page translation may batch multiple segments.
- Page translation pipeline should filter cache hits before sending uncached text to the model.
- Concurrency is per translator profile and means concurrent page translation batches.
- Default concurrency is 4; valid range is 1-8.
- Default max segments per request is 4; max is 8.
- Default max text length per request is 1200; max is 4000.
- Batch translation uses a separator protocol and must validate the returned segment count.
- If batch translation fails, fall back to single-segment translation.
- Cache failures must not block translation. Log them and continue.
- Progress notices should be tied to real translation progress, not only right-click menu flow.
- Cache hits should be applied promptly in batches, not one text node at a time and not only after all cache checks finish.

## Page Runtime Ownership

The page runtime is the owner of page translation state:

- initial collection
- dynamic mutation collection
- scroll collection
- visible/viewport filtering
- translated-node bookkeeping
- duplicate prevention
- applying partial and final translations
- restoring original page text

The background service worker should start the runtime and process translation requests, but should not duplicate DOM collection logic.

Use `Page*` naming for page runtime behavior. Do not introduce new `Dynamic*` names for page translation features.

## Translation Modes

The internal setting is `translationMode`.

- `element-context`: UI label "Whole paragraph" / "段落整体". This is the default.
- `text-node`: UI label "Text nodes" / "逐文本节点".

Whole paragraph mode translates an element-sized inline fragment and protects inline nodes with placeholders such as `__OPEN_TRANSLATE_KEEP_0__`.

Requirements for whole paragraph mode:

- Keep protected placeholders in the prompt and tell the model not to translate, lowercase, split, wrap, or explain them.
- Placeholder replacement in runtime should tolerate lowercased tokens from the model.
- Protected fragments such as `code`, `pre`, and user no-translate selectors must be restored as DOM nodes.
- If the model drops placeholders, fail safely so protected fragments are not lost.

`translationMode` must participate in cache key generation because prompts and input shape differ between modes.

## Rules And Filtering

- `minTranslationTextLength` lives in translation settings. Default is 2.
- User whitelist is comma-separated text in Options.
- Default user whitelist terms are user-editable defaults, not forced rules. If the user removes them, they should stop being skipped by whitelist matching.
- No-translate selectors are comma-separated text in Options.
- Default no-translate selectors include `pre`, `code`, and `[contenteditable="true"]`.
- These three defaults are user rules, not forced runtime rules. If the user removes them, the runtime should stop treating those nodes as no-translate nodes.
- Built-in filtering rules are in `src/shared/whitelist.ts` and are not user-editable. They are basic text filters, not whitelist entries.
- The runtime should always skip extension UI and non-content technical nodes such as form controls, SVG/canvas/iframe/script/style/noscript.
- The runtime should skip `pre`, `code`, contenteditable, and similar content only through `noTranslateSelectors`, so the user can opt out by editing rules.
- Inline code should usually be preserved, not translated. Whole paragraph mode is preferred for quality around inline code because it preserves context with placeholders.

## Cache

- Translation cache uses `chrome.storage.local`.
- Do not add a cache version field. The project has not shipped yet, so compatibility migrations are not needed unless explicitly requested.
- Cache key should include settings that affect output, including endpoint, model, target language, custom prompt, `translationMode`, and source text.
- Cache key should not include unrelated UI state such as display mode.
- Options cache page should show cache count and provide clear-cache.

## Providers

Supported providers:

- OpenAI-compatible API through `/chat/completions`.
- Chrome Built-in AI Translator API.

Chrome Built-in AI requirements:

- It must run in the page context, not the MV3 service worker.
- Hide endpoint, model, API key, and custom prompt fields for Chrome Built-in profiles.
- Keep concurrency and batch settings per profile because different providers/models have different limits.

## Naming

Use the current names:

- `translationScope`, not `pageTranslationScope`.
- `TranslationScope`, not `PageTranslationScope`.
- `translationMode`, not `pageTextProcessingMode`.
- `TranslationMode`, not `PageTextProcessingMode`.
- `translators` tab, not `profiles` tab.
- `translatePageTexts`, not `translateDynamicTexts`.

`TranslationProfile` and `profile` are still acceptable for the internal model representing a saved translator configuration.

## Chrome Extension Notes

- The extension currently needs broad host access for page translation across arbitrary websites.
- `activeTab` alone is usually not enough for automatic dynamic/scroll/runtime page behavior unless the product scope is changed.
- The extension should support Chrome-compatible Chromium browsers such as Edge as long as used APIs are available. Chrome Built-in AI remains Chrome-dependent.

## Build And Release Notes

- `minify` can stay enabled because sourcemaps preserve debugging for this open-source project.
- Do not bundle custom web fonts unless explicitly requested.
- Keep i18n strings in both `zh_CN` and `en`.
