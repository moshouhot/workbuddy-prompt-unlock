#!/usr/bin/env node
/** AI-facing JSON CLI. The WPF UI calls this same entry point. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { detectRoots, allTargets, planFor, planForJson, loadPrompt, PROMPTS_DIR, CONFIG_DIR,
  configDirForRoot, configDirsForRoots } from './unlock.mjs';
import { getStatus, applyLocal, applyEngine, settingsPaths } from './security-unlock.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.WORKBUDDY_STATE_DIR || path.join(ROOT, '.state');
const BACKUPS = process.env.WORKBUDDY_BACKUP_DIR || path.join(ROOT, 'backup');
const HISTORY = path.join(STATE, 'prompt-history.json');
const require = createRequire(import.meta.url);
const nunjucks = require('./tools/node_modules/nunjucks');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const names = [
  'content_policy.craft-expert.txt', 'content_policy.ask-legacy.txt', 'content_policy.cli.txt',
  'personal_files_safety.txt', 'windows_command_safety.txt', 'ask_mode.current_mode.txt',
  'ask_mode.reminder.txt', 'cli_security_note.old.txt', 'cli_security_note.new.txt',
  'user_custom.old.txt', 'user_custom.new.txt',
];
function error(code, message) { return Object.assign(new Error(message), { code }); }
function atomicWrite(file, bytes) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function history() { return fs.existsSync(HISTORY) ? readJson(HISTORY) : {}; }
function recordPrompts() {
  const prev = history();
  for (const name of names) prev[name] = [...new Set([...(prev[name] || []), loadPrompt(name)])];
  atomicWrite(HISTORY, JSON.stringify(prev, null, 2));
}
function validatePrompts() {
  for (const name of names) {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, name));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (raw.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) throw error('INVALID_PROMPT', `${name}: 请保存为 UTF-8 无 BOM`);
    if (!text.trim()) throw error('INVALID_PROMPT', `${name}: 提示词不能为空`);
    const tag = name.startsWith('content_policy.') ? 'content_policy' :
      name === 'personal_files_safety.txt' ? 'personal_files_safety' :
      name === 'windows_command_safety.txt' ? 'windows_command_safety' :
      name === 'ask_mode.current_mode.txt' ? 'current_mode' : name === 'ask_mode.reminder.txt' ? 'ask_mode' : null;
    if (tag && ((text.match(new RegExp(`<${tag}>`, 'g')) || []).length !== 1 ||
      (text.match(new RegExp(`</${tag}>`, 'g')) || []).length !== 1)) {
      throw error('INVALID_PROMPT', `${name}: 必须保留一对 <${tag}> 标签`);
    }
    nunjucks.compile(text, undefined, name, true); // Eager syntax compilation, without rendering.
  }
}
function jsonBytes(file, data) {
  const nl = fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  return Buffer.from((JSON.stringify(data, null, 2) + '\n').replace(/\n/g, nl));
}
/**
 * 将 roots 与各自的配置目录配对：[{ root, configDir }]。
 * 未显式 --config 时，WorkBuddy -> ~/.workbuddy，WorkBuddyAI -> ~/.workbuddy-ai。
 */
function targetsFor(roots, options) {
  if (options.config) return roots.map((root) => ({ root, configDir: options.config }));
  return roots.map((root) => ({ root, configDir: configDirForRoot(root) }));
}

function configDirs(roots, options) {
  if (options.config) return [options.config];
  return configDirsForRoots(roots);
}
function plan(roots, options) {
  validatePrompts();
  const previousPrompts = history();
  const edits = [];
  const dirs = configDirs(roots, options);
  const targets = allTargets(roots, { configDirs: dirs });
  if (!targets.length) throw error('NO_TARGETS', '安装目录中没有可处理的提示词文件');
  for (const t of targets) {
    let p;
    try { p = t.kind === 'cli' ? planForJson(t.file, { full: true, previousPrompts, strictPairs: true }) :
      planFor(t.file, { full: true, previousPrompts, strictPairs: true }); }
    catch (e) { throw error('UNSUPPORTED_TEMPLATE', `${t.file}: ${e.message}`); }
    if (t.kind === 'cli') {
      const doc = JSON.parse(p.text);
      if (!Array.isArray(doc.prompts)) throw error('INVALID_TARGET', `缺少 prompts 数组: ${t.file}`);
      for (const item of doc.prompts) if (typeof item.template === 'string') nunjucks.compile(item.template, undefined, item.name, true);
    } else nunjucks.compile(p.text, undefined, t.file, true);
    if (p.raw !== p.text) edits.push({ file: t.file, bytes: Buffer.from(p.text), actions: p.actions });
  }
  if (options.security) {
    // 每个配置目录单独检查托管状态并写入，避免只放开其中一套。
    // 显式指定的配置目录缺文件时报错；自动配对时目录不存在则跳过（该安装未使用）。
    const explicitConfig = Boolean(options.config || process.env.WORKBUDDY_CONFIG_DIR);
    for (const dir of dirs) {
      checkManaged(dir);
      for (const file of [path.join(dir, 'settings.json'), path.join(dir, 'app', 'app-config.json')]) {
        if (!fs.existsSync(file)) {
          if (explicitConfig) throw error('MISSING_CONFIG', `缺少安全配置，未写入: ${file}`);
          continue;
        }
        readJson(file);
      }
    }
    for (const dir of dirs) {
      const { settings, appConfig } = settingsPaths(dir);
      if (!fs.existsSync(settings) && !fs.existsSync(appConfig)) continue;
      const a = applyLocal({ configDir: dir });
      for (const e of a.edits) edits.push({ file: e.file,
        bytes: e.raw === undefined ? jsonBytes(e.file, e.data) : Buffer.from(e.raw), actions: [e.what] });
    }
    const b = applyEngine(roots, { withCredentials: false });
    for (const e of b.edits) edits.push({ file: e.file,
      bytes: e.raw === undefined ? jsonBytes(e.file, e.data) : Buffer.from(e.raw), actions: [e.what] });
  }
  return edits;
}
function checkManaged(configDir = CONFIG_DIR) {
  const f = path.join(configDir, 'logs', 'main.log');
  if (!fs.existsSync(f)) return;
  const matches = [...fs.readFileSync(f, 'utf8').slice(-200000).matchAll(/managed policy resolved managed=(true|false)/g)];
  if (matches.at(-1)?.[1] === 'true') throw error('MANAGED_CLIENT', `企业托管配置不可用此工具更改: ${configDir}`);
}
/**
 * 列出所有发现的安装及其配对配置目录，供 UI 勾选。
 */
function allInstalls(options) {
  return targetsFor(detectRoots(), options).map(({ root, configDir }) => ({
    name: path.basename(root),
    root,
    configDir,
    configExists: fs.existsSync(path.join(configDir, 'settings.json')),
    promptTargets: allTargets([root], { configDirs: [configDir] }).length,
  }));
}

/** 按 --install 过滤安装：优先目录名精确匹配，其次才做路径子串匹配。 */
function selectRoots(roots, options) {
  if (!options.install) return roots;
  const wanted = options.install.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = [];
  for (const w of wanted) {
    const exact = roots.filter((r) => path.basename(r).toLowerCase() === w);
    if (exact.length) { for (const r of exact) if (!picked.includes(r)) picked.push(r); continue; }
    // “WorkBuddy” 不能因此匹配 “WorkBuddyAI”，所以子串匹配只在无精确命中时用。
    for (const r of roots) if (r.toLowerCase().includes(w) && !picked.includes(r)) picked.push(r);
  }
  if (!picked.length) throw error('INVALID_ARGUMENT', `--install 未匹配到已发现的安装: ${options.install}；可用: ${roots.map((r) => path.basename(r)).join(', ')}`);
  return picked;
}

function processes(roots) {
  if (process.platform !== 'win32') return [];
  const script = "@(Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe' OR Name='WorkBuddyAI.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress";
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
  const list = raw ? JSON.parse(raw) : [];
  const allowed = new Set(roots.flatMap((r) => ['WorkBuddy.exe', 'WorkBuddyAI.exe'].map((e) => path.join(r, e).toLowerCase())));
  return (Array.isArray(list) ? list : [list]).filter((p) => p.ExecutablePath && allowed.has(p.ExecutablePath.toLowerCase()));
}
function stopClients(roots, options) {
  const running = processes(roots);
  if (running.length && !options.close) throw error('CLIENT_RUNNING', '请退出 WorkBuddy，或加 --close 自动关闭客户端（请先保存工作）');
  // Target exact processes under the discovered installation, not every same-name process.
  for (const p of running) {
    try { execFileSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'pipe', timeout: 10000 }); }
    catch (e) { if (processes(roots).some((x) => x.ProcessId === p.ProcessId)) throw e; }
  }
  if (processes(roots).length) throw error('CLIENT_RUNNING', '客户端未完全退出，未写入补丁');
  return [...new Set(running.map((p) => p.ExecutablePath))];
}
function restartClients(roots, previous, options) {
  if (options.noRestart) return [];
  const exes = previous.length ? previous : options.restart ? roots.flatMap((r) =>
    ['WorkBuddy.exe', 'WorkBuddyAI.exe'].map((e) => path.join(r, e))).filter(fs.existsSync).slice(0, 1) : [];
  for (const exe of exes) {
    const p = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    p.on('error', () => {}); p.unref();
  }
  return exes;
}
function manifests() {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs.readdirSync(BACKUPS).sort().flatMap((id) => {
    const f = path.join(BACKUPS, id, 'manifest.json');
    if (!fs.existsSync(f)) return [];
    const m = readJson(f);
    return m.kind === 'unified' ? [{ ...m, dir: path.dirname(f) }] : [];
  });
}
function snapshot(edits, operation) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const dir = path.join(BACKUPS, id); fs.mkdirSync(dir, { recursive: true });
  const entries = edits.map((e, i) => {
    const bytes = fs.readFileSync(e.file), backup = `${i}-${path.basename(e.file)}`;
    fs.writeFileSync(path.join(dir, backup), bytes);
    return { file: e.file, backup, sha256: sha(bytes), appliedSha256: sha(e.bytes), size: bytes.length };
  });
  const m = { id, kind: 'unified', operation, status: 'pending', createdAt: new Date().toISOString(), entries };
  atomicWrite(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return { ...m, dir };
}
function saveManifest(m) {
  const { dir, ...doc } = m;
  atomicWrite(path.join(dir, 'manifest.json'), JSON.stringify(doc, null, 2));
}
function transaction(edits, operation, afterWrite) {
  if (!edits.length) { afterWrite(); return null; }
  const m = snapshot(edits, operation);
  const written = [];
  try {
    for (let i = 0; i < edits.length; i++) { atomicWrite(edits[i].file, edits[i].bytes); written.push(m.entries[i]); }
    for (let i = 0; i < edits.length; i++) if (sha(fs.readFileSync(edits[i].file)) !== m.entries[i].appliedSha256)
      throw error('VERIFY_FAILED', `写入校验失败: ${edits[i].file}`);
    afterWrite(); m.status = 'applied'; saveManifest(m); return m.id;
  } catch (e) {
    const failures = [];
    for (const b of written.reverse()) {
      try { atomicWrite(b.file, fs.readFileSync(path.join(m.dir, b.backup))); }
      catch (rollback) { failures.push(`${b.file}: ${rollback.message}`); }
    }
    m.status = failures.length ? 'rollback-failed' : 'rolled-back'; saveManifest(m);
    throw error('APPLY_FAILED', `${e.message}; ${failures.length ? '回滚失败: ' + failures.join('; ') : '文件已自动回滚'}; 备份 ${m.id}`);
  }
}
function withLock(action) {
  fs.mkdirSync(STATE, { recursive: true });
  const lock = path.join(STATE, 'operation.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch { throw error('BUSY', `已有操作或上次异常退出留下锁: ${lock}。确认无操作正在运行后可删除此锁。`); }
  try {
    fs.writeFileSync(fd, String(process.pid));
    const pending = manifests().find((m) => m.status === 'pending' || m.status === 'rollback-failed');
    if (pending) throw error('RECOVERY_REQUIRED', `上次操作未完成，停止自动写入；请从备份 ${pending.id} 恢复`);
    return action();
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function restore(options, roots) {
  return withLock(() => {
    const ms = manifests();
    const m = options.backup ? ms.find((b) => b.id === options.backup) : ms.filter((b) => b.operation === 'apply' && b.status === 'applied').at(-1);
    if (!m || m.status !== 'applied' || m.operation !== 'apply') throw error('NO_BACKUP', '没有可撤销的一键应用备份（旧脚本备份仍保留，未混用）');
    const edits = m.entries.map((e) => {
      const bytes = fs.readFileSync(path.join(m.dir, e.backup));
      if (sha(bytes) !== e.sha256) throw error('BACKUP_CORRUPT', `备份损坏: ${e.file}`);
      if (!fs.existsSync(e.file) || sha(fs.readFileSync(e.file)) !== e.appliedSha256)
        throw error('RESTORE_CONFLICT', `应用后文件已被升级或其他程序修改，未覆盖: ${e.file}`);
      return { file: e.file, bytes, actions: ['撤销上次应用'] };
    });
    if (options.dryRun) return { backup: m.id, changes: edits.map(({ bytes, ...e }) => e), dryRun: true };
    const previous = stopClients(roots, options);
    try {
      for (const e of m.entries) if (sha(fs.readFileSync(e.file)) !== e.appliedSha256)
        throw error('RESTORE_CONFLICT', `客户端退出时回写了文件，未覆盖: ${e.file}`);
      const id = transaction(edits, 'restore', () => {});
      m.status = 'undone'; saveManifest(m);
      return { restored: edits.length, backup: id, undone: m.id, restarted: restartClients(roots, previous, options) };
    } catch (e) { restartClients(roots, previous, options); throw e; }
  });
}
function run(command, options) {
  // --install 只处理勾选的安装（按目录名或路径子串匹配），默认全部。
  const roots = selectRoots(detectRoots(), options);
  if (command === 'prompts') return { directory: PROMPTS_DIR, files: names.map((name) => ({ name, path: path.join(PROMPTS_DIR, name), editable: !name.endsWith('.old.txt') })) };
  if (command === 'init') return withLock(() => { validatePrompts(); recordPrompts(); return { initialized: true }; });
  if (command === 'backups') return { backups: manifests().map(({ dir, entries, ...m }) => ({ ...m, count: entries.length })) };
  if (command === 'installs') return { installs: allInstalls(options) };
  if (!roots.length) throw error('NOT_INSTALLED', '未找到安装目录；使用 --root "D:\\Program Files\\WorkBuddy" 指定');
  if (command === 'restore') return restore(options, roots);
  const inspect = () => {
    const edits = plan(roots, options);
    const dirs = configDirs(roots, options);
    const s = getStatus(dirs[0] ?? CONFIG_DIR);
    const installs = targetsFor(roots, options).map(({ root, configDir }) => ({
      name: path.basename(root),
      root,
      configDir,
      configExists: fs.existsSync(path.join(configDir, 'settings.json')) || fs.existsSync(path.join(configDir, 'app', 'app-config.json')),
      promptTargets: allTargets([root], { configDirs: [configDir] }).length,
    }));
    return { roots, installs, promptDirectory: PROMPTS_DIR,
      targetCount: allTargets(roots, { configDirs: dirs }).length,
      pendingChanges: edits.length, changes: edits.map(({ bytes, ...e }) => e),
      security: { sandboxSafetyEnabled: s.sandboxSafetyEnabled ?? null, fileRules: s.fileRules,
        commandRules: s.commandRules, networkRules: s.networkRules,
        programBlacklist: s.programBlacklist ?? null, deleteProtection: s.deleteProtection ?? null },
      latestBackup: manifests().filter((m) => m.operation === 'apply' && m.status === 'applied').at(-1)?.id ?? null };
  };
  if (['status', 'preview', 'verify'].includes(command)) {
    const data = inspect();
    if (command === 'verify' && data.pendingChanges) throw Object.assign(error('NOT_APPLIED', `还有 ${data.pendingChanges} 个文件与当前提示词/选项不一致`), { data });
    return data;
  }
  if (command !== 'apply') throw error('INVALID_COMMAND', `未知命令: ${command}`);
  if (options.dryRun) return { ...inspect(), dryRun: true };
  return withLock(() => {
    plan(roots, options); // Validate BEFORE closing the user's client.
    const previous = stopClients(roots, options);
    try {
      const edits = plan(roots, options); // Re-read after the client has flushed its settings.
      const backup = transaction(edits, 'apply', () => {
        if (plan(roots, options).length) throw error('VERIFY_FAILED', '应用后仍有未同步文件');
        recordPrompts();
      });
      return { changed: edits.length, backup, restarted: restartClients(roots, previous, options),
        message: edits.length ? '已应用并校验；新会话使用新提示词' : '已是当前提示词，无需改动' };
    } catch (e) { restartClients(roots, previous, options); throw e; }
  });
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const command = args.find((a) => !a.startsWith('-')) || 'help';
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// Environment options are set before imports only when supplied by the tiny launcher below.
const options = { security: flag('security'), close: flag('close'), restart: flag('restart'), noRestart: flag('no-restart'), dryRun: flag('dry-run'), backup: value('backup'), install: value('install'), config: value('config') };
try {
  const allowed = new Set(['--json', '--security', '--close', '--restart', '--no-restart', '--dry-run']);
  for (const a of args.filter((a) => a.startsWith('-'))) if (!allowed.has(a) && !/^--(backup|install|config)=/.test(a)) throw error('INVALID_ARGUMENT', `未知参数: ${a}`);
  if (command === 'help' || command === '--help') {
    const data = { commands: ['status', 'preview', 'apply', 'verify', 'restore', 'prompts', 'backups', 'installs', 'init'],
      examples: ['node wb.mjs status --json', 'node wb.mjs installs --json',
        'node wb.mjs apply --install=WorkBuddy --close --restart --json',
        'node wb.mjs apply --close --restart --json',
        'node wb.mjs apply --security --close --restart --json', 'node wb.mjs restore --close --json'],
      flags: ['--install=NAME', '--root=PATH', '--config=PATH', '--json', '--security', '--close', '--restart', '--no-restart', '--dry-run', '--backup=ID'],
      notes: '默认处理全部安装及各自配置目录；--install 只处理勾选的安装（WorkBuddy / WorkBuddyAI，逗号分隔）；--security 可选更改本地安全配置，保留凭据检测；restore 撤销最近一次一键应用，不声称恢复官方原版。' };
    console.log(json ? JSON.stringify({ ok: true, data }) : JSON.stringify(data, null, 2));
  } else {
    const data = run(command, options);
    console.log(JSON.stringify({ ok: true, command, data }, null, json ? undefined : 2));
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, command, error: { code: e.code || 'ERROR', message: e.message }, ...(e.data ? { data: e.data } : {}) }, null, json ? undefined : 2));
  process.exitCode = 1;
}
