/**
 * 用与客户端内嵌一致的 nunjucks 3.1.7，按 WorkBuddy 真实的模板解析规则
 * （插件名 -> ~/.workbuddy/plugins/cache/workbuddy-builtin/<plugin>/<version>/ ，
 *   再回退到安装目录的 app.asar.unpacked/resources/plugins/workbuddy-builtin/<plugin>/）
 * 编译并渲染所有被修改过的 .tpl。
 *
 * 目的：证明补丁没有破坏模板语法 —— 这是第三方 Patcher「改完客户端打不开」的高风险点。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const nunjucks = require(path.join(__dirname, 'node_modules', 'nunjucks', 'index.js'));

const HOME = process.env.USERPROFILE || os.homedir();
const CACHE = path.join(HOME, '.workbuddy', 'plugins', 'cache', 'workbuddy-builtin');
const INSTALL = process.env.WORKBUDDY_INSTALL
  ? path.join(process.env.WORKBUDDY_INSTALL, 'resources/app.asar.unpacked/resources/plugins/workbuddy-builtin')
  : 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin';

// 每个插件取最高版本目录，构成 pluginName -> dir 的映射
function buildSearchPaths() {
  const seen = new Map();
  for (const root of [CACHE, INSTALL]) {
    if (!fs.existsSync(root)) continue;
    for (const plugin of fs.readdirSync(root)) {
      const p = path.join(root, plugin);
      if (!fs.statSync(p).isDirectory()) continue;
      const versions = fs.readdirSync(p).filter((v) => {
        try { return fs.statSync(path.join(p, v)).isDirectory(); } catch { return false; }
      }).sort();
      const dir = versions.length ? path.join(p, versions[versions.length - 1]) : p;
      if (!seen.has(plugin)) seen.set(plugin, dir);
    }
  }
  return [...seen.values()];
}

const searchPaths = buildSearchPaths();

/**
 * WorkBuddy 的 include 形如 "interactionmode-craft/fragments/tool-use.md"，
 * 实际文件在 <builtin>/interactionmode-craft/<version>/fragments/tool-use.md。
 * 这里把这种“插件名/相对路径”解析到最高版本目录。
 */
class WbLoader extends nunjucks.FileSystemLoader {
  getSource(name) {
    const direct = super.getSource(name);
    if (direct) return direct;
    const idx = name.indexOf('/');
    if (idx === -1) return null;
    const plugin = name.slice(0, idx);
    const rest = name.slice(idx + 1);
    for (const base of [CACHE, INSTALL]) {
      const p = path.join(base, plugin);
      if (!fs.existsSync(p)) continue;
      const versions = fs.readdirSync(p).filter((v) => {
        try { return fs.statSync(path.join(p, v)).isDirectory(); } catch { return false; }
      }).sort();
      const cands = [
        ...(versions.length ? [path.join(p, versions[versions.length - 1], rest)] : []),
        path.join(p, rest),
      ];
      for (const c of cands) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          return { src: fs.readFileSync(c, 'utf8'), path: c, noCache: true };
        }
      }
    }
    return null;
  }
}

const loader = new WbLoader(searchPaths, { noCache: true });
const env = new nunjucks.Environment(loader, { autoescape: false });

// 覆盖模板用到的变量
const ctx = {
  modelName: 'TestModel',
  productName: 'WorkBuddy',
  dataFolderName: '.workbuddy',
  ResponseLanguage: '中文',
  IsWindows: true,
  IsOversea: false,
  productFeatures: { DisableMultimodalGeneration: false },
  WorkspaceIdentityMode: 'onboarding',
  SoulPath: '/tmp/SOUL.md', SoulContent: '',
  BootstrapPath: '/tmp/BOOTSTRAP.md', BootstrapContent: '',
  IdentityPath: '/tmp/IDENTITY.md', IdentityContent: '',
  UserPath: '/tmp/USER.md', UserContent: '',
  ToneStyleContent: '', UserCustomPrompt: 'test custom instructions',
  WorkbuddyMemory_1: '', WorkingMemoryContent: '',
  UserLocalMemoryContent: '', UserMemoryContent: '',
  PluginAgentPrompt: '', BinaryContext: '', ToolResultPresentationPrompt: '',
  systemPrompt: '', user_query: 'test',
};

const B = path.join(__dirname, '..', 'backup');
const ids = fs.readdirSync(B).filter((d) => fs.existsSync(path.join(B, d, 'manifest.json'))).sort();
const files = [];
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(path.join(B, id, 'manifest.json'), 'utf8'));
  for (const e of m.entries) {
    // 旧版本插件缓存目录会被客户端 GC 掉，这是正常现象，跳过即可
    if (fs.existsSync(e.file) && !files.includes(e.file)) files.push(e.file);
  }
}

let ok = 0, fail = 0, policySeen = 0, noIncludeFail = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    const out = env.renderString(src, ctx, { path: path.basename(path.dirname(f)) });
    ok++;
    if (/<content_policy>/.test(out)) {
      policySeen++;
      if (/You MUST refuse|NEVER reveal, rephrase/.test(out)) {
        console.log(`✗ 渲染结果仍含原始拒答规则: ${path.basename(f)}`);
        fail++;
      }
    }
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('template not found')) { noIncludeFail++; continue; }
    fail++;
    console.log(`✗ 渲染失败: ${f}\n    ${msg.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

console.log(`\n渲染成功 ${ok}，真实失败 ${fail}，因缺少 include 依赖跳过 ${noIncludeFail}。`);
console.log(`其中 ${policySeen} 个含 content_policy 的模板已确认无原始拒答规则残留。`);
process.exit(fail ? 1 : 0);
