/**
 * gate-schema-grants.js  (Supabase rule of 2026-10-30: new public tables get no automatic Data API grants)
 *
 * Gate: every `create table` in schema "public" in netlify/db/*.sql needs, in the same folder:
 *   1. `enable row level security` for that table.
 *   2. a `grant ... to service_role` that names that table.
 * And no grant may target anon (or authenticated or public).
 *
 * Usage: node tools/gate-schema-grants.js [sql-dir]
 */
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'netlify', 'db');
const fails = [];
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /\.sql$/i.test(f)) : [];
if (!files.length) fails.push('no .sql files in ' + DIR);

files.forEach((f) => {
  const sql = fs
    .readFileSync(path.join(DIR, f), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const stmts = sql.split(';').map((x) => x.replace(/\s+/g, ' ').trim());
  const tables = [];
  const re = /create table (?:if not exists )?(?:public\.)?"?(\w+)"?/i;
  stmts.forEach((st) => {
    const m = re.exec(st);
    if (m && /^create table/i.test(st) && !/create table (?:if not exists )?(?!public\.)\w+\./i.test(st)) tables.push(m[1].toLowerCase());
  });
  tables.forEach((t) => {
    const rls = stmts.some((st) => new RegExp('^alter table (?:only )?(?:public\\.)?"?' + t + '"? enable row level security$', 'i').test(st));
    if (!rls) fails.push(f + ': table public.' + t + ' has no enable row level security');
    const gr = stmts.some(
      (st) => /^grant /i.test(st) && /\bto service_role\b/i.test(st) && new RegExp('\\b' + t + '\\b', 'i').test(st.replace(/\bto service_role.*$/i, ''))
    );
    if (!gr) fails.push(f + ': table public.' + t + ' has no grant ... to service_role');
  });
  stmts.forEach((st) => {
    if (/^grant /i.test(st) && /\bto\b[^]*\b(anon|authenticated|public)\b/i.test(st.replace(/^.*?\bto\b/i, 'to'))) fails.push(f + ': grant targets anon/authenticated/public: ' + st.slice(0, 80));
  });
});

if (fails.length) {
  console.log('gate-schema-grants FAIL\n' + fails.join('\n'));
  process.exit(1);
}
console.log('gate-schema-grants PASS');
