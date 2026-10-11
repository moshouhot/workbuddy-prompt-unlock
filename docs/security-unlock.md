# security-unlock — 安全配置放开

解除 WorkBuddy 客户端的本地安全限制：沙箱、文件安全、命令安全、网络安全、程序黑名单、数据安全。

与 `unlock.mjs`（提示词）相互独立，可单独使用。

---

## 用法

```cmd
node security-unlock.mjs status        查看所有安全项现状
node security-unlock.mjs apply         全部放开
node security-unlock.mjs apply --dry-run   只预览
node security-unlock.mjs restore       还原最近一次备份
```

> **必须先完全退出 WorkBuddy（含托盘图标）**，否则 `settings.json` 会被运行中的客户端回写覆盖。

---

## 改了什么

### 本地配置（`~/.workbuddy/`）

| 项目 | 文件 | 改动 |
|---|---|---|
| 沙箱安全（总开关） | `app/app-config.json` | `sandboxSafetyEnabled` → `false` |
| 文件安全 | `settings.json` | `sandbox.orderedRules.file` 清空 135 条预设规则 |
| 命令安全 | `settings.json` | `sandbox.orderedRules.command` 清空 + 标记 customized |
| 网络安全 | `settings.json` | `sandbox.orderedRules.network` 清空 + 标记 customized |
| 程序黑名单 | `settings.json` | `sandbox.programBlacklist` → `[]` |
| 删除保护 | `settings.json` | `sandbox.deleteProtection` → `false` |
| 安全删除运行时 | `settings.json` | `sandbox.safeDeleteRuntimeEnabled` → `false` |
| 批量删除阈值 | `settings.json` | `safeDeleteBulkThreshold` → `2147483647`（不再弹确认） |
| 版本控制 | `settings.json` | `sandbox.versionControl` → `false` |
| 敏感信息保护 | `settings.json` | `sensitiveProtection.enabled` → `false` |

### 引擎侧规则文件（安装目录）

| 项目 | 文件 | 改动 |
|---|---|---|
| 沙箱引擎规则 | `.../cli/vendor/sandbox/<ver>/tsbx_rules.json` | `file_rules` 清空（含 `~/.ssh`、`~/.gnupg` 的 deny）、`network_policy.enabled` → `false`、清空 registry/process/network 规则 |

---

## 两个关键实现细节

### 1. 为什么要设 `customized: true`

清空规则后**必须**把 `customized` 置为 `true`，否则下次启动时客户端的 `upgradeLegacyFilePreset` 逻辑会把预设规则**重新灌回来**：

```js
function u(t, n, r) {
  if (t.presetVersion >= FILE_POLICY_PRESET_VERSION) return t;  // 已是最新则跳过
  let i = c(n);                                                  // c() 生成预设规则集
  if (r.every(e => e.source === 'preset') && l({...t, customized: false}, n)) return i;  // ← 无自定义就重置
  ...
}
```

`customized: true` 会让这段升级逻辑走「保留用户规则」分支，从而不被覆盖。实测重启客户端后配置保持不回流。

### 2. 为什么 `programBlacklist` 必须显式设为 `[]`

**不设置 ≠ 空**。代码逻辑：

```js
function ixe(e, t) {                       // t = platform
  let n = e?.sandbox;
  if (!n || typeof n !== 'object') return t === 'win32' ? [...u$] : [];   // ← 缺省用内置默认
  let r = n.programBlacklist;
  let i = Array.isArray(r) ? [...new Set(r.filter(...))] : void 0;
  return t === 'win32' ? (i === void 0 ? [...u$] : i) : (i ?? []);        // ← undefined 也回退默认
}
```

其中 `u$ = ['wsl.exe','wslconfig.exe','wmic.exe','sc.exe','reg.exe','schtasks.exe']`。

所以只有当 `programBlacklist` 是**已定义的数组**时才生效；本工具显式写入 `[]` 来清空。

---

## 关于 `manage=false` 与托管策略

代码里 `dataSecurity`（安全网关 / 传输加密）**只在 `managed: true` 时才有值**：

```js
if (!o.managed) return l;                    // 非托管：直接返回本地状态
return { ..., ...o.dataSecurity ? { dataSecurity: {
  securityGatewayEnabled: o.dataSecurity.securityGatewayEnabled,
  transmissionEncryptionEnabled: o.dataSecurity.transmissionEncryptionEnabled,
}} : {} };
```

本机日志为 `managed policy resolved managed=false`，即**不受企业策略托管**，本地写入全部生效。

那两项「安全网关 / 传输加密」由服务端配置注入，本地无法也无需控制（截图里的"已开启"是非托管状态下的 UI 默认值）。

若你的机器是 `managed=true`，本工具会拒绝写入并提示——那属于服务端强制，无法本地绕过。

---

## 刻意保留的项

### 凭据检测（`detect-rules.toml`）

**默认不修改。** 它保护的是 `~/.ssh` 私钥、`.aws` 凭据、`.git-credentials` 等——这是**防泄露**，不是限制 AI。清空它意味着 AI 可能把明文密钥写入上下文或日志。

如确实需要关闭：

```cmd
node security-unlock.mjs apply --with-credentials
```

### 浏览器白名单（`white_process`）

保留 8 条（Chrome / Edge / Firefox 等）。这只影响沙箱是否放行浏览器进程，属于功能性配置，保留无碍。

---

## 验证

```cmd
node security-unlock.mjs status    # 所有项应为放开状态
```

期望输出：

```
沙箱安全            关闭  ✓ 已关
文件安全            预设规则 0 条 (customized=true)
命令安全            规则 0 条
网络安全            规则 0 条
删除保护            关闭
批量删除阈值        2147483647
安全删除运行时      关闭
敏感信息保护        关闭
程序黑名单          自定义: 0 项 (空)
tsbx_rules.json     文件规则 0 条，含 deny 0 条；network_policy.enabled=false
```

---

## 还原

每次 `apply` 前自动备份到 `backup/<时间戳>/`。

```cmd
node security-unlock.mjs restore                  还原最近一次
node security-unlock.mjs restore --backup=<ID>    还原指定
```

还原后需重启客户端。

---

## 已知边界

- **沙箱引擎二进制未改动**：`sandbox-cli.exe` / `tsbx.dll` 保留原样，只改它们的规则数据。
  `tsbx_rules.json` 在 `app.asar` 里有 SHA256 记录，但**运行时无校验**（CLI 代码中 `verifyFileIntegrity` / `checkIntegrity` 等函数计数均为 0），实测修改后客户端正常启动、零错误日志。
- **客户端升级会重置**：升级会重新解包覆盖 `tsbx_rules.json`；`settings.json` 通常保留（在用户目录），但建议升级后重新跑一次 `status` 确认。
- **服务端策略无法绕过**：托管策略、服务端内容审核不在本工具范围内。
