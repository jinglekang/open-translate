# Open Translate

Open Translate 是一个开源 Chrome 翻译插件，支持配置 OpenAI 兼容的大模型接口。配置接口地址、模型名称和 API Key 后，可以在网页中选中文字或直接在页面空白处右键调用翻译。

## 功能

- 配置 OpenAI 兼容接口地址，例如 `https://api.openai.com/v1`
- 配置模型名称、API Key、目标语言和自定义系统提示词
- 在选项页维护多套接口配置
- 在弹窗中快速切换当前使用的接口配置
- 选中文本后通过右键菜单翻译，并直接替换选区内容
- 未选中文本时通过右键菜单翻译当前页面可见文本
- 翻译结果直接替换页面显示内容，尽量保留原页面结构

## 开发

```bash
pnpm install
pnpm build
```

构建产物会输出到 `dist`。

项目使用 Vite 多入口构建：

- `src/popup/index.html` 作为插件弹窗入口，`src/popup/main.tsx` 维护当前接口切换
- `src/options/index.html` 作为插件选项页入口，`src/options/main.tsx` 维护多套接口配置
- `src/background/index.ts` 作为 Chrome MV3 后台脚本入口，构建后固定输出为 `dist/service-worker.js`

## 安装到 Chrome

1. 执行 `pnpm build`
2. 打开 Chrome 扩展管理页：`chrome://extensions`
3. 启用“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择项目下的 `dist` 目录

## 使用

1. 在扩展详情页打开“扩展程序选项”
2. 在选项页新增或编辑接口配置，并设置当前翻译接口
3. 点击浏览器工具栏里的 Open Translate 图标，可快速切换当前接口
4. 在任意网页选中文字，或不选中文本直接右键页面
5. 右键选择“翻译为目标语言”

接口地址会自动拼接 `/chat/completions`。如果你填写的地址已经是完整的 `/chat/completions` 端点，插件会直接使用该地址。

整页翻译会收集当前页面最多 180 个可见文本节点并分批翻译。页面内容会被直接替换，刷新页面即可恢复原文。
