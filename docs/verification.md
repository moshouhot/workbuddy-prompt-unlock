# CLI + GUI 验收

## 交付形态

- 统一 Node CLI：`wb.mjs` → `cli.mjs` → 现有提示词/安全配置引擎。
- C# / WPF Windows GUI：`WorkBuddyUnlock.exe`（项目根目录），调用同一 CLI，未复制补丁算法。EXE 向上查找 `wb.mjs` 定位项目根。
- 提示词仍在 `prompts/`。已打补丁的 content_policy 也能继续同步编辑后的内容；查找替换对保留历史。
- 不修改 app.asar，不在安装根目录创建工程文件或缓存。

## 自动测试

`npm test`：7 项全部通过，覆盖：

1. JSON 帮助/参数/输出，preview 无写入，提示词错误不写入，提示词与安全配置一体备份/应用，重复应用无变化，三个 content_policy 和两个 new 文本的后续编辑，字面量 `$&` / `$1` / `$$`，撤销、冲突与备份列表。
2. 操作锁、最新企业托管状态、缺少配置、说明段缺少历史时明确报错。
3. 实际 Windows 文件共享锁阻止第二次写入时，第一个已写文件自动恢复；备份状态为 rolled-back。
4. “允许完全访问”偏好默认开启、保留同文件其他字段、可用 `--no-full-access` 关闭。
5. 企业账号目录（`user-<uid>-<企业短名>`，非 `-personal` 结尾）同样会被写入；没有偏好文件的账号目录不被新建。
   该用例已用反向验证确认：把匹配回退为旧实现 `/-personal$/` 时它确实失败。
6. 界面勾选偏好默认“两个都开启”，且跨进程记住上次选择。
7. 实时同步判定：`needApply` 与 `pendingChanges` 一致；改提示词归因 `prompt-changed`；apply 后转 `in-sync`。
   并验证**升级后不误报**：仅把插件缓存版本目录改名（内容逐字节相同）时，`needApply` 仍为 false，
   同时 `upgraded` 能报出 `from`/`to`；再把模板改回官方内容则归因为 `upgraded`。

所有写入测试使用独立临时安装/配置/提示词目录，不修改生产客户端。

## GUI

Release 发布成功（.NET 8 WPF / win-x64 / framework-dependent single-file GUI）。

`powershell -NoProfile -ExecutionPolicy Bypass -File src/tools/ui_smoke.ps1 -Screenshots`：

- 在真实 WPF 窗口中通过 UI Automation 点击“预览”“应用”“撤销”，非绕过 UI 的内部调用。
- 标题栏为 `WorkBuddy Prompt Unlock v<版本> · C#`，版本与 EXE 程序集版本（源自 `package.json`）一致；断言写成 `^WorkBuddy Prompt Unlock v<FileVersion> . C#$`。
- 内容区不重复主标题/副标题（断言：内容区 TextBlock 中不得出现 `WorkBuddy Prompt Unlock` 或“本地提示词管理”）。
- 预览未改变文件哈希。
- 安全配置 checkbox 到 CLI 生效。
- 应用改变目标，撤销后提示词目标字节与安全配置恢复。
- 首次应用前与撤销后恢复按钮禁用；应用后启用。
- 窗口正常关闭，无残留验收进程。
- ICO 包含 16/24/32/48/64/128/256 尺寸，EXE 与窗口使用同一图标。

截图为**临时假安装的合成数据**：

- `ui-synthetic-normal.png`：常规窗口，96 DPI 渲染（顶部横幅为「需要同步」告警态）。
- `ui-synthetic-compact150.png`：最小窗口，144 DPI 渲染；不是修改显示器缩放的物理 DPI 验收。
- `ui-synthetic-synced.png`：已同步态横幅（绿色）。由 `ui_smoke.ps1 -Screenshots` 生成前先 apply 一次才能得到该态，
  因此单独保存在 `docs/` 供对照；重生成方式见该脚本末尾的截图分支。

截图不在仓库内（由本机 `src/tools/ui_smoke.ps1 -Screenshots` 生成到 `docs/`，已由 `.gitignore` 排除）。

## GUI 实时性（单独用例）

`powershell -NoProfile -ExecutionPolicy Bypass -File src/tools/ui_live_state.ps1`：

验证“窗口开着就会自己发现要不要重新应用”，全程不手动刷新：

1. 起始横幅为「检测到 N 个文件需要同步」（告警色），且**不带**客户端版本（版本改到安装行展示）；
2. 点“一键应用”后自动变「✓ 客户端已是当前提示词，无需操作」（不需要手动刷新）；
3. **从外部把目标文件改回官方内容**（模拟客户端升级覆盖），不点任何按钮，
   20 秒轮询内自动变回「检测到 1 个文件需要同步」；
4. 再应用一次并等一轮完整轮询，确认稳定在「无需操作」——轮询不会产生假告警。

最小窗口（640×800）下已逐项确认：日志区可读；长安装路径在勾选行内换行（不硬切）；最长提示词标签（“Agent / Expert 内容策略 · content_policy.craft-expert.txt”≈440px，超出可用宽约 342px）改用省略号 + 悬停全称；按钮与 footer 未裁切。

## 真实安装只读检查

`node wb.mjs verify --security --json`：

- 两份安装（`WorkBuddy` 国内版、`WorkBuddyAI`）
- 两份安装各自发现提示词目标，合计 `targetCount` 随客户端版本变化（实测 54～57）；待同步 0
- 沙箱关闭、规则/黑名单为空的现状保持不变
- 本轮未为真实安装产生新应用备份（没有需要改的内容）

> 这类计数（`targetCount`、各回归脚本扫到的文件数）跟随客户端当前安装的版本增减，
> 是实时快照而非固定基准；**只要“失败/异常/不一致”为 0 即通过**，不必与历史数字相等。

既有工具（本次实测）：compile 58 成功/0 失败；render 56 成功/0 真实失败/2 缺 include 跳过；verify_diff 45 文件/0 异常；verify_json 13/0 异常；verify_externalized 一致 47/不一致 0；安装目录守卫两份均正常。

LSP 探测无诊断但 6 文件均未确认完成，不作为通过证据；使用实际 Node 语法检查、自动测试与 WPF Release 编译证明。

## 明确边界

- 本机要求 Node.js 与 .NET 8 Desktop Runtime；未制作运行时自包含安装包。
- 撤销仅针对统一工具最近一次实际 apply，不宣称恢复所有官方原始文件。
- 对冲突文件不强制覆盖。异常终止留下 pending/rollback-failed 事务时停止自动写入，需要根据备份恢复。
- 提示词约束不是系统级硬拦截。
