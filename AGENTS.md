# Open Translate — 开发约定

Chrome MV3 翻译扩展，使用 Vite、React、TypeScript、Tailwind v4、Zod。已发布到 Chrome Web Store；产品介绍、安装和功能规划见 README，规划不代表当前开发任务。

## 命令与验证

- 开发：`pnpm dev`；构建：`pnpm build`（包含 TypeScript 检查）。
- 修改代码后运行：`pnpm build`、`pnpm lint`、`git diff --check`。
- 修改页面 DOM 后，构建并运行 `node scripts/verify-page-dom.mjs`。测试使用隔离 Chromium 和模拟翻译；可设置 `BROWSER_PATH`，可传入本地 HTML 文件。
- 打包：`pnpm package`，先构建，再将完整 dist（含 sourcemap）压缩到 `releases/open-translate-<版本>.zip`。manifest 位于 ZIP 根目录，同版本覆盖；package 与 manifest 版本必须一致。
- 当前没有测试框架或格式化工具；不额外打包自定义字体。保留压缩和 sourcemap。

## 架构与入口

| 文件 | 职责 |
|---|---|
| `src/background/index.ts` | 菜单、设置读取、运行时注入、请求调度和进度提示 |
| `src/background/translation.ts` | OpenAI 兼容请求、提示词、批处理和缓存 |
| `src/page/runtime.ts` | DOM 收集、动态/滚动翻译、节点状态、译文应用、原文恢复和内置翻译 |
| `src/popup/main.tsx` / `src/options/main.tsx` | 快速设置 / 完整设置 |
| `src/shared/settings.ts` | 设置 schema、默认值、校验和规范化 |
| `public/_locales/{zh_CN,en}/messages.json` | 用户界面文案，两种语言同步维护 |

- DOM 状态由页面运行时统一管理，background 不重复实现收集逻辑。
- 固定产物：`service-worker.js`、`page-runtime.js`、`popup/index.html`、`options/index.html`。
- `page-runtime.js` 通过文件注入，必须自包含；内置 Translator API 在页面环境运行，不能放在 service worker。
- 保留跨站页面翻译所需的 host 权限，不能直接用 `activeTab` 替代。兼容 Chrome/Edge，内置翻译取决于浏览器能力。

## 设置与命名

- 默认：内置翻译、简体中文、双语、当前视窗、段落整体；主题默认跟随系统，支持浅色/深色，`appTheme` 存于 sync。
- 语言选项统一来自 `src/shared/languages.ts`，内置翻译的语言代码也从此派生。
- Popup 标题为“快速设置 / Quick Settings”，保持左标签右控件，提供当前接口、目标语言、显示偏好、范围、方式和设置入口。
- Options 标题为“扩展设置 / Extension Settings”，左侧菜单依次为翻译设置、翻译接口、规则、缓存；不要把整页称作接口配置。
- 使用 `translationScope / TranslationScope`、`translationMode / TranslationMode`、`translators`、`translatePageTexts` 和 `Page*`；不要恢复旧的 `pageTranslationScope`、`pageTextProcessingMode`、`Dynamic*` 命名。`TranslationProfile / profile` 可保留。
- `element-context` 对应“段落整体 / Whole paragraph”，`text-node` 对应“逐文本节点 / Text nodes”。

## 翻译约束

- OpenAI 兼容接口使用 `/chat/completions`，地址和模型必填；API Key 可选，空值不发送 Authorization，非空发送 Bearer。
- 内置翻译隐藏地址、模型、Key 和提示词字段；并发和批处理参数仍按接口配置保存。
- 选中文本仅发单次请求，不批处理。页面可批处理：先应用缓存命中，再请求未命中项；命中结果及时分批应用。
- 并发指每个接口的页面批次并发数：API 默认 4，内置默认 8，范围 1–8。每批默认 4 段、最多 8 段；默认 1200 字符、最多 4000。
- 批处理使用分隔协议，必须校验返回段数，失败回退逐段请求。缓存失败只记录日志，不阻断翻译。
- 进度反映实际翻译状态；页面请求失败要显示错误并停止本轮自动翻译，不能误报完成，也不能被后续进度覆盖。

## DOM 安全与双语布局

- 段落模式用 `__OPEN_TRANSLATE_KEEP_0__` 等占位符保护片段。提示词要求原样保留；回填容忍小写，恢复为 DOM 节点，占位符丢失时不能丢掉原片段。
- 包含链接、交互控件、隐藏内容、自定义元素或复杂块布局时，回退文本节点更新，保留节点身份和事件；应用译文前再次检查安全性。
- 不请求翻译隐藏子树、未打开的 dialog/popover；始终跳过扩展 UI、表单控件及 SVG/canvas/iframe/script/style/noscript 等技术节点。
- 双语布局两种翻译模式共用：完整标题/段落优先换行，普通长文本参考可用宽度；导航、控件、混合句子片段和受限布局保持同行。不为排版修改父容器布局或重建交互节点。
- 白名单和不翻译选择器是逗号分隔的用户规则，删除默认项后必须生效。`pre`、`code`、`[contenteditable="true"]` 仅通过用户选择器保护，不能硬编码强制跳过。
- `src/shared/whitelist.ts` 中的基础文本过滤不是用户白名单；最小翻译长度 `minTranslationTextLength` 默认 2。

## 缓存

- 使用 `chrome.storage.local`；不加缓存版本字段，未经明确要求不加兼容迁移。
- `maxTranslationCacheEntries` 默认 10,000，范围 1–100,000；调低并保存时立即按 LRU 清理超额条目。缓存页保留数量统计和清空操作。
- 缓存 key 包含地址、模型、目标语言、自定义提示词、`translationMode` 和原文；不包含双语/仅译文等不影响翻译结果的 UI 状态。
