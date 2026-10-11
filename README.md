# WorkBuddy Prompt Unlock

一个后端，两个入口：**AI 用 CLI，人用 Windows 界面**。提示词保存在 `prompts/`，可直接修改。

仅处理本地客户端文件；不改变模型能力、服务端审核或账号权限。**不修改、不重新打包 `app.asar`**。

## 获取与首次运行

仓库是私有的，需要先获得访问权限（由仓库所有者邀请为协作者，或使用有权限的账号）。

```cmd
git clone https://github.com/moshouhot/workbuddy-prompt-unlock.git
cd workbuddy-prompt-unlock
npm install
```

`npm install` 是**必需**的：它会安装 `tools/node_modules/nunjucks`，用于在写入前做模板语法校验。跳过这步时任何命令都会直接返回 `INITIALIZATION_FAILED`（`Cannot find module './tools/node_modules/nunjucks'`）。该目录不入库，所以每次全新 clone 都要装一次。

安装后先做只读检查，确认能发现你的安装：

```cmd
node wb.mjs status --json
```

看到 `roots` 列出你的 WorkBuddy 安装路径、`targetCount` 大于 0，即可继续。没发现安装时用 `--root` 指定：

```cmd
node wb.mjs status --root="D:\Program Files\WorkBuddy" --json
```

准备条件：Windows 10/11 x64、Node.js LTS（需 `node` 在 PATH 中）、GUI 另需 .NET 8 Desktop Runtime x64。

### 用 Release 包（推荐）

在仓库 **Releases** 页下载 `workbuddy-prompt-unlock-1.0.0-full.zip`，解压到任意可写目录（不要放进 WorkBuddy 安装目录），双击 `UI.vbs` 即可。

Release 包**已内置** `tools/node_modules`，不需要 `npm install`，也不需要联网。

自己 clone 源码时仍需运行一次 `npm install`（仓库不包含依赖目录）。

## 人使用：一键完成

双击 **`UI.vbs`**（或 `app/WorkBuddyUnlock.exe`），不弹命令行窗口。

1. 先保存 WorkBuddy 中的工作。
2. 点击 **一键应用**：校验提示词 → 关闭客户端 → 备份 → 同步 → 校验 → 重启。
3. 如需一起处理之前的安全配置，勾选 **同时放开本地安全配置**。默认不改变安全开关现状，也不会自动恢复已关闭的开关。

**允许完全访问**默认开启，不依赖上面的安全配置勾选：它把新任务的默认权限模式设为“允许完全访问”，减少逐条确认。存储在 `<配置目录>/storage/user-<uid>-personal/global/preferences.json` 的 `localTaskPermissionMode`（`full-access` / `default-sandbox`）。只改已登录账号的偏好文件，保留同文件里的主题、语言等字段；没有账号目录时不会新建。CLI 用 `--no-full-access` 可关闭。

两个勾选**默认都开启**，且会被**记住**：写入 `.state/ui-preferences.json`，下次打开恢复上次选择。首次运行（或删除该文件）回到“两个都开启”。“取消勾选”表示**本次不改**，不会把已开启的开关恢复回去；它也不会改动凭据检测。

界面会额外显示“客户端当前：已开启 / 未开启 / 部分账号已开启 / 尚无账号配置”，这是读磁盘得到的客观状态，与你的勾选分开看待。

顶部橙色提示条常驻提醒：**WorkBuddy 升级后要回来重新“一键应用”**。升级会重新解包并覆盖模板、换掉旧版本插件缓存，改动会失效。

界面还能：
- **选择目标安装**：勾选要处理的安装，默认全部勾选。两套安装各自使用独立配置目录，取消勾选就不会动它。
- **预览**：只看计划，不关闭客户端、不写目标文件。
- **撤销上次应用**：撤销最近一次统一 CLI/UI 的实际改动。不是“一键恢复官方原版”。
- **编辑文件**：选择提示词，使用记事本编辑；保存后再点击“一键应用”。
- **打开目录**：直接打开 `prompts/`。

应用/撤销会关闭客户端，请先保存工作。操作执行期间按钮禁用，窗口在事务完成前不能退出。

也保留批处理入口：`apply.cmd`（默认完整同步提示词）、`restore.cmd`（撤销最近一次一键应用）。
`apply.cmd --security` 同时处理本地安全配置。

### 运行环境

- Windows 10/11 x64
- Node.js LTS（本机测试 Node 24.13.0），`node` 在 PATH 中
- .NET 8 Desktop Runtime x64（仅 GUI 需要）
- 保持项目目录完整，尤其是 `prompts/`。首次使用必须先运行 `npm install` 安装 `tools/node_modules/nunjucks`。

界面 EXE 不是整个工具的单文件封装；它调用同目录项目中的 CLI。无需安装 Python、Electron 或启动 Web 服务。

## AI 使用：统一 CLI

在项目根目录执行：

```cmd
node wb.mjs status --json
node wb.mjs preview --json
node wb.mjs installs --json
node wb.mjs apply --close --restart --json
node wb.mjs apply --install=WorkBuddy --close --restart --json
node wb.mjs verify --json
node wb.mjs restore --close --restart --json
node wb.mjs prompts --json
node wb.mjs backups --json
```

### 两套安装与独立配置目录

WorkBuddy 与 WorkBuddyAI 各有**自己的用户配置目录**，插件缓存和 CLI 缓存都按配置分开存放，因此必须分别同步：

| 安装 | 版本（本机实测） | 配置目录 |
|---|---|---|
| `WorkBuddy`（国内版） | 5.7.7 | `~/.workbuddy` |
| `WorkBuddyAI` | 5.7.6 | `~/.workbuddy-ai` |

只改其中一个安装时，另一个的插件缓存副本会保持原样。界面默认**全部勾选**；CLI 用 `--install` 只处理指定安装。`node wb.mjs installs --json` 会列出每个安装及其配对配置目录。

> **升级后记得回来重新“一键应用”。** 官方升级会重新解包并覆盖模板、同时换掉旧版本插件缓存，之前的提示词改动会失效。

可选安全配置：

```cmd
node wb.mjs preview --security --json
node wb.mjs apply --security --close --restart --json
node wb.mjs verify --security --json
```

`--security` 会关闭沙箱总开关、清空文件/命令/网络规则与程序黑名单、调整数据安全项及沙箱引擎规则。**不改凭据检测文件**。企业托管配置会明确报错。

| 参数 | 说明 |
|---|---|
| `--json` | stdout 只输出一个 JSON 对象，不混入日志 |
| `--install=NAME` | 只处理指定安装（`WorkBuddy` / `WorkBuddyAI`，逗号分隔）。**目录名精确匹配优先**，所以 `--install=WorkBuddy` 不会误匹配 `WorkBuddyAI` |
| `--root=PATH` 或 `--root PATH` | 仅操作指定安装；默认发现常见安装位置与两套 WorkBuddy 安装 |
| `--config=PATH` | 指定配置/插件缓存目录；默认按安装自动配对（见下表） |
| `--close` | 同意自动关闭发现的安装中的 WorkBuddy 进程；不指定时，运行中的客户端导致拒绝写入 |
| `--restart` | 完成后启动客户端；原先运行的客户端默认会恢复启动 |
| `--no-restart` | 操作完成后不启动客户端 |
| `--dry-run` | apply/restore 只预览，不关闭客户端、不写入 |
| `--backup=ID` | 撤销指定的统一 apply 备份 |
| `--security` | 同时应用/检查本地安全配置，默认不动 |
| `--no-full-access` | 不修改“允许完全访问”权限偏好（默认会开启） |

### 界面勾选的记忆

CLI 提供两个命令，供界面保存/读取勾选（UI 自身不写任何文件）：

```cmd
node wb.mjs ui-state --json
node wb.mjs ui-remember --state="{\"fullAccess\":true,\"includeSecurity\":true}" --json
```

记忆文件为 `<状态目录>/ui-preferences.json`（受 `WORKBUDDY_STATE_DIR` 隔离，默认 `.state/`）。文件不存在或删除时回到“两个都开启”。

### “允许完全访问”

指新任务的默认权限模式，对应界面输入框上方的同名开关。它决定新任务是否逐条请求确认，与沙箱规则、提示词是三个独立层面：

- 存储：`<配置目录>/storage/user-<uid>-personal/global/preferences.json` 的 `localTaskPermissionMode`
- 取值：`full-access`（开）/ `default-sandbox`（关，客户端默认值）
- 工具行为：`apply` 时**默认开启**（无需 `--security`）；只改已存在的偏好文件，不新建账号目录，并保留主题、语言等其他字段

`status`/`verify` 的 `security.fullAccess` 会报告当前状态（`true` / `false` / `"mixed"` 表示部分账号未开 / `null` 表示尚无偏好文件）。

成功示例：

```json
{"ok":true,"command":"apply","data":{"changed":12,"backup":"...","restarted":["..."],"message":"已应用并校验；新会话使用新提示词"}}
```

失败示例（退出码 1）：

```json
{"ok":false,"command":"apply","error":{"code":"CLIENT_RUNNING","message":"..."}}
```

`verify` 根据当前提示词内容与选择的选项检查，不再只扫描固定关键词；未同步时返回 `NOT_APPLIED` 与非零退出码。重复应用相同内容不会再创建备份。

CLI 不替 AI 作专业判断；只负责发现目标、校验、备份、机械同步、进程生命周期、错误输出和撤销。

## 修改提示词

修改 `prompts/*.txt`，UTF-8 无 BOM，保留 `<content_policy>` 等成对标签。保存后直接重新应用，**不需要先还原**。

- `content_policy.*.txt`：三个来源的内容策略
- `personal_files_safety.txt`：文件操作与防误删
- `windows_command_safety.txt`：Windows 命令建议
- `ask_mode.*.txt`：Ask 模式行为/提醒
- `cli_security_note.new.txt`：安全工具说明
- `user_custom.new.txt`：用户自定义指令优先级

两个 `.old.txt` 是官方原文的匹配文本，日常只改 `.new.txt`。界面只列出 9 个实际编辑文件，不让用户误改匹配基准。

完整说明见 [`prompts/README.md`](prompts/README.md)。提示词里的防误删规则是 **AI 指令，不是系统调用级硬拦截**。

`.state/prompt-history.json` 保存历史替换文本，以便更新已经应用过的 `.new.txt`。保留此文件；丢失历史且无法匹配时会报错，不伪装成功。可迁移既有安装时使用 `node wb.mjs init --json` 保存当前提示词历史（在编辑提示词前运行）。

## 备份、撤销与失败

- 每次有改动的统一应用生成**一个完整事务备份**，同时覆盖安装模板、插件缓存、CLI 提示词及选中的安全配置。
- `backup/<ID>/manifest.json` 保存原始与应用后的 SHA256、操作类型和状态。
- 写入失败会回滚已写文件；撤销前校验备份哈希和目标文件哈希。
- 客户端升级或其他软件改变了文件时，撤销返回 `RESTORE_CONFLICT`，不会覆盖升级后的文件。
- `.state/operation.lock` 阻止重复点击/并发写入。异常退出留下锁时，确认没有操作进程后才能删除锁；未完成事务必须按提示恢复备份后再操作。
- 之前 `unlock.mjs` / `security-unlock.mjs` 产生的备份保留，但不会被新“撤销上次应用”混用。

旧脚本仍可用于高级维护；它们的 `restore` 只还原选定备份里的文件，并非完整官方恢复流程。不要把最近一次局部备份当作全量原版。

## 实际处理的位置

1. `<安装>/resources/app.asar.unpacked/resources/templates/*.tpl`
2. `.../plugins/workbuddy-builtin/welcomemode/{code,work,design}/prompt.tpl`
3. `<配置目录>/plugins/cache/workbuddy-builtin/welcomemode-*/<版本>/prompt.tpl`（实际 include 的独立副本）
4. `<安装>/resources/app.asar.unpacked/cli/product.json` 与 `<配置目录>/cache/acc-product-config-v3.json` 的 `prompts[].template`

第 3、4 项对**每个配置目录**各处理一次，所以 `targetCount` 会随发现的安装数量增加（两套安装为 54）。

模板保留非目标区块；JSON 只改目标提示词字段。写入前编译 Nunjucks 语法，写入后检查字节和是否仍有待同步内容。

WorkBuddy 升级可能覆盖这些文件，**升级后再次一键应用**。不承诺跨未来版本始终兼容；发现不支持的说明段会停止并报错。

官方升级会重新解包并改变非目标区块，这是正常现象；回归工具以**每个文件最新一次备份**为基线，不会把升级差异报成异常。

## 开发与验证

```cmd
npm test
node wb.mjs verify --json
dotnet publish ui/WorkBuddyUnlock.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o app
```

GUI 为 C# / WPF 的薄壳：ViewModel 管状态，CliService 调 CLI，不在 C# 重写补丁逻辑。无 GUI 第三方依赖。

原有回归脚本继续保留：`tools/compile_test.mjs`、`render_test.mjs`、`verify_diff.mjs`、`verify_json.mjs`、`verify_externalized.mjs`。

安装更新提示“存在用户项目目录”时：

```cmd
node tools/check_install_guard.mjs
node tools/check_install_guard.mjs --fix
```

工具只删除已知纯缓存，不删除真实项目。不要将安装目录作为开发工作区，也不要在安装根目录留下 `.ruff_cache` 等额外目录。

## 目录

```text
UI.vbs                  人使用：无命令行窗口启动界面
app/WorkBuddyUnlock.exe  WPF 界面
wb.mjs / cli.mjs         AI 与 GUI 共用入口/事务编排
unlock.mjs              提示词补丁引擎（保留旧 CLI）
security-unlock.mjs     安全配置引擎（保留旧 CLI）
apply.cmd / restore.cmd  快捷入口
prompts/                用户可编辑的提示词
.state/                 历史替换文本、并发锁
backup/                 自动备份
ui/                     GUI 源码
 tools/                 回归测试与诊断
```
