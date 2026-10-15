#!/usr/bin/env node
/**
 * WorkBuddy Security Unlock (wb-security-unlock)
 *
 * 解除 WorkBuddy 客户端的本地安全配置限制：
 *   - 沙箱安全总开关        (~/.workbuddy/app/app-config.json -> sandboxSafetyEnabled)
 *   - 文件安全（预设规则）  (~/.workbuddy/settings.json -> sandbox.orderedRules.file)
 *   - 命令安全              (settings.json -> sandbox.orderedRules.command)
 *   - 网络安全              (settings.json -> sandbox.orderedRules.network)
 *   - 程序黑名单            (settings.json -> sandbox.programBlacklist)
 *   - 数据安全              (settings.json -> sandbox.deleteProtection 等)
 *
 * 另外可选处理两处「引擎侧」规则文件：
 *   - 沙箱引擎规则  <安装>/resources/app.asar.unpacked/cli/vendor/sandbox/<ver>/tsbx_rules.json
 *   - 凭据检测规则  ~/.workbuddy/security/<uid>/cipher/detect-rules.toml
 *
 * 用法:
 *   node security-unlock.mjs status              查看所有安全项现状
 *   node security-unlock.mjs apply               全部放开（推荐）
 *   node security-unlock.mjs apply --dry-run     只预览
 *   node security-unlock.mjs apply --no-engine   只改本地配置，不碰引擎规则文件
 *   node security-unlock.mjs restore             还原最近一次备份
 *   node security-unlock.mjs restore --backup=ID 还原指定备份
 *
 * 注意:
 *   - 必须先完全退出 WorkBuddy（含托盘），否则 settings.json 会被回写。
 *   - 若客户端被企业策略托管（日志出现 managed policy resolved managed=true），
 *     本地写入会被拒绝，本工具会明确提示。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { BACKUP_ROOT, STATE_DIR } from './paths.mjs';

const HOME = os.homedir();
const CONFIG_DIR = process.env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(HOME, '.workbuddy');

/**
 * 每个安装使用独立的用户配置目录（~/.workbuddy、~/.workbuddy-ai）。
 * 安全配置也分开存放，多安装时按配置目录分别读写。
 */
function settingsPaths(configDir = CONFIG_DIR) {
  return {
    settings: path.join(configDir, 'settings.json'),
    appConfig: path.join(configDir, 'app', 'app-config.json'),
  };
}

// ---------------------------------------------------------------- 探测安装目录

function detectRoots() {
  const out = [];
  if (process.env.WORKBUDDY_ROOT) return [path.resolve(process.env.WORKBUDDY_ROOT)];
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    for (const name of ['WorkBuddy', 'WorkBuddyAI']) {
      const p = path.join(drive + path.sep, 'Program Files', name);
      const exes = ['WorkBuddy.exe', 'WorkBuddyAI.exe'].map((e) => path.join(p, e));
      if (exes.some((e) => fs.existsSync(e)) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** 找到所有 tsbx_rules.json（沙箱引擎规则）。 */
function findTsbxRules(roots) {
  const found = [];
  for (const root of roots) {
    const base = path.join(root, 'resources', 'app.asar.unpacked', 'cli', 'vendor', 'sandbox');
    if (!fs.existsSync(base)) continue;
    for (const ver of fs.readdirSync(base).sort()) {
      const f = path.join(base, ver, 'tsbx_rules.json');
      if (fs.existsSync(f)) found.push(f);
    }
  }
  return found;
}

// ---------------------------------------------------------------- 完全访问权限

/**
 * 「允许完全访问」= 新任务不再逐条确认的全局默认权限。
 * 存储在 preferences 的 localTaskPermissionMode：'full-access'（开）/ 'default-sandbox'（关）。
 * 客户端代码里的默认值是 'default-sandbox'，所以缺这个键时等同于关闭。
 */
const FULL_ACCESS = 'full-access';

/**
 * 各账号的全局偏好文件（localTaskPermissionMode 存于此）。
 *
 * 目录名规则来自客户端代码（app.asar 中 userStorageDirName）：
 *     `user-${uid}-${enterpriseId?.trim() || `personal`}`
 * 即企业账号是 `user-<uid>-<企业短名>`，个人账号才是 `user-<uid>-personal`。
 * 早先这里只匹配 /-personal$/，登录企业账号时目录不以 -personal 结尾而被整条跳过，
 * 导致「一键应用」报成功、客户端仍显示“默认权限”。因此改为匹配全部 user-* 账号目录。
 */
function findPreferenceFiles(configDir = CONFIG_DIR) {
  const storage = path.join(configDir, 'storage');
  if (!fs.existsSync(storage)) return [];
  const out = [];
  for (const dir of fs.readdirSync(storage).sort()) {
    // 只认账号目录；device/ skeleton/ 等非 user-* 目录自然被排除。
    if (!/^user-/.test(dir)) continue;
    const f = path.join(storage, dir, 'global', 'preferences.json');
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

/** 把完全访问打开。只改已存在的偏好文件，不新建账号目录。 */
function applyPermissionMode(opts = {}) {
  const actions = [];
  const edits = [];
  for (const file of findPreferenceFiles(opts.configDir)) {
    const prefs = readJson(file);
    if (!prefs) continue;
    if (prefs.localTaskPermissionMode === FULL_ACCESS) continue;
    const before = prefs.localTaskPermissionMode ?? '(未设置，等同 default-sandbox)';
    prefs.localTaskPermissionMode = FULL_ACCESS;
    edits.push({ file, data: prefs, what: `完全访问权限: ${before} -> ${FULL_ACCESS}` });
    actions.push('完全访问权限: 开启');
  }
  return { edits, actions };
}

/** 当前是否为完全访问；无偏好文件时返回 null（尚未创建账号）。 */
function getPermissionMode(configDir = CONFIG_DIR) {
  const files = findPreferenceFiles(configDir);
  if (!files.length) return null;
  const states = files.map((f) => readJson(f)?.localTaskPermissionMode === FULL_ACCESS);
  return states.every(Boolean) ? true : states.some(Boolean) ? 'mixed' : false;
}

/** 找到当前活跃用户的凭据检测规则。 */
function findDetectRules(configDir = CONFIG_DIR) {
  const out = [];
  const secDir = path.join(configDir, 'security');
  if (!fs.existsSync(secDir)) return out;
  const activeUid = readActiveUid(configDir);
  for (const uid of fs.readdirSync(secDir)) {
    if (uid === 'threat-database') continue;
    const f = path.join(secDir, uid, 'cipher', 'detect-rules.toml');
    if (fs.existsSync(f)) out.push({ file: f, uid, active: uid === activeUid });
  }
  return out;
}

function readActiveUid(configDir = CONFIG_DIR) {
  const p = path.join(configDir, 'user-state.json');
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return d.uid || d.userId || d.activeUid || null;
  } catch { return null; }
}

/** 当前登录账号 uid（security/ 下有 data.lock.holder 的那个）。 */
function findLiveUid(configDir = CONFIG_DIR) {
  const secDir = path.join(configDir, 'security');
  if (!fs.existsSync(secDir)) return null;
  for (const uid of fs.readdirSync(secDir)) {
    if (fs.existsSync(path.join(secDir, uid, 'data.lock.holder'))) return uid;
  }
  return null;
}

// ---------------------------------------------------------------- 工具

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function wbRunning() {
  let n = 0;
  for (const exe of ['WorkBuddy.exe', 'WorkBuddyAI.exe']) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exe}" /NH`, {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      n += (out.match(new RegExp(exe.replace('.', '\\.'), 'gi')) || []).length;
    } catch { /* ignore */ }
  }
  return n;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, data) {
  const nl = fs.readFileSync(p, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  let text = JSON.stringify(data, null, 2) + '\n';
  if (nl === '\r\n') text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, text, 'utf8');
}

// 放开后的规则集：保留「允许」，去掉「询问/拒绝」
const OPEN_ACTION = { read: 'allow', write: 'allow', delete: 'allow' };

// ---------------------------------------------------------------- 状态

function getStatus(configDir = CONFIG_DIR) {
  const { settings: SETTINGS, appConfig: APP_CONFIG } = settingsPaths(configDir);
  const settings = readJson(SETTINGS);
  const appConfig = readJson(APP_CONFIG);
  const s = settings?.sandbox ?? {};
  const rules = s.orderedRules ?? {};

  return {
    settings,
    appConfig,
    sandboxSafetyEnabled: appConfig?.sandboxSafetyEnabled,
    fileRules: rules.file?.rules?.length ?? 0,
    commandRules: rules.command?.rules?.length ?? 0,
    networkRules: rules.network?.rules?.length ?? 0,
    filePresetVersion: rules.file?.presetVersion,
    fileCustomized: rules.file?.customized,
    programBlacklist: s.programBlacklist,
    deleteProtection: s.deleteProtection,
    safeDeleteBulkThreshold: s.safeDeleteBulkThreshold,
    safeDeleteRuntimeEnabled: s.safeDeleteRuntimeEnabled,
    versionControl: s.versionControl,
    sensitiveProtection: settings?.sensitiveProtection?.enabled,
    extraAllowWrite: s.extraAllowWrite?.length ?? 0,
    tbxsRules: findTsbxRules(detectRoots()),
    detectRules: findDetectRules(configDir),
    fullAccess: getPermissionMode(configDir),
    configDir,
  };
}

function cmdStatus(configDir = CONFIG_DIR) {
  const st = getStatus(configDir);
  const yn = (v) => (v === true ? '开启' : v === false ? '关闭' : String(v));

  console.log(`\n配置目录: ${configDir}`);

  console.log('\n=== 安全中心（客户端界面开关）===');
  console.log(`  沙箱安全            ${yn(st.sandboxSafetyEnabled)}${st.sandboxSafetyEnabled === false ? '  ✓ 已关' : '  ← 需关'}`);
  console.log(`  文件安全            预设规则 ${st.fileRules} 条 (presetVersion=${st.filePresetVersion}, customized=${st.fileCustomized})`);
  console.log(`  命令安全            规则 ${st.commandRules} 条`);
  console.log(`  网络安全            规则 ${st.networkRules} 条`);

  console.log('\n=== 数据安全 ===');
  console.log(`  删除保护            ${yn(st.deleteProtection)}`);
  console.log(`  批量删除阈值        ${st.safeDeleteBulkThreshold}`);
  console.log(`  安全删除运行时      ${yn(st.safeDeleteRuntimeEnabled)}`);
  console.log(`  版本控制            ${yn(st.versionControl)}`);
  console.log(`  敏感信息保护        ${yn(st.sensitiveProtection)}`);

  console.log('\n=== 程序黑名单 ===');
  if (Array.isArray(st.programBlacklist)) {
    console.log(`  自定义: ${st.programBlacklist.length} 项 ${st.programBlacklist.length ? JSON.stringify(st.programBlacklist) : '(空)'}`);
  } else {
    console.log(`  未设置 -> 使用内置默认值: ["wsl.exe","wslconfig.exe","wmic.exe","sc.exe","reg.exe","schtasks.exe"]`);
  }

  console.log('\n=== 引擎侧规则文件 ===');
  if (!st.tbxsRules.length) console.log('  未找到 tsbx_rules.json');
  for (const f of st.tbxsRules) {
    const j = readJson(f);
    const n = (j?.file_rules?.length ?? 0) + (j?.file_rules_user?.length ?? 0);
    const deny = (j?.file_rules ?? []).filter((r) => /deny/.test(r.action || '')).length;
    console.log(`  ${f}`);
    console.log(`      文件规则 ${n} 条，含 deny ${deny} 条；network_policy.enabled=${j?.network_policy?.enabled} default=${j?.network_policy?.default}`);
  }
  const live = findLiveUid(configDir);
  for (const d of st.detectRules) {
    const raw = fs.readFileSync(d.file, 'utf8');
    const disabled = (raw.match(/disabledRules\s*=\s*\[([\s\S]*?)\]/)?.[1] || '').trim();
    console.log(`  ${d.file}`);
    console.log(`      uid=${d.uid}${d.uid === live ? ' (当前登录)' : ''} 自定义规则 ${(raw.match(/\[\[rules\]\]/g) || []).length} 条  disabledRules=[${disabled.replace(/\s+/g, ' ')}]`);
  }
}

// ---------------------------------------------------------------- apply

function planConfigBackup(configDir = CONFIG_DIR) {
  const { settings, appConfig } = settingsPaths(configDir);
  const files = [settings, appConfig].filter((f) => fs.existsSync(f));
  return files;
}

function applyLocal(opts) {
  const actions = [];
  const edits = [];
  const { settings: SETTINGS, appConfig: APP_CONFIG } = settingsPaths(opts.configDir);

  // 1) 沙箱安全总开关
  const appConfig = readJson(APP_CONFIG);
  if (appConfig) {
    if (appConfig.sandboxSafetyEnabled !== false) {
      appConfig.sandboxSafetyEnabled = false;
      edits.push({ file: APP_CONFIG, data: appConfig, what: '沙箱安全 -> 关闭' });
      actions.push('沙箱安全: 关闭');
    }
  }

  // 2) settings.json
  const settings = readJson(SETTINGS);
  if (!settings) {
    console.error(`无法读取 ${SETTINGS}`);
    throw new Error(`无法读取 ${SETTINGS}`);
  }
  settings.sandbox = settings.sandbox && typeof settings.sandbox === 'object' ? settings.sandbox : {};

  let changed = false;
  const mark = (what) => { actions.push(what); changed = true; };

  // 2a) 清空三类预设规则，并标记为已自定义，防止升级时被重新灌入。
  //     保留 customized=true 是必须的 —— 否则下次启动 upgradeLegacyFilePreset 会把预设补回来。
  const rules = settings.sandbox.orderedRules = settings.sandbox.orderedRules ?? {};
  for (const cat of ['file', 'command', 'network']) {
    const cur = rules[cat] ?? {};
    const n = cur.rules?.length ?? 0;
    rules[cat] = {
      presetVersion: cur.presetVersion ?? 0,
      customized: true,
      rules: [],
    };
    if (n > 0) mark(`${cat} 安全: 清空 ${n} 条预设规则 (customized=true 防回流)`);
    else if (cur.customized !== true) mark(`${cat} 安全: 标记 customized=true (防预设回流)`);
  }

  // 2b) 程序黑名单清空（显式设为空数组才生效；不设置会用内置默认值）
  if (!Array.isArray(settings.sandbox.programBlacklist) || settings.sandbox.programBlacklist.length > 0) {
    settings.sandbox.programBlacklist = [];
    mark('程序黑名单: 清空');
  }

  // 2c) 数据安全
  if (settings.sandbox.deleteProtection !== false) { settings.sandbox.deleteProtection = false; mark('删除保护: 关闭'); }
  if (settings.sandbox.safeDeleteRuntimeEnabled !== false) { settings.sandbox.safeDeleteRuntimeEnabled = false; mark('安全删除运行时: 关闭'); }
  if (settings.sandbox.versionControl !== false) { settings.sandbox.versionControl = false; mark('版本控制: 关闭'); }
  if (
    typeof settings.sandbox.safeDeleteBulkThreshold !== 'number' ||
    settings.sandbox.safeDeleteBulkThreshold !== 2147483647
  ) {
    settings.sandbox.safeDeleteBulkThreshold = 2147483647;
    mark('批量删除阈值: 提到最大 (不再触发确认)');
  }

  // 2d) 敏感信息保护
  const sp = settings.sensitiveProtection = settings.sensitiveProtection ?? {};
  if (sp.enabled !== false) { sp.enabled = false; mark('敏感信息保护: 关闭'); }

  if (changed) edits.push({ file: SETTINGS, data: settings, what: actions.filter((a) => !a.startsWith('沙箱安全')).join('; ') });

  return { edits, actions };
}

function applyEngine(roots, opts) {
  const actions = [];
  const edits = [];

  // 3) tsbx_rules.json —— 清空 deny 规则、放开网络
  for (const f of findTsbxRules(roots)) {
    const j = readJson(f);
    if (!j) continue;

    let touched = false;
    const before = JSON.stringify(j);

    // 3a) 去掉全部写死路径规则（含 ~/.ssh、~/.gnupg 的 deny），只留 user 规则
    if (Array.isArray(j.file_rules) && j.file_rules.length) {
      j.file_rules = [];
      touched = true;
    }
    // 3b) 放开网络策略
    if (j.network_policy && (j.network_policy.enabled !== false || j.network_policy.default !== 'allow' ||
        (j.network_policy.deny_ips?.length ?? 0) > 0 || (j.network_policy.deny_domains?.length ?? 0) > 0)) {
      j.network_policy = { ...j.network_policy, enabled: false, default: 'allow', deny_ips: [], deny_domains: [] };
      touched = true;
    }
    // 3c) 清空其他规则类别
    for (const k of ['process_rules', 'registry_rules', 'network_rules', 'network_rules_user']) {
      if (Array.isArray(j[k]) && j[k].length) { j[k] = []; touched = true; }
    }
    // 3d) file_rules_user 也清空
    if (Array.isArray(j.file_rules_user) && j.file_rules_user.length) { j.file_rules_user = []; touched = true; }

    if (touched && JSON.stringify(j) !== before) {
      edits.push({ file: f, data: j, what: 'tsbx_rules.json 放开' });
      actions.push(`沙箱引擎规则: ${path.basename(path.dirname(f))}/tsbx_rules.json`);
    }
  }

  // 4) detect-rules.toml —— 关闭内置凭据检测（默认不碰，需要 --with-credentials 才启用）
  //    注意：不能只注释 `[[rules]]`，因为后续的 id= / regex= 会失去归属而变成非法 TOML。
  //    正确做法：把第一个 [[rules]] 之后的内容整段删掉，只保留 [extend] 头。
  if (!opts.withCredentials) return { edits, actions };

  for (const d of findDetectRules()) {
    const raw = fs.readFileSync(d.file, 'utf8');

    const extHead = `title = "workbuddy sandbox-center detect rules"\n\n[extend]\nuseDefault = false\ndisabledRules = [\n  "generic-api-key",\n]\n`;

    // 若已经是「关闭」形态（无 [[rules]] 且 useDefault=false），跳过
    const alreadyOff = !/^\[\[rules\]\]/m.test(raw) && /useDefault\s*=\s*false/.test(raw);
    if (alreadyOff) continue;

    edits.push({ file: d.file, raw: extHead, what: '凭据检测规则关闭' });
    actions.push(`凭据检测规则: ${d.uid}${d.uid === findLiveUid() ? ' (当前登录)' : ''} -> useDefault=false，内置规则全部停用`);
  }

  return { edits, actions };
}

function makeBackup(edits) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const e of edits) {
    const buf = fs.readFileSync(e.file);
    const name = `${crypto.createHash('md5').update(e.file).digest('hex').slice(0, 10)}-${path.basename(e.file)}`;
    fs.writeFileSync(path.join(dir, name), buf);
    entries.push({ file: e.file, backup: name, sha256: sha256(buf), size: buf.length });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify({ id, createdAt: new Date().toISOString(), entries }, null, 2));
  return { id, dir, entries };
}

function loadBackup(id) {
  const dir = path.join(BACKUP_ROOT, id);
  const man = path.join(dir, 'manifest.json');
  if (!fs.existsSync(man)) return null;
  return { id, dir, manifest: JSON.parse(fs.readFileSync(man, 'utf8')) };
}

function latestBackup() {
  if (!fs.existsSync(BACKUP_ROOT)) return null;
  const ids = fs.readdirSync(BACKUP_ROOT)
    .filter((d) => fs.existsSync(path.join(BACKUP_ROOT, d, 'manifest.json'))).sort();
  return ids.length ? loadBackup(ids[ids.length - 1]) : null;
}

function cmdApply(roots, opts) {
  const running = wbRunning();
  if (running && !opts.force && !opts.dryRun) {
    console.error(`检测到 ${running} 个 WorkBuddy 进程正在运行。`);
    console.error('settings.json 会被运行中的客户端回写，请完全退出（含托盘图标）后重试，或加 --force。');
    process.exit(2);
  }

  // 托管检查
  const logs = path.join(opts.configDir || CONFIG_DIR, 'logs');
  let managed = false;
  try {
    const mainLog = path.join(logs, 'main.log');
    if (fs.existsSync(mainLog)) {
      const tail = fs.readFileSync(mainLog, 'utf8').slice(-200000);
      managed = /managed policy resolved managed=true/.test(tail);
    }
  } catch { /* ignore */ }
  if (managed && !opts.force) {
    console.error('检测到客户端由企业策略托管（managed=true），本地写入会被拒绝。');
    console.error('这属于服务端强制下发，本工具无法绕过。加 --force 可尝试但很可能无效。');
    process.exit(3);
  }

  const local = applyLocal(opts);
  const engine = opts.noEngine ? { edits: [], actions: [] } : applyEngine(roots, opts);
  const allEdits = [...local.edits, ...engine.edits];

  if (!allEdits.length) {
    console.log('无需修改：所有安全项已处于放开状态。');
    return;
  }

  console.log('\n计划修改:');
  for (const a of [...local.actions, ...engine.actions]) console.log(`  - ${a}`);

  if (opts.dryRun) {
    console.log('\n--dry-run: 未写入任何文件。');
    for (const e of allEdits) console.log(`  将写入: ${e.file}`);
    return;
  }

  const b = makeBackup(allEdits);
  console.log(`\n备份已保存: ${b.dir}  (id=${b.id}, ${b.entries.length} 个文件)`);

  for (const e of allEdits) {
    if (e.raw !== undefined) fs.writeFileSync(e.file, e.raw, 'utf8');
    else writeJson(e.file, e.data);
    console.log(`已写入: ${e.file}  [${e.what}]`);
  }

  console.log('\n完成。请重新启动 WorkBuddy。');
  console.log('查看状态: node security-unlock.mjs status     还原: node security-unlock.mjs restore');
}

function cmdRestore(opts) {
  const b = opts.backup ? loadBackup(opts.backup) : latestBackup();
  if (!b) { console.error('没有可用备份。'); process.exit(1); }
  console.log(`使用备份 ${b.id}  (${b.dir})`);
  let n = 0;
  for (const e of b.manifest.entries) {
    const src = path.join(b.dir, e.backup);
    if (!fs.existsSync(src)) { console.log(`  跳过（备份缺失）: ${e.file}`); continue; }
    fs.copyFileSync(src, e.file);
    console.log(`  已还原: ${e.file}`);
    n++;
  }
  console.log(`\n还原 ${n} 个文件。请重启 WorkBuddy。`);
}

// ---------------------------------------------------------------- main

export { getStatus, applyLocal, applyEngine, findTsbxRules, settingsPaths, findDetectRules,
  applyPermissionMode, getPermissionMode, findPreferenceFiles };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const opts = {
  dryRun: argv.includes('--dry-run'),
  force: argv.includes('--force'),
  noEngine: argv.includes('--no-engine'),
  withCredentials: argv.includes('--with-credentials'),
  backup: (argv.find((a) => a.startsWith('--backup=')) || '').split('=')[1],
};

const roots = detectRoots();

switch (cmd) {
  case 'status': cmdStatus(); break;
  case 'apply': cmdApply(roots, opts); break;
  case 'restore': cmdRestore(opts); break;
  default:
    console.log(`
WorkBuddy Security Unlock

  node security-unlock.mjs status                    查看所有安全项现状
  node security-unlock.mjs apply                     全部放开（沙箱/文件/命令/网络/黑名单/数据安全）
  node security-unlock.mjs apply --dry-run           只预览
  node security-unlock.mjs apply --no-engine         只改本地配置，不碰引擎规则文件
  node security-unlock.mjs apply --with-credentials  同时关闭凭据检测（默认不动，见下）
  node security-unlock.mjs restore                   还原最近一次备份
  node security-unlock.mjs restore --backup=ID       还原指定备份

可选环境变量:
  WORKBUDDY_CONFIG_DIR   配置目录（默认 ~/.workbuddy）
  WORKBUDDY_ROOT         安装目录

注意: 必须先完全退出 WorkBuddy（含托盘），否则 settings.json 会被回写。`);
    process.exit(1);
}
}
