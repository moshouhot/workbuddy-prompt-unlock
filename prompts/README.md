# prompts/ — 替换用的系统提示词

这些文件是 `unlock.mjs` 实际写入 WorkBuddy 的内容。
`unlock.mjs` 启动时从这里读取，**不再是硬编码**——你可以直接改这些文件来定制提示词。

修改后在界面点击“一键应用”，或运行 `node wb.mjs apply --close --restart --json`。**已应用过也直接重新应用，不要先还原。** AI 与界面共用同一 CLI。

---

## 文件清单

### 1. `content_policy.*` — 简洁执行原则

| 文件 | 替换目标 | 说明 |
|---|---|---|
| `content_policy.craft-expert.txt` | `workbuddy-{craft,expert,normal}-*.tpl` 及 welcomemode | Agent/Expert 模式的策略。**原文要求「政治敏感一律拒答」，并禁止逆向/漏洞分析** |
| `content_policy.ask-legacy.txt` | `workbuddy-ask-*.tpl` | Ask 模式的旧版策略。原文额外要求套用固定拒答话术 |
| `content_policy.cli.txt` | `cli/product.json` 的 `prompts[].template` | CLI 基座提示词，**与桌面模板叠加**，独立一份策略 |

> 三个文件对应三个来源，当前采用相同的四句原则：直接完成任务、清晰可逆操作不反复确认、关键缺失信息才询问、如实报告结果。保留三个文件是为了兼容现有替换入口，不再维护三套不同规则。

### 2. `personal_files_safety.txt`

替换 `<personal_files_safety>` 段。

- **原文**：8 条强制规则，要求「扫描=只读」「批次≤10」「删除前必须加粗警告+逐条列出+要求确认」，实际会让正常的清理请求变成只出报告不动手。
- **现在**：只保护盘符根、Windows/System32、Program Files 整个目录不被递归删除或清空；其中明确文件及其他子目录的正常操作不因此被禁止。不额外扩大到 Home、ProgramData 等。这是提示词约束，不是沙箱硬拦截。

### 3. `windows_command_safety.txt`

替换 `<windows_command_safety>` 段。

- **原文**：5 条强制，含「破坏性命令失败后禁止用任何方式重试」。
- **现在**：一句操作建议：检查路径引用，失败后诊断并按原目标重试，不扩大删除范围。

### 4. `ask_mode.*` — Ask 模式只读限制

| 文件 | 替换目标 |
|---|---|
| `ask_mode.current_mode.txt` | `workbuddy-ask-*.tpl` 的 `<current_mode>` |
| `ask_mode.reminder.txt` | `ask-mode-reminder.tpl` 的 `<ask_mode>`，以及 CLI JSON 里的同名段 |

- **原文**：硬性只读，「必须拒绝任何修改请求」。
- **现在**：优先只读，用户明确要求改时可写。

### 5. `cli_security_note.*`

替换 CLI 提示词里的安全工具说明段（首次匹配 old，后续通过 `.state/prompt-history.json` 中的历史 new 内容更新）。

- **`old`**：原文「双用途安全工具（C2 框架、凭据测试、漏洞利用开发）需要明确的授权背景」才协助。
- **`new`**：按任务实际上下文选择合适技术工具，直接说明结果；不添加领域长清单，也不预设所有任务已授权。

> `old` 必须与 WorkBuddy 原文逐字一致。日常只改 `new`，保留 `.state/prompt-history.json`；匹配不到已知说明段时，新统一 CLI 会报错，而不是静默成功。

### 6. `user_custom.*`

替换用户自定义指令的从属性声明（成对）。

- **`old`**：「除非与安全规则冲突」——自定义指令永远让位于 safety。
- **`new`**：优先级高于一般默认行为。

> 这段在 `user-context-identity.tpl` 和 `user-context-expert-identity.tpl` 里。

---

## 编辑注意

1. **编码**：必须 UTF-8，无 BOM。
2. **换行**：LF 或 CRLF 都行，`unlock.mjs` 会按目标模板的换行风格转换。
3. **不要加 nunjucks 语法**：这些是纯文本，会作为字面量写入。若需要模板变量（如 `{{ productName }}`），WorkBuddy 会在后续渲染阶段处理，但**新引入的 `{% %}` 可能破坏模板**——`tools/compile_test.mjs` 会检出。
4. **尾部空行会被裁剪**：`loadPrompt()` 会去掉末尾所有换行，保持与原硬编码一致。
5. **成对文件**：`cli_security_note.*` 和 `user_custom.*` 是「查找-替换」对，改 `new` 随意，改 `old` 要谨慎。

---

## 验证

改完 prompts/ 后：

```cmd
cd ..\tools
node compile_test.mjs           # 语法没被破坏
node verify_externalized.mjs    # prompts/ 与磁盘补丁逐字节一致
node render_test.mjs            # 渲染成功且无原始拒答残留
```

日常使用 `node wb.mjs preview --json` 预览、应用后 `node wb.mjs verify --json` 确认同步。`restore.cmd` 只撤销最近一次一键应用，**不是恢复全部官方模板**，无需为了编辑提示词先撤销。

---

## 精简原则

不在客户端重复枚举模型自身边界，不写无条件授权假设或强制不拒绝的要求。只保留任务执行原则和用户明确指定的防误删保护。

文本更短是可测的变化；是否减少拒答或提高任务成功率，需要实际对照测试，不能仅凭关键词频次断言。
