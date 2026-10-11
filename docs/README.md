# docs/ — 归档文档

根目录只保留 `README.md`。这里的文档供需要时查阅，不参与日常使用。

| 文件 | 内容 |
|---|---|
| [`security-unlock.md`](security-unlock.md) | 安全配置放开引擎（`src/security-unlock.mjs`）的详细说明与旧 CLI 用法。日常通过 `wb.mjs apply --security` 调用，一般不需要直接读它。 |
| [`verification.md`](verification.md) | 验收范围与证据：CLI 测试、UIA 冒烟、真实安装只读检查的具体结论与边界说明。 |
| [`prompt-review.md`](prompt-review.md) | 提示词精简审核记录：改了什么、为什么、实测结果，以及“可证明 / 不可证明”的边界。 |

## 相关但不在本目录

- [`../README.md`](../README.md)：项目总说明，安装、使用与命令参考。
- [`../prompts/README.md`](../prompts/README.md)：11 个可编辑提示词文件各自的替换目标与编辑注意事项。

## 约定

- 新增文档一律放 `docs/`，根目录不新增 `.md`（`README.md` 除外）。
- 文档里的命令示例按当前目录结构书写：CLI 在项目根运行 `node wb.mjs ...`，引擎源码在 `src/`，测试在 `src/tools/`。
