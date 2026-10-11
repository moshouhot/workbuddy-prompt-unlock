# CLI + GUI 验收

## 交付形态

- 统一 Node CLI：`wb.mjs` → `cli.mjs` → 现有提示词/安全配置引擎。
- C# / WPF Windows GUI：`WorkBuddyUnlock.exe`（项目根目录），调用同一 CLI，未复制补丁算法。EXE 向上查找 `wb.mjs` 定位项目根。
- 提示词仍在 `prompts/`。已打补丁的 content_policy 也能继续同步编辑后的内容；查找替换对保留历史。
- 不修改 app.asar，不在安装根目录创建工程文件或缓存。

## 自动测试

`npm test`：3 组全部通过，覆盖：

1. JSON 帮助/参数/输出，preview 无写入，提示词错误不写入，提示词与安全配置一体备份/应用，重复应用无变化，三个 content_policy 和两个 new 文本的后续编辑，字面量 `$&` / `$1` / `$$`，撤销、冲突与备份列表。
2. 操作锁、最新企业托管状态、缺少配置、说明段缺少历史时明确报错。
3. 实际 Windows 文件共享锁阻止第二次写入时，第一个已写文件自动恢复；备份状态为 rolled-back。

所有写入测试使用独立临时安装/配置/提示词目录，不修改生产客户端。

## GUI

Release 发布成功（.NET 8 WPF / win-x64 / framework-dependent single-file GUI）。

`powershell -NoProfile -ExecutionPolicy Bypass -File tools/ui_smoke.ps1 -Screenshots`：

- 在真实 WPF 窗口中通过 UI Automation 点击“预览”“应用”“撤销”，非绕过 UI 的内部调用。
- 预览未改变文件哈希。
- 安全配置 checkbox 到 CLI 生效。
- 应用改变目标，撤销后提示词目标字节与安全配置恢复。
- 首次应用前与撤销后恢复按钮禁用；应用后启用。
- 窗口正常关闭，无残留验收进程。
- ICO 包含 16/24/32/48/64/128/256 尺寸，EXE 与窗口使用同一图标。

截图为**临时假安装的合成数据**：

- `ui-synthetic-normal.png`：常规窗口，96 DPI 渲染。
- `ui-synthetic-compact150.png`：最小窗口，144 DPI 渲染；不是修改显示器缩放的物理 DPI 验收。

截图不在仓库内（由本机 `src/tools/ui_smoke.ps1 -Screenshots` 生成到 `docs/`，已由 `.gitignore` 排除）。

最小窗口日志区已修正为可读，未发现按钮或 footer 裁切。

## 真实安装只读检查

`node wb.mjs verify --security --json`：

- 两份安装（WorkBuddy、WorkBuddyAI）
- 发现 46 个目标，待同步 0
- 沙箱关闭、规则/黑名单为空的现状保持不变
- 本轮未为真实安装产生新应用备份（没有需要改的内容）

既有工具：compile 42 成功/0 失败；render 40 成功/0 失败/2 缺 include 跳过；verify_diff 检查 68 文件/0 异常；verify_json 检查 7/0 异常；verify_externalized 一致 38/不一致 0/跳过 5；安装目录守卫两份均正常。

LSP 探测无诊断但 6 文件均未确认完成，不作为通过证据；使用实际 Node 语法检查、自动测试与 WPF Release 编译证明。

## 明确边界

- 本机要求 Node.js 与 .NET 8 Desktop Runtime；未制作运行时自包含安装包。
- 撤销仅针对统一工具最近一次实际 apply，不宣称恢复所有官方原始文件。
- 对冲突文件不强制覆盖。异常终止留下 pending/rollback-failed 事务时停止自动写入，需要根据备份恢复。
- 提示词约束不是系统级硬拦截。
