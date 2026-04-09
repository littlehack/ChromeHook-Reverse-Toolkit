# ChromeHook Reverse Toolkit

一个基于 Chrome Manifest V3 的逆向 Hook 调试插件骨架，适合在页面运行时做接口追踪、函数包裹、调用栈采集和插桩验证。

## 已实现能力

- 分类 Hook 按需注入
- 支持一键取消 Hook，恢复原始函数
- 页面 Console 实时输出 `[ChromeHook]` 日志
- Popup 面板快速操作
- DevTools 面板大屏调试
- 自定义 Hook 代码在页面上下文执行
- 日志会回流到扩展面板中实时展示，并支持检索过滤
- DevTools 面板附带分析助手，可做常见转义解码和 anti-debug 特征扫描

## Hook 分类

当前按以下分类独立注入：

- `fetch`：`window.fetch`
- `xhr`：`XMLHttpRequest.open`、`XMLHttpRequest.setRequestHeader`、`XMLHttpRequest.send`
- `cookie`：`document.cookie`、`cookieStore.get/set/delete`
- `storage`：`Storage.prototype.getItem`、`Storage.prototype.setItem`
- `json`：`JSON.parse`、`JSON.stringify`
- `eval`：`window.eval`
- `timer`：`window.setTimeout`、`window.setInterval`
- `keyword`：独立监控 `fetch`、`xhr`、`cookie`，命中后单独生成 `keyword hit` 事件

## 如何加载

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前目录 `d:\Desktop\chromehook`

## 使用方式

1. 打开目标页面
2. 点击扩展图标，进入 Popup
3. 勾选需要的 Hook 分类
4. 点击“注入选中 Hook”
5. 打开页面 DevTools Console，可看到 `[ChromeHook]` 前缀日志
6. 首次选择分类后，建议刷新一次页面；扩展会记住该标签页的分类并在重新加载时提前安装，以捕获更早发出的请求
7. XHR 日志会拆分显示为 Header、Request、Response 三段，便于直接查看 URL、Header、Body、状态码和响应头
8. 在 Popup 或 DevTools 面板中，可通过搜索框检索分类、URL、标签或详情内容
9. DevTools 面板中的 Console 输出为普通信息流，不再使用黑色粗体分组标题
10. DevTools 面板附带“分析助手”，可用于转义字符解码和常见 anti-debug 模式扫描
11. 勾选 `keyword` 分类后，可在关键词输入框中填写 `token`、`authorization`、`sign` 等关键字，命中后会生成 `keyword hit` 日志
12. `keyword` 默认同时匹配字段名和值；如只想匹配字段名，用 `key:authorization`；如只想匹配字段值，用 `value:Bearer`
13. 如需避免 `sign` 命中 `signature` 这类子串情况，可使用 `exact:sign`、`exact-key:authorization`、`exact-value:Bearer`
14. Popup 和 DevTools 里提供了默认匹配模式下拉框；直接输入原词即可，手写前缀会优先覆盖下拉模式
15. 如需恢复原始实现，可点击“取消 Hook”

## 自定义 Hook 代码说明

自定义代码运行时会收到一个 `hook` 对象，可直接使用：

- `hook.resolvePath(path)`：解析目标路径，如 `window.atob`、`JSON.parse`
- `hook.wrapMethod(target, key, name, factory)`：包裹函数
- `hook.log(level, label, details, options)`：主动输出日志
- `hook.captureStack()`：抓取当前调用栈

## 注意事项

- Chrome 内置页、扩展页、部分受限页面无法注入
- 当前实现侧重调试与逆向分析，不包含持久化规则管理
- 如页面有 CSP 或框架沙箱，个别目标可能需要单独定制 Hook
