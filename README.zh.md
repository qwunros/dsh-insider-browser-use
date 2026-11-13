# dsh-insider-browser

为 **DeepSeek Harness（dsh）Web 端**提供右侧栏「内置浏览器」，并把浏览器能力暴露给智能体。

> 这是社区插件，不是 DeepSeek 官方产品。

## 功能

- **右侧栏「浏览器」**：展开右侧栏的“开始”页即可看到“浏览器”卡片；面板里有地址栏、后退/前进/刷新，画面来自真实 Chrome/Edge 的实时渲染。
- **人和智能体都能操作**：点一下画面，鼠标点击/双击/右键/拖拽、滚轮、键盘输入与快捷键（含中文输入法、粘贴）都会映射进真实浏览器；智能体同时在操作也不会互相锁住。
- **低延迟镜像**：画面约 30fps、按侧栏宽度降采样传输，输入事件整批写入 Chrome 而不逐条等待回包；点击到画面反馈通常约 20–30ms。
- **后台不冻结**：镜像页被新标签或弹窗挤到后台时会自动恢复可见与焦点。Chrome 只给可见页面出画面，隐藏页面的输入还会延迟数秒，恢复后地址栏导航与键鼠操作都保持即时。
- **会话里的链接直接跳转**：对话中点击网页链接（链接打开方式为“侧栏”）会在右侧栏打开浏览器并跳转到该地址，即使面板已经打开在别的页面。
- **新标签链接也跟随**：页面里 `target="_blank"` 或 `window.open` 打开的链接会直接在镜像页打开并保留后退历史，而不是悄悄开一个看不到的新标签。
- **浏览器载体可选**：默认自带一个无头 Chrome/Edge；也可以直接驱动**已经开着的浏览器**（面板所在的 Chrome、带调试端口的 Electron/桌面壳），不再另起一个进程，登录态共用。见下文「浏览器载体」。
- **更稳的浏览器发现**：除 Program Files 外还会查注册表 `App Paths`、`PATH`、Chrome/Edge 的 Beta/Dev/Canary、Chromium、Brave，并支持 `browserPath` 与 `DSH_BROWSER_PATH` 环境变量覆盖。
- **智能体可直接使用**：安装后智能体获得 `browser_*` 工具（打开网页、读取内容/源码、截图、点击、输入、按键、滚动、等待、历史导航）。
- **自动展示**：智能体第一次操作浏览器时，右侧栏自动展开并显示浏览器画面。
- **操作提示**：智能体操作期间，画面顶部显示「dsh正在操作浏览器」。
- **虚拟光标**：智能体点击/输入/滚动时，画面上实时显示光标位置与点击涟漪。
- **设置项**：设置 → 浏览器，可清除内置浏览器 Cookie，或从本机 Chrome / Edge / Firefox 导入 Cookie（导入后保持登录态）。

## 安装

需要本机已安装 Chrome 或 Edge。先克隆仓库，然后把本目录安装进 DSH 的 Web profile：

```sh
git clone <本仓库地址>
cd <仓库目录>
dsh plugin --profile web add "<本目录的绝对路径>"
```

也可以在 Harness 的 Plugins 页面选择本插件目录安装（推荐）。安装后无需配置；第一次调用 `browser_*` 工具时自动启动内置浏览器。

安装后可在 **设置 → 浏览器** 找到 Cookie 管理页；右侧栏「开始」页会出现「浏览器」卡片，也可以直接让智能体打开网页（右侧栏会自动出现）。

## 浏览器载体

插件有两种载体，优先顺序固定：

1. **附着到已有浏览器**（配置了 `attachTo`，或自动发现调试端口）；
2. **自己启动**无头 Chrome/Edge（使用独立 profile）。

### 附着模式（复用面板所在的浏览器 / Electron）

如果浏览器是以调试端口启动的，插件可以直接在它里面开一个标签页来驱动，不再另起进程，**登录态与这个浏览器完全共用**：

```sh
# Windows：Chrome 136+ 要求调试端口必须搭配非默认 profile
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="%LOCALAPPDATA%\dsh-carrier-profile" \
  "http://127.0.0.1:3080"
```

然后：

- **无需配置**：插件会依次探测 9222 / 9223 / 9333，谁在响应就用谁；
- 或显式指定（插件行配置，或环境变量）：

```yaml
- id: insider-browser
  config:
    attachTo: 9222        # 端口、http://127.0.0.1:9222 或 ws://... 均可
```

```sh
set DSH_BROWSER_DEBUG_PORT=9222
set DSH_BROWSER_DEBUG_URL=http://127.0.0.1:9222   # 二选一
```

Electron / 桌面壳同样适用：只要它以 `--remote-debugging-port=<port>` 启动（或本身暴露了 CDP 端点），把 `attachTo` 指过去即可。**注意**：当前 Web 部署的 dsh GUI 本身就运行在你的浏览器里，并没有 Electron 进程；Electron 载体只在桌面壳/自建壳的情况下存在。

### 附着模式的安全边界

- 插件**只关自己开的那个标签页**，永远不会关闭、退出或重启这个浏览器；
- 不清空也不写入它的 Cookie：`clearCookies` / 导入 Cookie 在附着模式下会明确报错，除非显式设置 `allowCookieWrites: true`（那会影响真实 cookie 罐）；
- 默认只允许 loopback 端点；远端调试端口需要 `allowRemoteDebugging: true`；
- 解除安装/禁用插件后，载体浏览器照常运行。

### 找不到浏览器时

```yaml
- id: insider-browser
  config:
    browserPath: "D:/Portable/Chrome/chrome.exe"   # 或 DSH_BROWSER_PATH
    browserChannel: chrome|edge|brave|chromium      # 可选，限定渠道
    attachTo: 9222                                  # 可选，优先复用已有浏览器
```

`GET /dsh-insider-browser/state` 的 `diagnostics` 字段会列出：已发现的候选可执行文件（含来源）、`attachTo` 是否可达、相关环境变量，以及上一次启动失败的原因，便于直接定位问题。

## 开发与测试

需要 Node.js >= 22.19、本机 Chrome 或 Edge；没有构建步骤。

```sh
node tools/engine-check.mjs --mock     # 引擎契约、工具、模拟 CDP
node tools/host-check.mjs              # Host 装配
node tools/http-check.mjs              # HTTP/SSE 表面
node tools/client-human-check.mjs      # 客户端输入与链接导航
node demo/server.mjs                   # 可选：本地演示页 http://127.0.0.1:8899
node tools/live-check.mjs              # 对运行中的 dsh + 插件做端到端检查
node tools/attach-check.mjs            # 附着模式：复用已有浏览器并验证不会关掉它
```

实现细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 智能体工具

| 工具 | 用途 |
|---|---|
| `browser_open` | 打开 URL（右侧栏自动出现并显示页面） |
| `browser_snapshot` | 读取可交互元素（带编号）与页面文本，用于定位元素 |
| `browser_content` | 读取页面正文（text）或 HTML |
| `browser_source` | 读取页面源码 |
| `browser_screenshot` | 截图并返回图片（需要模型支持图片输入） |
| `browser_click` | 按 ref/selector/文本/坐标点击 |
| `browser_type` | 在输入框输入文本 |
| `browser_key` | 发送按键（Enter/Tab/Escape/方向键等） |
| `browser_scroll` | 滚动页面 |
| `browser_wait_for` | 等待文本/选择器出现 |
| `browser_back` / `browser_forward` / `browser_reload` | 历史导航 |
| `browser_close` | 关闭内置浏览器实例 |

## 数据与隐私

- 默认载体使用本机 Chrome/Edge 的独立 profile：`<DSH_HOME>/insider-browser/profile`（默认 `C:\Users\<用户>\.dsh\insider-browser\profile`），登录态只保存在本机。
- 附着模式下页面运行在你自己的浏览器里，插件只操作它新开的那个标签页，不会读取或改动你其它标签页的内容。
- 导入外部浏览器 Cookie 时，插件只读取并写入 **本地内置浏览器**，不向网络发送 Cookie，也不把明文 Cookie 写入对话或日志。
- 无头浏览器没有地址栏之外的 UI；页面由右侧栏镜像显示。少数站点会拦截无头/自动化访问，可改用附着模式、导入 Cookie 或系统浏览器打开。

## 已知限制

- 当前版本不支持多标签视图、下载、上传、代理、扩展；一个 dsh 宿主共享一个内置浏览器实例。
- 截图工具需要当前模型声明支持图片输入。
- 附着模式依赖浏览器以调试端口启动；普通双击打开的 Chrome/Edge 没有调试端口（Chrome 136+ 也不允许在默认 profile 上开启），因此无法直接接管“你现在正在看的那个窗口”，需要按上文命令重启一次并指定独立 profile。
- 右侧栏镜像仍是像素画面：附着模式下被驱动的标签页会随插件一起打开/关闭，请不要手动关掉它。
- **从 Chrome/Edge 导入 Cookie 时，请先退出该浏览器**：Chrome/Edge 运行时会独占锁定 Cookie 数据库，导入会返回“数据库被占用”的可读提示（Firefox 不受影响）。
- 从 Chrome/Edge 导入使用“临时复制 profile + 由原浏览器自行解密”的方式；若来源浏览器使用了不兼容的加密方式或数据被损坏，会给出可读的失败说明。
- 面板是“镜像 + 输入转发”：无头浏览器没有原生右键菜单/下载条/标签栏；部分由 DSH 页面抢占的组合键可能先被 DSH 处理；复制到系统剪贴板依赖浏览器的剪贴板授权，失败时页面内选择不受影响。

## 许可证

[MIT](LICENSE)。
