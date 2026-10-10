#!/usr/bin/env node
// Stable entry point: bind paths before importing the existing engines.
const args = process.argv.slice(2);
const mappings = { root: 'WORKBUDDY_ROOT', config: 'WORKBUDDY_CONFIG_DIR' };
const rest = [];
for (let i = 0; i < args.length; i++) {
  const match = args[i].match(/^--(root|config)(?:=(.*))?$/);
  if (!match) { rest.push(args[i] === '--help' ? 'help' : args[i]); continue; }
  const value = match[2] ?? args[++i];
  if (!value || value.startsWith('--')) {
    console.log(JSON.stringify({ ok: false, error: { code: 'INVALID_ARGUMENT', message: `缺少 --${match[1]} 路径` } }));
    process.exit(1);
  }
  process.env[mappings[match[1]]] = value;
}
process.argv = [...process.argv.slice(0, 2), ...rest];
try { await import('./cli.mjs'); }
catch (e) {
  console.log(JSON.stringify({ ok: false, error: { code: 'INITIALIZATION_FAILED', message: e.message } }));
  process.exitCode = 1;
}
