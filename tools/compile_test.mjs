/**
 * 对无法完整渲染的模板，只做「编译」验证：
 * 编译能捕获所有语法错误（未闭合的 {% %} / {{ }}、非法标签、引号错误等），
 * 而这正是「改完客户端打不开」的直接原因。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const nunjucks = require(path.join(__dirname, 'node_modules', 'nunjucks', 'index.js'));

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

const env = new nunjucks.Environment(null, { autoescape: false });
let ok = 0, fail = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    // 编译整个文件（不做变量求值，仅语法分析）
    new nunjucks.Template(src, env, path.basename(f), true);
    ok++;
  } catch (err) {
    fail++;
    console.log(`✗ 编译失败: ${f}\n    ${String(err.message).split('\n').slice(0, 3).join('\n    ')}`);
  }
}
console.log(`\n语法编译: 成功 ${ok} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
