// Tests for scripts/migrate-seed.js (synthetic data only, in-memory fake Supabase, no network).
// Run: node test-migrate-seed.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const M = require('./scripts/migrate-seed.js');

let pass = 0;
const realConsoleLog = console.log;
async function t(name, fn) {
  try {
    await fn();
  } finally {
    console.log = realConsoleLog;
  }
  pass++;
  console.log('PASS ' + name);
}

// ---- in-memory fake Supabase: REST kv, kv_history and Storage, as the global fetch -----------------
function makeFake() {
  const fake = { kv: new Map(), history: [], blobs: new Map(), calls: [], writes: 0, sawKey: new Set() };
  const res = (status, body, headers) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (headers || {})[String(h).toLowerCase()] || null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () =>
      Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.length) : new ArrayBuffer(0),
  });
  fake.fetch = async (url, opts) => {
    opts = opts || {};
    const method = opts.method || 'GET';
    fake.calls.push(method + ' ' + url.replace(/https?:\/\/[^/]+/, ''));
    fake.sawKey.add(opts.headers && opts.headers.apikey);
    const u = new URL(url);
    if (u.pathname === '/rest/v1/kv' && method === 'GET') {
      const k = u.searchParams.get('key');
      if (k) {
        const row = fake.kv.get(k.replace(/^eq\./, ''));
        return res(200, row ? [row] : []);
      }
      return res(
        200,
        Array.from(fake.kv.values()).map((r) => ({ key: r.key, deleted: !!r.deleted })),
      );
    }
    if (u.pathname === '/rest/v1/kv' && method === 'POST') {
      const r = JSON.parse(opts.body)[0];
      if (fake.kv.has(r.key)) return res(409, {});
      fake.writes++;
      fake.kv.set(r.key, r);
      return res(201, '');
    }
    if (u.pathname === '/rest/v1/kv' && method === 'PATCH') {
      const key = u.searchParams.get('key').replace(/^eq\./, '');
      const ver = Number(u.searchParams.get('version').replace(/^eq\./, ''));
      const cur = fake.kv.get(key);
      if (!cur || cur.version !== ver) return res(200, []);
      fake.writes++;
      const next = Object.assign({}, cur, JSON.parse(opts.body));
      fake.kv.set(key, next);
      return res(200, [next]);
    }
    if (u.pathname === '/rest/v1/kv_history' && method === 'POST') {
      fake.writes++;
      fake.history.push(JSON.parse(opts.body)[0]);
      return res(201, '');
    }
    if (u.pathname.startsWith('/storage/v1/object/pdf_blobs/')) {
      const key = u.pathname.split('/').pop();
      if (method === 'POST') {
        if (fake.blobs.has(key)) return res(409, {});
        fake.writes++;
        fake.blobs.set(key, Buffer.from(opts.body));
        return res(200, {});
      }
      const b = fake.blobs.get(key);
      if (!b) return res(404, {});
      if (opts.headers && opts.headers.Range)
        return res(206, Buffer.alloc(1), { 'content-range': 'bytes 0-0/' + b.length });
      return res(200, b);
    }
    return res(500, 'unhandled ' + method + ' ' + url);
  };
  return fake;
}

const SECRET = 'SYNTHETIC-SECRET-VALUE-do-not-leak';
const mkRow = (key, value, version, extra) =>
  Object.assign(
    {
      key,
      value,
      version: version || 1,
      hash: 'h',
      deleted: false,
      updated_by: 'someone',
      updated_at: '2026-08-19T00:00:00Z',
    },
    extra || {},
  );
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mseed-' + p + '-'));

function writeBackup(dir, data) {
  const f = path.join(dir, 'CompanyHub-localdatafile-20990101.json');
  fs.writeFileSync(f, JSON.stringify(Object.assign({ _companyHubBackup: true }, data)));
  return f;
}
function makeArgs(over) {
  return Object.assign(M.parseArgs([]), over);
}
function silent() {
  console.log = () => {};
  const lines = [];
  return { lines, log: (s) => lines.push(String(s)) };
}

(async () => {
  const realLog = console.log;
  const realFetch = global.fetch;
  const work = tmp('work');
  const reportDir = path.join(work, 'reports');
  const snapDir = path.join(work, 'snaps');
  const env = { SUPABASE_URL_STAGING: 'https://mock.invalid', SUPABASE_SECRET_KEY_STAGING: SECRET };

  // Backup: projects P1(changed) P2(new) ; tasks T1 identical, T2 conflict, T3 server newer; en_customers absent on server.
  const backup = {
    en_projects: [
      { id: 'P1', name: 'Alpha backup' },
      { id: 'P2', name: 'Beta' },
    ],
    en_tasks: [
      { id: 'T1', text: 'same' },
      { id: 'T2', text: 'backup text', updatedAt: '2026-10-10T00:00:00Z' },
      { id: 'T3', text: 'backup old', updatedAt: '2026-01-01T00:00:00Z' },
    ],
    en_customers: [{ id: 'C1', name: 'Cust' }],
  };
  const serverRows = () => [
    mkRow(
      'en_projects',
      [
        { id: 'P1', name: 'Alpha server' },
        { id: 'P9', name: 'Server only project' },
      ],
      3,
    ),
    mkRow(
      'en_tasks',
      [
        { id: 'T1', text: 'same' },
        { id: 'T2', text: 'server text', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'T3', text: 'server newer', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'T7', text: 'server only task' },
      ],
      6,
    ),
  ];
  const seed = (fake) => serverRows().forEach((r) => fake.kv.set(r.key, r));
  const backupFile = writeBackup(work, backup);

  await t('dry run: no write, no snapshot, diff file made, counts right', async () => {
    const fake = makeFake();
    seed(fake);
    global.fetch = fake.fetch;
    const out = silent();
    const r = await M.runImport(makeArgs({ file: backupFile, target: 'staging', reportDir, snapshotDir: snapDir }), {
      env,
      log: out.log,
    });
    global.fetch = realFetch;
    assert.strictEqual(fake.writes, 0, 'dry run wrote');
    assert(!fake.calls.some((c) => !c.startsWith('GET ')), 'non-GET call in dry run');
    assert(!fs.existsSync(snapDir), 'snapshot written in dry run');
    assert(fs.existsSync(r.diffFile));
    const c = r.counts;
    assert.deepStrictEqual([c.keys.insert, c.keys.update, c.keys.identical], [1, 2, 0]);
    // new: P2, C1 ; changed: P1, T2 ; server-only: P9, T7 ; server-newer kept: T3 ; identical: T1 (+T3 stays as the server copy)
    assert.strictEqual(c.records.new, 2);
    assert.strictEqual(c.records.changed, 2);
    assert.strictEqual(c.records.serverOnly, 2);
    assert.strictEqual(c.records.serverNewerKept, 1);
    assert(!out.lines.join('\n').match(/P9|T7|Alpha|SYNTHETIC/), 'ids, values or key reached the console');
  });

  await t('new record, changed record, server-only kept, conflict resolved (apply)', async () => {
    const fake = makeFake();
    seed(fake);
    global.fetch = fake.fetch;
    const out = silent();
    await M.runImport(makeArgs({ file: backupFile, target: 'staging', apply: true, reportDir, snapshotDir: snapDir }), {
      env,
      log: out.log,
    });
    global.fetch = realFetch;
    const proj = fake.kv.get('en_projects');
    const byId = (rows, id) => rows.find((x) => x.id === id);
    assert.strictEqual(byId(proj.value, 'P1').name, 'Alpha backup', 'changed record: backup wins');
    assert(byId(proj.value, 'P2'), 'new record added');
    assert(byId(proj.value, 'P9'), 'server-only record kept');
    assert.strictEqual(proj.version, 4);
    const tasks = fake.kv.get('en_tasks');
    assert.strictEqual(byId(tasks.value, 'T2').text, 'backup text', 'newer backup record wins');
    assert.strictEqual(byId(tasks.value, 'T3').text, 'server newer', 'newer server record kept');
    assert(byId(tasks.value, 'T7'), 'server-only task kept');
    assert(fake.kv.has('en_customers'), 'absent key inserted');
    assert.strictEqual(fake.kv.get('en_customers').version, 1);
  });

  await t('history written for every changed key; snapshot holds the old rows, before the write', async () => {
    const fake = makeFake();
    seed(fake);
    global.fetch = fake.fetch;
    const snapDir2 = path.join(work, 'snaps2');
    const r = await M.runImport(
      makeArgs({ file: backupFile, target: 'staging', apply: true, reportDir, snapshotDir: snapDir2 }),
      { env, log: silent().log },
    );
    global.fetch = realFetch;
    assert.deepStrictEqual(fake.history.map((h) => h.key).sort(), ['en_projects', 'en_tasks']);
    const hp = fake.history.find((h) => h.key === 'en_projects');
    assert.strictEqual(hp.version, 3);
    assert(hp.value.some((x) => x.id === 'P9') && hp.value.find((x) => x.id === 'P1').name === 'Alpha server');
    assert(/^\d{4}-\d{2}-\d{2}-\d{4}-supabase-snapshot\.json$/.test(path.basename(r.snapshotFile)));
    const snap = JSON.parse(fs.readFileSync(r.snapshotFile, 'utf8'));
    assert.strictEqual(snap.rows.en_projects.version, 3);
    assert.strictEqual(snap.rows.en_customers, null, 'absent key recorded as null');
    assert.strictEqual(snap.rows.en_tasks.value.length, 4);
  });

  await t('re-run after apply is a no-op (nothing new, nothing changed)', async () => {
    const fake = makeFake();
    seed(fake);
    global.fetch = fake.fetch;
    await M.runImport(
      makeArgs({ file: backupFile, target: 'staging', apply: true, reportDir, snapshotDir: path.join(work, 'snaps3') }),
      { env, log: silent().log },
    );
    const before = fake.writes;
    const r = await M.runImport(makeArgs({ file: backupFile, target: 'staging', reportDir }), {
      env,
      log: silent().log,
    });
    global.fetch = realFetch;
    assert.strictEqual(fake.writes, before);
    assert.strictEqual(r.counts.keys.insert + r.counts.keys.update, 0);
    assert.strictEqual(r.counts.records.new + r.counts.records.changed, 0);
  });

  await t('no timestamps: backup wins and every overwritten record is in the diff file', async () => {
    const f = writeBackup(tmp('nots'), { en_projects: [{ id: 'P1', name: 'Alpha backup' }] });
    const server = path.join(work, 'server-nots.json');
    fs.writeFileSync(
      server,
      JSON.stringify({
        rows: {
          en_projects: mkRow('en_projects', [
            { id: 'P1', name: 'Alpha server' },
            { id: 'P9', name: 'x' },
          ]),
        },
      }),
    );
    const r = await M.runImport(makeArgs({ file: f, serverFile: server, reportDir }), { log: silent().log });
    const diff = JSON.parse(fs.readFileSync(r.diffFile, 'utf8'));
    const k = diff.keys.find((x) => x.key === 'en_projects');
    assert.deepStrictEqual(
      k.overwrittenByBackup.map((x) => x.id),
      ['P1'],
    );
    assert(/no updated-at/.test(k.overwrittenByBackup[0].why));
    assert.deepStrictEqual(k.serverOnlyKept, ['P9']);
  });

  await t('a key that would drop nested server items is HELD, not written; --allow-removal writes it', async () => {
    const fake = makeFake();
    fake.kv.set('en_eqmatrix_abc', mkRow('en_eqmatrix_abc', { a: 1, extra: [1, 2, 3] }, 2));
    global.fetch = fake.fetch;
    const f = writeBackup(tmp('held'), { en_eqmatrix_abc: { a: 2 } });
    const base = { file: f, target: 'staging', apply: true, reportDir, snapshotDir: path.join(work, 'snaps4') };
    const r = await M.runImport(makeArgs(base), { env, log: silent().log });
    assert.strictEqual(r.counts.keys.held, 1);
    assert.strictEqual(fake.kv.get('en_eqmatrix_abc').version, 2, 'held key was written');
    assert.strictEqual(fake.history.length, 0);
    await M.runImport(makeArgs(Object.assign({}, base, { allowRemoval: ['en_eqmatrix_abc'] })), {
      env,
      log: silent().log,
    });
    global.fetch = realFetch;
    assert.strictEqual(fake.kv.get('en_eqmatrix_abc').version, 3);
    assert.strictEqual(fake.history.length, 1);
  });

  await t('PDF already present is not uploaded again; absent one is uploaded; report counts both', async () => {
    const fake = makeFake();
    global.fetch = fake.fetch;
    const dir = tmp('pdf');
    const pdfA = Buffer.from('%PDF-synthetic-A');
    const pdfB = Buffer.from('%PDF-synthetic-B');
    const keyOf = (b) => M.canonicalPdfKeyForHash(crypto.createHash('sha256').update(b).digest('hex'));
    fake.blobs.set(keyOf(pdfA), pdfA); // already on the server
    fs.writeFileSync(
      path.join(dir, 'CompanyHub-PDFs-20990101-part001.json'),
      JSON.stringify({
        _companyHubPdfExport: true,
        part: 1,
        count: 3,
        items: {
          en_pdf_file_a: pdfA.toString('base64'),
          en_pdf_file_a2: pdfA.toString('base64'),
          en_pdf_file_b: pdfB.toString('base64'),
        },
      }),
    );
    const args = makeArgs({ pdfDir: dir, target: 'staging', reportDir, snapshotDir: path.join(work, 'snaps5') });
    const dry = await M.runImport(args, { env, log: silent().log });
    assert.deepStrictEqual([dry.pdfPresence.unique, dry.pdfPresence.toUpload, dry.pdfPresence.present], [2, 1, 1]);
    assert.strictEqual(fake.writes, 0, 'dry run wrote a PDF');
    const wet = await M.runImport(Object.assign({}, args, { apply: true }), { env, log: silent().log });
    global.fetch = realFetch;
    assert.strictEqual(wet.pdfApplied.uploaded, 1);
    assert.strictEqual(wet.pdfApplied.noop, 1);
    assert.strictEqual(fake.blobs.size, 2);
    assert.strictEqual(wet.pdfApplied.conflict, 0);
  });

  await t('version moved during the run: no silent overwrite (conflict counted)', async () => {
    const fake = makeFake();
    seed(fake);
    const inner = fake.fetch;
    let bumped = false;
    global.fetch = async (url, opts) => {
      // a second user saves en_projects right after the snapshot read, before our PATCH
      if (!bumped && opts && opts.method === 'POST' && /kv_history/.test(url)) {
        bumped = true;
        const cur = fake.kv.get('en_projects');
        fake.kv.set('en_projects', Object.assign({}, cur, { version: cur.version + 1 }));
      }
      return inner(url, opts);
    };
    const r = await M.runImport(
      makeArgs({ file: backupFile, target: 'staging', apply: true, reportDir, snapshotDir: path.join(work, 'snaps6') }),
      { env, log: silent().log },
    );
    global.fetch = realFetch;
    assert(r.applied.summary.conflict >= 1);
  });

  await t('offline diff from a server file makes no network call', async () => {
    global.fetch = () => {
      throw new Error('network call in offline mode');
    };
    const server = path.join(work, 'server.json');
    fs.writeFileSync(server, JSON.stringify({ rows: { en_projects: serverRows()[0], en_tasks: serverRows()[1] } }));
    const r = await M.runImport(makeArgs({ file: backupFile, serverFile: server, reportDir }), { log: silent().log });
    global.fetch = realFetch;
    assert.strictEqual(r.counts.keys.insert, 1);
    assert.strictEqual(r.counts.keys.update, 2);
  });

  await t(
    'guards: apply needs a target; files must stay outside the repo; no default URL; key never printed',
    async () => {
      await assert.rejects(
        () => M.runImport(makeArgs({ file: backupFile, apply: true }), { log: silent().log }),
        /--target/,
      );
      await assert.rejects(
        () =>
          M.runImport(
            makeArgs({
              file: backupFile,
              serverFile: path.join(work, 'server.json'),
              reportDir: path.join(__dirname, 'scripts', 'out'),
            }),
            { log: silent().log },
          ),
        /inside the repo/,
      );
      assert.throws(() => M.resolveCreds({ target: 'prod' }, {}, () => 'k'), /No project URL/);
      const pe = { SUPABASE_URL_PROD: 'https://x.invalid/' };
      assert.throws(() => M.resolveCreds({ target: 'prod' }, pe, () => null), /No service key/);
      const c = M.resolveCreds({ target: 'prod' }, pe, (name) =>
        name === 'companyhub-supabase-prod-key' ? SECRET : null,
      );
      assert.strictEqual(c.url, 'https://x.invalid');
      assert.strictEqual(c.host, 'x.invalid');
      assert.throws(() => M.parseArgs(['--force']), /Unrecognized/);
      assert.throws(() => M.parseArgs(['--live']), /Unrecognized/);
      const src = fs.readFileSync(path.join(__dirname, 'scripts', 'migrate-seed.js'), 'utf8');
      assert(!/console\.(log|error|warn)\([^)]*secretKey/.test(src), 'a log call names the key');
      assert(!/rrdugvwxtddjywqykphf/.test(src), 'a project URL is hard-coded');
    },
  );

// ---- v2 review fixes ---------------------------------------------------------------------------
const diffOf = (r, key) =>
  JSON.parse(fs.readFileSync(r.diffFile, "utf8")).keys.find(
    (x) => x.key === key,
  );
const oneKeyServer = (name, key, value) => {
  const f = path.join(work, name);
  fs.writeFileSync(
    f,
    JSON.stringify({ rows: { [key]: mkRow(key, value, 2) } }),
  );
  return f;
};

await t(
  "wrong or generic target: generic env is never used; missing target value stops; host printed, key never",
  async () => {
    const generic = {
      SUPABASE_URL: "https://generic.invalid",
      SUPABASE_SECRET_KEY: SECRET,
    };
    assert.throws(
      () => M.resolveCreds({ target: "staging" }, generic, () => null),
      /No project URL for staging/,
    );
    // URL present but only the generic key: no key; the Credential Manager read gets the staging name
    const seen = [];
    assert.throws(
      () =>
        M.resolveCreds(
          { target: "staging" },
          Object.assign({ SUPABASE_URL_STAGING: "https://s.invalid" }, generic),
          (n) => {
            seen.push(n);
            return null;
          },
        ),
      /No service key for staging/,
    );
    assert.deepStrictEqual(seen, ["companyhub-supabase-staging-key"]);
    // staging variables never serve a prod run
    const stagingOnly = {
      SUPABASE_URL_STAGING: "https://s.invalid",
      SUPABASE_SECRET_KEY_STAGING: SECRET,
    };
    assert.throws(
      () => M.resolveCreds({ target: "prod" }, stagingOnly, () => null),
      /No project URL for prod/,
    );
    // --url and --cred-target no longer exist
    assert.throws(
      () => M.parseArgs(["--url", "https://x.invalid"]),
      /Unrecognized/,
    );
    assert.throws(() => M.parseArgs(["--cred-target", "x"]), /Unrecognized/);
    // a real run with only the generic pair stops before any network call
    global.fetch = () => {
      throw new Error("network call with a generic target");
    };
    await assert.rejects(
      () =>
        M.runImport(
          makeArgs({
            file: backupFile,
            target: "staging",
            apply: true,
            reportDir,
            snapshotDir: snapDir,
          }),
          {
            env: generic,
            log: silent().log,
          },
        ),
      /No project URL for staging/,
    );
    global.fetch = realFetch;
    // the log names the host and never the key
    const fake = makeFake();
    seed(fake);
    global.fetch = fake.fetch;
    const out = silent();
    await M.runImport(
      makeArgs({ file: backupFile, target: "staging", reportDir }),
      {
        env: {
          SUPABASE_URL_STAGING: "https://mock.invalid/",
          SUPABASE_SECRET_KEY_STAGING: SECRET,
        },
        log: out.log,
      },
    );
    global.fetch = realFetch;
    const text = out.lines.join("\n");
    assert(/target=staging host=mock\.invalid/.test(text), "host line missing");
    assert(!text.includes(SECRET), "key printed");
    assert(
      fake.sawKey.has(SECRET) && fake.sawKey.size === 1,
      "staging key was used",
    );
  },
);

await t(
  "nested newer-wins: a newer server bill inside an older (unstamped) building is kept; names in the diff",
  async () => {
    const mk = (b1, b2) => ({
      buildings: [
        {
          id: "B1",
          name: "Bldg",
          meters: [{ id: "M1", label: "m", bills: [b1, b2] }],
        },
        { id: "B2", name: "Other", meters: [] },
      ],
    });
    const server = mk(
      { id: "X1", total: 99, updatedAt: "2026-10-01T00:00:00Z" },
      { id: "X2", total: 5 },
    );
    const bak = mk(
      { id: "X1", total: 1, updatedAt: "2026-01-01T00:00:00Z" },
      { id: "X2", total: 6 },
    );
    bak.buildings[0].name = "Bldg renamed";
    const key = "en_utility_cust_c1";
    const f = writeBackup(tmp("nest"), { [key]: bak });
    const r = await M.runImport(
      makeArgs({
        file: f,
        serverFile: oneKeyServer("nest.json", key, server),
        reportDir,
      }),
      {
        log: silent().log,
      },
    );
    const plan = r.plan.keys.find((p) => p.key === key);
    assert.strictEqual(plan.action, "update");
    const bills = plan.value.buildings[0].meters[0].bills;
    assert.strictEqual(
      bills.find((b) => b.id === "X1").total,
      99,
      "newer server bill kept",
    );
    assert.strictEqual(
      bills.find((b) => b.id === "X2").total,
      6,
      "unstamped bill: backup wins",
    );
    assert.strictEqual(plan.value.buildings[0].name, "Bldg renamed");
    const d = diffOf(r, key);
    const kept = d.nestedRecords.find((n) => n.kind.startsWith("kept"));
    assert.deepStrictEqual(
      [kept.level, kept.path],
      ["bills", ["B1", "M1", "X1"]],
    );
    const over = d.nestedRecords.find(
      (n) => n.kind.startsWith("overwritten") && n.level === "bills",
    );
    assert.deepStrictEqual(over.path, ["B1", "M1", "X2"]);
    assert.deepStrictEqual(over.fields.changed, ["total"]);
    assert.deepStrictEqual(d.serverNewerKept, ["B1 > M1 > X1"]);
  },
);

await t(
  "plain key with a server-only scalar field is HELD: no write, field name in the diff file",
  async () => {
    const fake = makeFake();
    fake.kv.set(
      "en_eqmatrix_abc",
      mkRow("en_eqmatrix_abc", { a: 1, flag: true, keep: "x" }, 2),
    );
    global.fetch = fake.fetch;
    const f = writeBackup(tmp("scalarheld"), {
      en_eqmatrix_abc: { a: 2, keep: "x" },
    });
    const base = {
      file: f,
      target: "staging",
      apply: true,
      reportDir,
      snapshotDir: path.join(work, "snaps7"),
    };
    const out = silent();
    const r = await M.runImport(makeArgs(base), { env, log: out.log });
    assert.strictEqual(r.counts.keys.held, 1);
    assert.strictEqual(fake.writes, 0, "held key was written");
    assert.strictEqual(fake.history.length, 0);
    const d = diffOf(r, "en_eqmatrix_abc");
    assert.strictEqual(d.action, "held");
    assert.deepStrictEqual(d.heldBecause.lostFieldNames, ["flag"]);
    assert.deepStrictEqual(d.fieldChanges.changed, ["a"]);
    assert(
      !out.lines.join("\n").includes("flag"),
      "a field name reached the console",
    );
    await M.runImport(
      makeArgs(Object.assign({}, base, { allowRemoval: ["en_eqmatrix_abc"] })),
      { env, log: silent().log },
    );
    global.fetch = realFetch;
    assert.deepStrictEqual(fake.kv.get("en_eqmatrix_abc").value, {
      a: 2,
      keep: "x",
    });
  },
);

await t(
  "scalar overwrite listing: changed, added and lost field names; whole-key scalar noted; no values in the file",
  async () => {
    const key = "en_eqmatrix_abc";
    const f = writeBackup(tmp("scalar"), { [key]: { a: 2, c: 3, same: 1 } });
    const r = await M.runImport(
      makeArgs({
        file: f,
        serverFile: oneKeyServer("scalar.json", key, {
          a: "SECRET-VAL-1",
          same: 1,
          gone: { x: 1 },
        }),
        reportDir,
      }),
      { log: silent().log },
    );
    const d = diffOf(r, key);
    assert.deepStrictEqual(d.fieldChanges, {
      changed: ["a"],
      added: ["c"],
      lost: ["gone"],
    });
    assert.strictEqual(
      d.action,
      "held",
      "a server-only object field also holds",
    );
    assert(
      !fs.readFileSync(r.diffFile, "utf8").includes("SECRET-VAL-1"),
      "a value reached the diff file",
    );
    const r2 = await M.runImport(
      makeArgs({
        file: writeBackup(tmp("scalar2"), { [key]: "new text" }),
        serverFile: oneKeyServer("scalar2.json", key, "old text"),
        reportDir,
      }),
      { log: silent().log },
    );
    const d2 = diffOf(r2, key);
    assert.strictEqual(d2.action, "update");
    assert(/scalar value replaced/.test(d2.overwrittenByBackup[0].why));
  },
);

await t(
  "importer result equals the app Restore plan (one merge function, same newer-wins rule)",
  async () => {
    const RMg = require("./app/restore-merge.js");
    const key = "en_tasks";
    const server = [
      { id: "T1", text: "s1", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "T2", text: "s2" },
      { id: "T9", text: "only server" },
    ];
    const bak = [
      { id: "T1", text: "b1", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "T2", text: "b2" },
    ];
    const f = writeBackup(tmp("same"), { [key]: bak });
    const r = await M.runImport(
      makeArgs({
        file: f,
        serverFile: oneKeyServer("same.json", key, server),
        reportDir,
      }),
      {
        log: silent().log,
      },
    );
    const app = RMg.plan({ [key]: bak }, () => server, "backup-wins").items[0];
    assert.deepStrictEqual(r.plan.keys[0].value, app.value);
    assert.strictEqual(
      r.plan.keys[0].value.find((x) => x.id === "T1").text,
      "s1",
    );
    assert.strictEqual(app.keptNewer, 1);
  },
);
  await t('Credential Manager read returns null for a missing entry (no throw, no output)', async () => {
    if (process.platform !== 'win32') return;
    assert.strictEqual(M.readCredentialManager('companyhub-test-no-such-entry-' + Date.now()), null);
  });

  fs.rmSync(work, { recursive: true, force: true });
  console.log('\n' + pass + ' tests passed');
})().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
