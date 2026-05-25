# Open Translate

Open Translate 是一个开源 Chrome 翻译插件，支持配置 OpenAI 兼容的大模型接口，也支持 Chrome Built-in AI。配置翻译接口后，可以在网页中选中文字翻译，也可以在页面空白处右键翻译页面内容。

> 本项目由 AI 辅助开发。

## 功能

- 配置 OpenAI 兼容接口地址，例如 `https://api.openai.com/v1`
- 支持 Chrome Built-in AI Translator API
- 配置模型名称、API Key、并发数、批量段数、批量文本长度和自定义系统提示词
- 在选项页维护多套翻译接口
- 在弹窗中快速切换当前翻译接口、目标语言、翻译偏好、翻译范围和翻译方式
- 选中文本后通过右键菜单翻译，并在选区旁边悬浮显示译文
- 未选中文本时通过右键菜单翻译当前页面内容
- 整页翻译支持仅译文替换或双语对照显示
- 页面翻译支持当前视窗模式，滚动后继续翻译进入视窗的内容
- 页面翻译支持段落整体模式，保留行内代码等不翻译片段
- 使用本地缓存，相同原文和相同配置下会优先复用缓存译文
- 支持不翻译白名单、不翻译节点选择器和最小翻译字数
- 支持 Chrome 扩展国际化，目前内置简体中文和英文

## 开发

```bash
pnpm install
pnpm build
```

构建产物会输出到 `dist`。

项目使用 Vite 多入口构建：

- `src/popup/index.html` 作为插件弹窗入口，`src/popup/main.tsx` 维护快速设置
- `src/options/index.html` 作为插件选项页入口，`src/options/main.tsx` 维护完整扩展设置
- `src/background/index.ts` 作为 Chrome MV3 后台脚本入口，构建后固定输出为 `dist/service-worker.js`
- `src/page/runtime.ts` 作为页面运行时入口，构建后固定输出为 `dist/page-runtime.js`
- `src/shared/settings.ts` 维护配置 schema、zod 校验、旧配置迁移和默认值
- `public/_locales` 维护 Chrome 扩展国际化文案

## 安装到 Chrome

1. 执行 `pnpm build`
2. 打开 Chrome 扩展管理页：`chrome://extensions`
3. 启用“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择项目下的 `dist` 目录

## 使用

1. 在扩展详情页打开“扩展程序选项”
2. 在选项页新增或编辑翻译接口，并设置当前翻译接口
3. 点击浏览器工具栏里的 Open Translate 图标，可快速调整翻译设置
4. 在任意网页选中文字，或不选中文本直接右键页面
5. 右键选择“翻译为目标语言”

接口地址会自动拼接 `/chat/completions`。如果你填写的地址已经是完整的 `/chat/completions` 端点，插件会直接使用该地址。

页面翻译会由页面运行时收集文本并分批翻译。弹窗中的翻译范围可在“可见页面”和“当前视窗”之间切换；当前视窗模式会优先翻译屏幕内文本，并在滚动后继续翻译进入视窗的内容。选择“仅译文”时会替换页面文本，选择“双语对照”时会保留原文并插入译文。翻译完成后再次右键页面可选择“显示原文”取消翻译，刷新页面也会恢复原始页面内容。

## 缓存

翻译缓存存放在 `chrome.storage.local`。缓存 key 会包含接口地址、模型名称、目标语言、自定义提示词、翻译方式和原文内容，因此同一段原文只有在当前配置一致时才会命中缓存。页面翻译会先过滤缓存命中，只把未命中的文本发送给模型。
