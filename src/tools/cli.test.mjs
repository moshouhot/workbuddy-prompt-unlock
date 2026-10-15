import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-'));
const install = path.join(tmp, 'WorkBuddy'), config = path.join(tmp, '.workbuddy');
const prompts = path.join(tmp, 'prompts'), backups = path.join(tmp, 'backup');
const templates = path.join(install, 'resources/app.asar.unpacked/resources/templates');
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
fs.mkdirSync(prompts);
for (const file of fs.readdirSync(path.join(project, 'prompts'))) {
  fs.copyFileSync(path.join(project, 'prompts', file), path.join(prompts, file));
}
const template = '<content_policy>original</content_policy>\r\n<personal_files_safety>original</personal_files_safety>\r\n<windows_command_safety>original</windows_command_safety>\r\n<current_mode>original</current_mode>\r\n';
put(path.join(templates, 'workbuddy-craft-code-prompt.tpl'), template);
put(path.join(templates, 'workbuddy-ask-prompt.tpl'), template);
put(path.join(templates, 'user-context-identity.tpl'), fs.readFileSync(path.join(prompts, 'user_custom.old.txt')));
const product = path.join(install, 'resources/app.asar.unpacked/cli/product.json');
put(product, JSON.stringify({ unchanged: { n: 123 }, prompts: [{ name: 'agent', template: '<content_policy>original</content_policy>\n' + fs.readFileSync(path.join(prompts, 'cli_security_note.old.txt'), 'utf8') }] }, null, 2));
const settings = path.join(config, 'settings.json');
put(settings, JSON.stringify({ keep: 'untouched', sandbox: { orderedRules: { file: { rules: [{ path: 'test' }] } } } }));
put(path.join(config, 'app/app-config.json'), JSON.stringify({ sandboxSafetyEnabled: true, keep: 1 }));
const engine = path.join(install, 'resources/app.asar.unpacked/cli/vendor/sandbox/1/tsbx_rules.json');
put(engine, JSON.stringify({ file_rules: [{ path: 'test' }], file_rules_user: [], network_policy: { enabled: true } }));
// 权限偏好：新任务默认权限模式（“允许完全访问”）。
const prefs = path.join(config, 'storage/user-test-uid-personal/global/preferences.json');
put(prefs, JSON.stringify({ theme: 'light', language: 'zh-CN' }, null, 2) + '\n');
const env = { ...process.env, WORKBUDDY_ROOT: install, WORKBUDDY_CONFIG_DIR: config,
  WORKBUDDY_PROMPTS_DIR: prompts, WORKBUDDY_BACKUP_DIR: backups, WORKBUDDY_STATE_DIR: path.join(tmp, 'state') };
function cli(...args) {
  const r = spawnSync(process.execPath, [path.join(project, 'wb.mjs'), ...args, '--json', '--no-restart'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.error, undefined);
  assert.equal(r.stderr, '', r.stderr);
  const doc = JSON.parse(r.stdout.trim());
  return { ...doc, exit: r.status };
}
test('JSON help, preview, prompt validation, apply + security, edits, undo, conflict, no-op', () => {
  assert.equal(cli('help').ok, true);
  assert.equal(cli('wat').error.code, 'INVALID_COMMAND');
  assert.equal(cli('status', '--wat').error.code, 'INVALID_ARGUMENT');
  assert.equal(cli('status', '--root', path.join(tmp, 'none')).error.code, 'NOT_INSTALLED');
  const before = fs.readFileSync(path.join(templates, 'workbuddy-craft-code-prompt.tpl'));
  assert.ok(cli('preview', '--security').data.pendingChanges >= 7);
  assert.deepEqual(fs.readFileSync(path.join(templates, 'workbuddy-craft-code-prompt.tpl')), before);
  assert.equal(fs.existsSync(backups), false);
  const personal = path.join(prompts, 'personal_files_safety.txt');
  const saved = fs.readFileSync(personal, 'utf8');
  put(personal, '<personal_files_safety>{% invalid %}</personal_files_safety>');
  assert.equal(cli('apply').ok, false);
  assert.deepEqual(fs.readFileSync(path.join(templates, 'workbuddy-craft-code-prompt.tpl')), before);
  put(personal, saved);
  const first = cli('apply', '--security');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.data.backup);
  assert.equal(cli('verify', '--security').ok, true);
  assert.equal(cli('apply', '--security').data.changed, 0);
  assert.equal(JSON.parse(fs.readFileSync(settings)).keep, 'untouched');
  assert.equal(JSON.parse(fs.readFileSync(product)).unchanged.n, 123);
  for (const name of ['content_policy.craft-expert.txt', 'content_policy.ask-legacy.txt', 'content_policy.cli.txt']) {
    const f = path.join(prompts, name);
    put(f, fs.readFileSync(f, 'utf8').replace('</content_policy>', () => 'custom $& $1 $$\n</content_policy>'));
  }
  put(path.join(prompts, 'user_custom.new.txt'), 'Updated custom instructions $&.');
  put(path.join(prompts, 'cli_security_note.new.txt'), 'Updated tool note $&.');
  assert.equal(cli('verify').error.code, 'NOT_APPLIED');
  const second = cli('apply');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.data.changed, 4);
  assert.ok(fs.readFileSync(path.join(templates, 'workbuddy-craft-code-prompt.tpl'), 'utf8').includes('custom $& $1 $$'));
  assert.equal(fs.readFileSync(path.join(templates, 'user-context-identity.tpl'), 'utf8').trimEnd(), 'Updated custom instructions $&.');
  assert.ok(JSON.parse(fs.readFileSync(product)).prompts[0].template.includes('Updated tool note $&.'));
  assert.equal(cli('apply').data.changed, 0);
  assert.equal(cli('restore', '--dry-run').ok, true);
  assert.equal(cli('restore').data.undone, second.data.backup);
  assert.equal(cli('verify').ok, false); // User files remain edited; restored targets are the previous content.
  put(path.join(templates, 'user-context-identity.tpl'), 'another application modified this');
  assert.equal(cli('restore').error.code, 'RESTORE_CONFLICT');
  assert.equal(cli('prompts').data.files.filter((f) => f.editable).length, 9);
  assert.equal(cli('backups').data.backups.length, 3); // apply, apply, restore
});

test('status reports needApply verdict, client version, and upgrade attribution', () => {
  // 复位为“内容不同步”：目标模板恢复为官方内容。
  put(path.join(templates, 'workbuddy-craft-code-prompt.tpl'), template);
  const s1 = cli('status').data;
  // 判定字段必须与 pendingChanges 一致，界面直接拿它显示“要不要点一键应用”。
  assert.equal(typeof s1.needApply, 'boolean');
  assert.equal(s1.needApply, s1.pendingChanges > 0);
  assert.equal(s1.needApply, true);
  // 本次没改过客户端版本，应归因为“改了提示词”，而不是谎称升级。
  assert.equal(s1.applyReason, 'prompt-changed');
  assert.equal(typeof s1.clientVersions, 'object');
  // 前面的用例已 apply 过，所以此处 appliedVersions 可能已有指纹；只要求类型正确。
  assert.ok(s1.appliedVersions === null || typeof s1.appliedVersions === 'object');
  assert.ok(Array.isArray(s1.upgraded));

  // 应用后应变为已同步，并记录本次的客户端版本指纹。
  assert.equal(cli('apply').ok, true);
  const s2 = cli('status').data;
  assert.equal(s2.pendingChanges, 0);
  assert.equal(s2.needApply, false);
  assert.equal(s2.applyReason, 'in-sync');
  assert.equal(s2.upgraded.length, 0);

  // 模拟客户端升级：换掉插件缓存版本目录名，同时让内容保持同步。
  // 关键约束：版本指纹变了但内容已同步时，不得谎报“需要重新应用”。
  // 先应用一次，使模板与缓存都进入已同步状态。
  const cacheBase = path.join(config, 'plugins/cache/workbuddy-builtin/welcomemode-code');
  fs.rmSync(cacheBase, { recursive: true, force: true });
  put(path.join(cacheBase, '5.8.2-wb.1.aaa/prompt.tpl'), template);
  assert.equal(cli('apply').ok, true);
  assert.equal(cli('status').data.needApply, false);
  // 现在仅把版本目录名换成新版本（内容逐字节相同）——等价于升级后缓存被重建但内容已同步。
  fs.renameSync(path.join(cacheBase, '5.8.2-wb.1.aaa'), path.join(cacheBase, '5.9.9-wb.99999999.gdeadbeef.hcafebabe'));
  const s3 = cli('status').data;
  assert.equal(s3.needApply, false, 'content is in sync: must not raise a false alarm after upgrade');
  assert.equal(s3.applyReason, 'in-sync');
  assert.equal(s3.upgraded.length, 1, 'version drift should still be reported for explanation');
  assert.match(s3.upgraded[0].from, /^5\./);
  assert.equal(s3.upgraded[0].to, '5.9.9-wb.99999999.gdeadbeef.hcafebabe');

  // 升级后又把模板改回官方内容（真实升级会覆盖模板）：应归因为升级。
  put(path.join(templates, 'workbuddy-craft-code-prompt.tpl'), template);
  const s4 = cli('status').data;
  assert.equal(s4.needApply, true);
  assert.equal(s4.applyReason, 'upgraded');

  // 收尾：应用一次并清理升级模拟，把基线还原给后续用例（它们假设内容不同步）。
  assert.equal(cli('apply').ok, true);
  fs.rmSync(cacheBase, { recursive: true, force: true });
  put(path.join(cacheBase, '5.8.2-wb.1.aaa/prompt.tpl'), template);
  assert.equal(cli('apply').ok, true);
  // 还原为“待同步”基线：模板回到官方内容。
  put(path.join(templates, 'workbuddy-craft-code-prompt.tpl'), template);
});

test('full access preference defaults on, preserves sibling fields, and can be disabled', () => {
  // 前面的测试已 apply 过，先重置为关闭，让本测试自包含。
  const base = { theme: 'light', language: 'zh-CN', localTaskPermissionMode: 'default-sandbox' };
  put(prefs, JSON.stringify(base, null, 2) + '\n');
  assert.equal(cli('status').data.security.fullAccess, false);

  // 默认（不带任何参数）应把偏好列入待写入；--no-full-access 则不列入。
  const planned = (res) => res.data.changes.some((c) => c.file === prefs);
  assert.equal(planned(cli('preview')), true);
  assert.equal(planned(cli('preview', '--no-full-access')), false);
  assert.equal(JSON.parse(fs.readFileSync(prefs, 'utf8')).localTaskPermissionMode, 'default-sandbox'); // 预览不写入

  // 实际应用：开启，且保留同文件其他字段。
  assert.ok(cli('apply', '--install=WorkBuddy').ok);
  const written = JSON.parse(fs.readFileSync(prefs, 'utf8'));
  assert.equal(written.localTaskPermissionMode, 'full-access');
  assert.equal(written.theme, 'light');
  assert.equal(written.language, 'zh-CN');
  assert.equal(cli('status').data.security.fullAccess, true);
  assert.equal(cli('apply', '--install=WorkBuddy').data.changed, 0); // 已开启则不重复写

  // 收尾：撤销本次 apply，让后续测试仍有待写入的模板改动。
  assert.equal(cli('restore').ok, true);
  assert.equal(JSON.parse(fs.readFileSync(prefs, 'utf8')).localTaskPermissionMode, 'default-sandbox');
  assert.equal(cli('status').data.security.fullAccess, false);
});

test('full access covers enterprise account dirs, not just -personal', () => {
  // 客户端目录名规则（app.asar 中 userStorageDirName）：
  //     user-<uid>-<enterpriseId || personal>
  // 企业账号是 user-<uid>-<企业短名>，不以 -personal 结尾。
  // 旧实现只匹配 /-personal$/，企业账号被静默跳过：工具报「已开启」，客户端仍显示“默认权限”。
  const entPrefs = path.join(config, 'storage/user-ent-uid-1acme/global/preferences.json');
  put(entPrefs, JSON.stringify({ theme: 'dark', localTaskPermissionMode: 'default-sandbox' }, null, 2) + '\n');
  // 该账号没有偏好文件：不得被当成“需要新建”，也不得导致报错。
  const noFileDir = path.join(config, 'storage/user-other-uid-2beta/global');
  fs.mkdirSync(noFileDir, { recursive: true });
  put(prefs, JSON.stringify({ theme: 'light', localTaskPermissionMode: 'default-sandbox' }, null, 2) + '\n');

  assert.equal(cli('status').data.security.fullAccess, false);
  assert.ok(cli('apply', '--install=WorkBuddy').ok);

  // 企业账号目录必须被写入，且保留同文件其他字段。
  const ent = JSON.parse(fs.readFileSync(entPrefs, 'utf8'));
  assert.equal(ent.localTaskPermissionMode, 'full-access');
  assert.equal(ent.theme, 'dark');
  // 个人账号目录同样被写入。
  assert.equal(JSON.parse(fs.readFileSync(prefs, 'utf8')).localTaskPermissionMode, 'full-access');
  // 没有偏好文件的账号目录不得被新建出来。
  assert.equal(fs.existsSync(path.join(noFileDir, 'preferences.json')), false);
  assert.equal(cli('status').data.security.fullAccess, true);

  // 收尾：撤销本次 apply，并移除本测试新增的企业账号目录。
  assert.equal(cli('restore').ok, true);
  assert.equal(JSON.parse(fs.readFileSync(entPrefs, 'utf8')).localTaskPermissionMode, 'default-sandbox');
  assert.equal(JSON.parse(fs.readFileSync(prefs, 'utf8')).localTaskPermissionMode, 'default-sandbox');
  fs.rmSync(path.join(config, 'storage/user-ent-uid-1acme'), { recursive: true, force: true });
  fs.rmSync(path.join(config, 'storage/user-other-uid-2beta'), { recursive: true, force: true });
});

test('ui preferences default to both on, and are remembered across runs', () => {
  const prefs = path.join(tmp, 'state', 'ui-preferences.json');
  if (fs.existsSync(prefs)) fs.unlinkSync(prefs);
  // 首次运行：无记忆文件 → 两个都开启。
  assert.deepEqual(cli('ui-state').data, { remember: false, fullAccess: true, includeSecurity: true });
  // 保存一次 → 回读保持一致。
  assert.equal(cli('ui-remember', '--state={"fullAccess":false,"includeSecurity":false}').ok, true);
  assert.deepEqual(cli('ui-state').data, { remember: true, fullAccess: false, includeSecurity: false });
  // 只改一项时另一项保留。
  assert.equal(cli('ui-remember', '--state={"fullAccess":true}').ok, true);
  assert.deepEqual(cli('ui-state').data, { remember: true, fullAccess: true, includeSecurity: false });
  // 非法 JSON 报错，不写入。
  assert.equal(cli('ui-remember', '--state=not-json').error.code, 'INVALID_ARGUMENT');
  assert.equal(cli('ui-remember').error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(cli('ui-state').data, { remember: true, fullAccess: true, includeSecurity: false });
  fs.unlinkSync(prefs);
  assert.deepEqual(cli('ui-state').data, { remember: false, fullAccess: true, includeSecurity: true });
});

test('locking, managed policy, missing config and missing history are explicit errors', () => {
  const lock = path.join(tmp, 'state/operation.lock');
  put(lock, 'test');
  assert.equal(cli('apply').error.code, 'BUSY'); fs.unlinkSync(lock);
  const log = path.join(config, 'logs/main.log');
  put(log, 'managed policy resolved managed=true');
  assert.equal(cli('preview', '--security').error.code, 'MANAGED_CLIENT');
  put(log, 'managed policy resolved managed=true\nmanaged policy resolved managed=false');
  assert.equal(cli('preview', '--security').ok, true);
  const appConfig = path.join(config, 'app/app-config.json');
  fs.renameSync(appConfig, appConfig + '.bak');
  assert.equal(cli('preview', '--security').error.code, 'MISSING_CONFIG');
  fs.renameSync(appConfig + '.bak', appConfig);
  const custom = path.join(templates, 'user-context-identity.tpl');
  const before = fs.readFileSync(custom);
  put(custom, 'The user has provided custom instructions, but this text has no known history.');
  assert.equal(cli('verify').error.code, 'UNSUPPORTED_TEMPLATE');
  put(custom, before);
});

test('real Windows sharing violation on second write rolls back the first write', { skip: process.platform !== 'win32' }, async () => {
  const file = path.join(templates, 'workbuddy-craft-code-prompt.tpl');
  const ready = path.join(tmp, 'ready');
  const escape = (s) => s.replace(/'/g, "''");
  const script = `$f=[IO.File]::Open('${escape(file)}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [IO.File]::WriteAllText('${escape(ready)}','ready'); Start-Sleep -Seconds 90; $f.Dispose()`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(ready), true);
    const ask = path.join(templates, 'workbuddy-ask-prompt.tpl');
    const before = fs.readFileSync(ask);
    const result = cli('apply');
    assert.equal(result.error.code, 'APPLY_FAILED', JSON.stringify(result));
    assert.deepEqual(fs.readFileSync(ask), before);
    assert.equal(cli('backups').data.backups.at(-1).status, 'rolled-back');
  } finally {
    const exited = new Promise((r) => holder.once('exit', r)); holder.kill(); await exited;
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
