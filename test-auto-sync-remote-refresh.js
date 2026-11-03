// Real-browser test (synthetic data, headless bundled Chromium, file://, no server, no real browser store).
// 1. A newer record arrives from the shared database (the store changes, db.js announces dbRemoteApplied):
//    the open project view and the project list draw the new data by themselves: no banner, no reload.
// 2. Dirty view: a real user edit (trusted input) in the open view holds the redraw; the page lists still read the store.
//    No timer: 0 extra redraws over 6 s. The redraw runs when the edit is saved (the view then shows the remote data plus
//    the saved edit) or when the user leaves the view (tab change or navigation). A value set by script does not hold it.
// 2c. An open dialog stops the redraw; it runs when the dialog closes. Typing inside the dialog does not mark the view dirty.
// 2d. A save that runs after a refresh writes into the current record: its edit and the remote change both stay.
// 2b-2. Late scroll re-apply stops when the user scrolls. Rows are kept by key. A hidden stale dialog does not block.
//    Prototype keys in remote data are ignored.
// 2e. A refresh writes nothing to the store. 2f. Scroll and marked rows stay. 2g. Every stale cache is cleared.
// 3. Conflict history shows plain English sentences, never internal codes.
// Run: node test-auto-sync-remote-refresh.js [outDir]   (outDir: also saves a screenshot of the Conflict history panel)
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const SITE = 'file:///' + __dirname.split(path.sep).join('/') + '/energy-department.html';
const OUT = process.argv[2] || '';
const PID = 999000555;
let pass = 0,
  fail = 0;
function ok(c, l) {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL ' + l);
  }
}
const proj = (name) => ({
  id: PID,
  name,
  client: 'S',
  addr: '',
  type: 'Test',
  status: 'active',
  phase: '',
  contacts: [],
  savingsData: { measures: [] },
});
(async () => {
  const ctx = await launchBrowser('autosync', { viewport: { width: 1600, height: 1000 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await ctx.addInitScript(
      (data) => {
        if (window.localStorage.getItem('en_projects')) return;
        for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
        window.localStorage.setItem('ch_activeView', 'projects');
      },
      {
        en_projects: [proj('Original Site Name')],
        en_conflict_archive: [
          {
            key: 'en_eqmatrix_' + PID,
            reason: 'hydration-server-wins',
            losingSide: 'local',
            winningSide: 'server',
            archivedAt: '2026-11-02T16:41:04',
            losingValue: [{ id: 1 }],
          },
          {
            key: 'en_eqmatrix_' + PID,
            reason: 'record-conflict',
            recordId: 'r1',
            losingSide: 'local',
            archivedAt: '2026-11-02T17:00:00',
            losingValue: { id: 'r1', equipName: 'AHU-1' },
          },
          {
            key: 'en_tasks',
            reason: 'write-conflict-server-wins',
            losingSide: 'local',
            losingValue: [],
            archivedAt: '2026-11-02T10:05:00',
            winningUpdatedAt: '2026-11-02T10:04:00',
          },
          { key: 'en_projects', reason: 'held-draft-discarded', losingSide: 'local', losingValue: [], archivedAt: '2026-11-01T09:00:00' },
        ],
        ch_settings: { showQuickStart: false },
        ch_theme: 'dark',
        ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
      },
    );
    await page.goto(SITE);
    await page.waitForTimeout(2000);
    await page.evaluate((pid) => {
      window.__sentinel = 'same-page';
      openDetail(pid);
    }, PID);
    const detailText = () => page.evaluate(() => (document.querySelector('.pd-name') || {}).innerText || '');
    const listText = () => page.evaluate(() => document.getElementById('view-projects').innerText);
    ok((await detailText()).includes('Original Site Name'), 'start: detail shows the original name');
    // The newer record, as db.js leaves it after a poll: the store changes with no local-write event
    // (db.js writes remote data with _rawSet, which sends no 'dataUpdated'), then dbRemoteApplied.
    const remoteKey = (key, value) =>
      page.evaluate(
        async (a) => {
          const d = window.dispatchEvent;
          window.dispatchEvent = (ev) => (ev.type === 'dataUpdated' ? true : d.call(window, ev));
          try {
            await DB.set(a.key, a.value);
          } finally {
            window.dispatchEvent = d;
          }
          window.dispatchEvent(new CustomEvent('dbRemoteApplied', { detail: { keys: [a.key] } }));
        },
        { key, value },
      );
    const remote = (name) => remoteKey('en_projects', [proj(name)]);
    // 1. no typing: the open view draws the new record by itself
    await remote('Renamed By Other User');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Renamed By Other User'), 'detail view shows the remote change');
    ok(!(await detailText()).includes('Original Site Name'), 'old name gone from detail');
    ok((await page.evaluate(() => window.__sentinel)) === 'same-page', 'page was not reloaded');
    ok(
      await page.evaluate(() => {
        const b = document.getElementById('ch-sync-banner');
        return !b || b.style.display === 'none' || !b.textContent;
      }),
      'no refresh banner',
    );
    ok(!/refresh to get the latest/i.test(await page.evaluate(() => document.body.innerText)), 'no refresh text on the page');
    // 2. dirty view: a real user edit (trusted input) in the open view holds the redraw; the lists still read the store
    const urlId = 'distcal-url-' + PID; // a field with no save path: it stays an unsaved edit
    const notesId = 'proj-notes-ta-dash-' + PID; // saves on input (autoSaveNotes -> sset -> DB.set -> dataUpdated)
    const showField = (id) =>
      page.evaluate((i) => {
        for (let n = document.getElementById(i); n && n !== document.body; n = n.parentNode) if (n.style && getComputedStyle(n).display === 'none') n.style.display = 'block'; // show it so it can be typed in
      }, id);
    const typeIn = async (id, text) => {
      await showField(id);
      await page.evaluate((i) => (document.getElementById(i).__oldNode = true), id);
      await page.fill('#' + id, text); // real typing: trusted input events
      await page.evaluate((i) => document.getElementById(i).blur(), id);
    };
    const fieldState = (id) =>
      page.evaluate((i) => {
        const e = document.getElementById(i);
        return e ? { value: e.value, redrawn: !e.__oldNode } : null;
      }, id);
    const refreshCount = () => page.evaluate(() => window.__refreshCount);
    await page.evaluate(() => {
      window.__refreshCount = 0;
      window.addEventListener('chRefreshFromStore', (e) => {
        if (!(e.detail && e.detail.draw === false)) window.__refreshCount++;
      });
    });
    await typeIn(urlId, 'half written');
    const c0 = await refreshCount();
    await remote('Dirty Remote Name');
    await page.waitForTimeout(1500);
    ok((await detailText()).includes('Renamed By Other User'), 'dirty: the view is not redrawn');
    ok((await page.evaluate(() => projects.find((x) => x.id == window._activeProjId).name)) === 'Dirty Remote Name', 'dirty: the page list read the store at once');
    let fs1 = await fieldState(urlId);
    ok(fs1 && !fs1.redrawn && fs1.value === 'half written', 'dirty: typed text kept, field not redrawn: ' + JSON.stringify(fs1));
    await page.waitForTimeout(6000);
    ok((await refreshCount()) === c0, 'dirty: no redraw loop, 0 extra redraws over 6 s');
    ok((await detailText()).includes('Renamed By Other User'), 'dirty: still not redrawn after 6 s');
    // the save: typing in the notes field saves the project (dataUpdated); the pending redraw runs after it
    await typeIn(notesId, 'note in progress');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Dirty Remote Name'), 'after the save: the view shows the remote data');
    const saved = await page.evaluate((i) => ({ notes: document.getElementById(i).value, stored: sget('en_projects', [])[0] }), notesId);
    ok(saved.notes === 'note in progress' && saved.stored.notes === 'note in progress' && saved.stored.name === 'Dirty Remote Name', 'after the save: the saved edit and the remote change both show and are stored: ' + JSON.stringify(saved));
    ok((await refreshCount()) === c0 + 1, 'after the save: exactly one redraw');
    ok((await page.evaluate(() => window.__sentinel)) === 'same-page', 'still not reloaded');
    // leaving the view (tab change by a real click) clears the mark; the pending redraw runs; on return the new data shows
    await typeIn(urlId, 'typed before leaving');
    await remote('Leave Remote Name');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Dirty Remote Name'), 'dirty again: not redrawn');
    await page.click('.pdt[data-tab="utility"]');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Leave Remote Name'), 'tab change: the pending redraw ran');
    await page.click('.pdt[data-tab="dashboard"]');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Leave Remote Name'), 'back on the tab: the new data shows');
    // navigation to another view (sv) clears the mark too
    await typeIn(urlId, 'typed before navigating');
    await remote('Nav Remote Name');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Leave Remote Name'), 'dirty before navigation: not redrawn');
    await page.click('[data-sb-icon="home"]');
    await page.waitForTimeout(500);
    await page.evaluate((pid) => openDetail(pid), PID);
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Nav Remote Name'), 'after navigation and return: the new data shows');
    // a value filled in by script is not an edit: it does not hold the redraw
    await page.evaluate((u) => {
      document.getElementById(u).value = 'script value';
      const i = document.createElement('input');
      i.type = 'text';
      i.className = 'tmpScriptNoKey';
      document.getElementById('projDetailContent').appendChild(i);
      i.value = 'script, no key';
    }, urlId);
    await remote('Script Fill Remote');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Script Fill Remote'), 'script-filled fields do not hold the redraw');
    ok((await page.evaluate((u) => document.getElementById(u).value, urlId)) === '', 'script-filled field shows fresh data, not the old value');
    // 2b. a filter or search box (data-ch-filter) holds no record data: typing in it does not hold the redraw; its text is kept
    await page.evaluate(() => {
      const i = document.createElement('input');
      i.type = 'text';
      i.id = 'tmpFilterBox';
      i.setAttribute('data-ch-filter', '');
      document.getElementById('view-projects').insertBefore(i, document.getElementById('view-projects').firstChild);
    });
    await page.fill('#tmpFilterBox', 'gym');
    await remote('Filter Remote Name');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Filter Remote Name'), 'filter box: typing in it does not hold the redraw');
    ok((await page.evaluate(() => document.getElementById('tmpFilterBox').value)) === 'gym', 'filter box: the filter text is kept through the redraw');
    // 2b-2. a view that only deletes: DB.remove sends the local-write event, so the dirty mark clears and the redraw runs
    await typeIn(urlId, 'typed before delete');
    await remote('Delete Remote Name');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Filter Remote Name'), 'delete: dirty view is not redrawn before the delete');
    await page.evaluate(() => DB.remove('en_tmp_delete_probe'));
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Delete Remote Name'), 'delete: the view redraws after DB.remove');
    await page.evaluate(() => document.getElementById('tmpFilterBox').remove());
    // 2c. open dialog: the redraw waits and runs when the dialog closes; typing in the dialog does not mark the view dirty
    await page.evaluate(() => document.getElementById('taskModal').classList.add('open'));
    await page.fill('#mt-text', 'typed inside the dialog');
    await remote('Dialog Remote Name');
    await page.waitForTimeout(1500);
    ok((await detailText()).includes('Delete Remote Name'), 'dialog open: view not redrawn');
    await page.evaluate(() => document.getElementById('taskModal').classList.remove('open'));
    await page.waitForTimeout(1600);
    ok((await detailText()).includes('Dialog Remote Name'), 'dialog closed: queued refresh ran (typing in the dialog did not hold it)');
    // 2c-2. a stale dialog element that is not visible does not block the refresh
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.className = 'modal open';
      d.id = 'tmpStaleDialog';
      d.style.display = 'none';
      document.body.appendChild(d);
    });
    await remote('Stale Dialog Remote');
    await page.waitForTimeout(500);
    ok((await detailText()).includes('Stale Dialog Remote'), 'hidden stale dialog does not block the refresh');
    await page.evaluate(() => document.getElementById('tmpStaleDialog').remove());
    await remote('Dialog Remote Name');
    await page.waitForTimeout(500);
    // 2d. race: an edit holds an old record, a remote refresh arrives, then the edit saves. Both stay.
    await page.evaluate(() => {
      window.__oldRec = projects.find((x) => x.id == window._activeProjId);
    });
    await remote('Race Remote Name');
    await page.waitForTimeout(500);
    const race = await page.evaluate(() => {
      window.__oldRec.addr = 'Edited While Refresh Ran'; // the edit saves after the refresh
      sset('en_projects', projects);
      const stored = sget('en_projects', [])[0];
      return { name: stored.name, addr: stored.addr, same: projects.indexOf(window.__oldRec) >= 0 };
    });
    ok(race.name === 'Race Remote Name' && race.addr === 'Edited While Refresh Ran', 'race: edit and remote change both stored: ' + JSON.stringify(race));
    ok(race.same, 'race: the old record is the current list record');
    // 2e. a refresh writes nothing to the store, even when old data would run a migration
    const writes = await page.evaluate(() => {
      let n = 0;
      const dbSet = DB.set;
      const dbRemove = DB.remove;
      const oldSset = window.sset;
      localStorage.setItem('en_projects', JSON.stringify([{ id: 999000555, name: 'Race Remote Name', status: 'active', activeCommodities: ['Electric'] }]));
      localStorage.setItem('en_utilityData', JSON.stringify({ 999000555: { buildings: [] } }));
      DB.set = function () { n++; return dbSet.apply(this, arguments); };
      DB.remove = function () { n++; return dbRemove.apply(this, arguments); };
      window.sset = function () { n++; return oldSset.apply(this, arguments); };
      try {
        chRefreshFromStore(['en_projects', 'en_customers', 'en_utility_x']);
        loadUtilityData(true);
      } finally {
        DB.set = dbSet;
        DB.remove = dbRemove;
        window.sset = oldSset;
      }
      const out = { n, migrated: !!projects[0].calcCommodities, combinedKept: !!localStorage.getItem('en_utilityData') };
      localStorage.removeItem('en_utilityData');
      return out;
    });
    ok(writes.n === 0 && !writes.migrated && writes.combinedKept, 'refresh wrote nothing and ran no migration: ' + JSON.stringify(writes));
    await remote('Race Remote Name');
    await page.waitForTimeout(500);
    const pol = await page.evaluate(() => {
      const fresh = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"a":1,"list":[{"id":1,"__proto__":{"polluted3":true}}]}');
      const out = chReconcile({ a: 0, b: 2 }, fresh);
      return { p: ({}).polluted, p2: ({}).polluted2, p3: ({}).polluted3, a: out.a, hasB: 'b' in out, ctorOwn: Object.prototype.hasOwnProperty.call(out, 'constructor') };
    });
    ok(pol.p === undefined && pol.p2 === undefined && pol.p3 === undefined && pol.a === 1 && !pol.hasB && !pol.ctorOwn, 'chReconcile ignores prototype keys: ' + JSON.stringify(pol));
    // 2f. scroll position and a marked row stay through the redraw
    const scrollBefore = await page.evaluate(() => {
      const st = document.createElement('style');
      st.id = 'tmpScrollStyle';
      st.textContent = '#projDetailContent .ptab.active { max-height: 140px; overflow-y: auto; }';
      document.head.appendChild(st);
      const tab = document.querySelector('#projDetailContent .ptab.active');
      tab.scrollTop = 60;
      return { top: tab.scrollTop, max: tab.scrollHeight - tab.clientHeight };
    });
    await remote('Scroll Remote Name');
    await page.waitForTimeout(500);
    const scrollAfter = await page.evaluate(() => {
      const tab = document.querySelector('#projDetailContent .ptab.active');
      return { top: tab.scrollTop };
    });
    ok(scrollBefore.max > 0 && scrollBefore.top > 0, 'scroll test set up: ' + JSON.stringify(scrollBefore));
    ok(scrollAfter.top === scrollBefore.top, 'panel scroll position kept: ' + JSON.stringify(scrollAfter) + JSON.stringify(scrollBefore));
    // late content: something moves the panel right after the redraw; the one-time re-apply puts it back
    await remote('Scroll Remote Name 2');
    await page.evaluate(() => (document.querySelector('#projDetailContent .ptab.active').scrollTop = 0));
    await page.waitForTimeout(600);
    ok((await page.evaluate(() => document.querySelector('#projDetailContent .ptab.active').scrollTop)) === scrollBefore.top, 'late content: scroll re-applied once');
    // the user scrolls (trusted wheel) right after the redraw: the re-apply must not fight them
    const box = await page.evaluate(() => {
      const r = document.querySelector('#projDetailContent .ptab.active').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 70 };
    });
    await page.mouse.move(box.x, box.y);
    await remote('Scroll Remote Name 3');
    await page.mouse.wheel(0, 30);
    await page.evaluate(() => (window.__afterWheelSet = 1));
    await page.waitForTimeout(700);
    const afterWheel = await page.evaluate(() => document.querySelector('#projDetailContent .ptab.active').scrollTop);
    ok(afterWheel > scrollBefore.top + 5, 'user wheel after redraw: no forced scroll back: ' + afterWheel + ' vs ' + scrollBefore.top);
    // rows are kept by record key, not by position
    await page.evaluate(() => {
      const mk = (id, key) => '<div class="tmpRow"' + (key ? ' data-id="' + id + '"' : '') + '>' + id + '</div>';
      const box1 = document.createElement('div');
      box1.id = 'tmpRowsKeyed';
      const box2 = document.createElement('div');
      box2.id = 'tmpRowsKeyless';
      document.querySelector('.view.active').appendChild(box1);
      document.querySelector('.view.active').appendChild(box2);
      window.__rowOrder = ['a', 'b', 'c'];
      const draw = () => {
        box1.innerHTML = window.__rowOrder.map((i) => mk(i, true)).join('');
        box2.innerHTML = ['a', 'b', 'c'].map((i) => mk(i, false)).join('');
      };
      draw();
      window.addEventListener('chRefreshFromStore', (e) => {
        if (!(e.detail && e.detail.draw === false)) draw(); // a view listener draws on the draw pass only
      });
      box1.children[1].classList.add('selected');
      box2.children[1].classList.add('selected');
    });
    await page.evaluate(() => (window.__rowOrder = ['x', 'a', 'b', 'c'])); // a new record arrives at the top
    await remote('Rows Remote Name');
    await page.waitForTimeout(500);
    const rows = await page.evaluate(() => ({
      keyed: Array.from(document.querySelectorAll('#tmpRowsKeyed .selected')).map((e) => e.getAttribute('data-id')),
      keyless: document.querySelectorAll('#tmpRowsKeyless .selected').length,
    }));
    ok(rows.keyed.length === 1 && rows.keyed[0] === 'b', 'selected row kept by key after an insert: ' + JSON.stringify(rows));
    ok(rows.keyless === 0, 'row without a key: selection not restored: ' + JSON.stringify(rows));
    await page.evaluate(() => {
      document.getElementById('tmpRowsKeyed').remove();
      document.getElementById('tmpRowsKeyless').remove();
    });
    await page.evaluate(() => document.getElementById('tmpScrollStyle').remove());
    // 2g. every stale cache is cleared
    const caches = await page.evaluate(async () => {
      window._pricingRowCache = { a: 1 };
      window._pricingOptimizerStats = { a: 1 };
      window._reportData = { a: 1 };
      window._emCatKeyLabelCache = { a: 'x' };
      dcEvents = [{ id: 1 }];
      await DB.set('en_dc_events', { events: [], viewYear: 2026, viewMonth: 1 });
      window.dispatchEvent(new CustomEvent('dbRemoteApplied', { detail: { keys: ['en_projects', 'en_dc_events'] } }));
      await new Promise((r) => setTimeout(r, 600));
      return {
        pricing: Object.keys(window._pricingRowCache).length,
        opt: Object.keys(window._pricingOptimizerStats).length,
        report: window._reportData,
        label: !!window._emCatKeyLabelCache && Object.keys(window._emCatKeyLabelCache).includes('a'),
        dc: dcEvents.length,
      };
    });
    ok(caches.pricing === 0 && caches.opt === 0 && caches.report === null && !caches.label && caches.dc === 0, 'stale caches cleared: ' + JSON.stringify(caches));
    await remote('Third Remote Name');
    await page.waitForTimeout(500);
    // project list view too
    await page.evaluate(() => showList());
    await remote('Third Remote Name');
    await page.waitForTimeout(500);
    ok((await listText()).includes('Third Remote Name'), 'project list shows the remote change');
    // a focused search box keeps its text, its focus and its caret
    await page.evaluate(() => {
      const i = document.getElementById('projSearchQ');
      i.value = 'search text';
      i.focus();
      i.setSelectionRange(3, 6);
    });
    await remote('Third Remote Name B');
    await page.waitForTimeout(500);
    const srch = await page.evaluate(() => {
      const i = document.getElementById('projSearchQ');
      return { v: i.value, f: document.activeElement === i, s: i.selectionStart, e: i.selectionEnd };
    });
    ok(srch.v === 'search text' && srch.f && srch.s === 3 && srch.e === 6, 'focused search box keeps text, focus and caret: ' + JSON.stringify(srch));
    await page.evaluate(() => {
      document.getElementById('projSearchQ').value = '';
      document.getElementById('projSearchQ').blur();
    });
    await remote('Third Remote Name');
    await page.waitForTimeout(500);
    // 2b. views that keep their own in-memory copies: a remote change to the view's own store key shows with no reload
    const emRow = (name) => ({
      id: 'Syn Building||' + name,
      building: 'Syn Building',
      location: '',
      floor: '',
      area: '',
      equipName: name,
      equipType: name,
      category: 'vav',
      subtype: '',
      points: { 'Zone Temp': '70.0 F' },
      pointsRaw: { 'Zone Temp': '70.0 F' },
      checks: {},
      schema: 2,
    });
    const emMatrix = (name) => ({ rows: [emRow(name)], importedAt: new Date().toISOString(), buildings: ['Syn Building'], totalBASPoints: 0 });
    const tabText = (sel) => page.evaluate((s) => (document.querySelector(s) || {}).innerText || '', sel);
    // Equipment matrix (app/equipment-matrix.js: self-heal flag, row lookup, compliance and point caches)
    await page.evaluate(async (a) => {
      await DB.set('en_eqmatrix_' + a.pid, a.m);
      openDetail(a.pid);
      sPTab('eq-matrix', document.querySelector('.pdt[data-tab="eq-matrix"]'));
    }, { pid: PID, m: emMatrix('VAV-1') });
    await page.waitForTimeout(2500);
    ok((await tabText('#em-table-wrap')).includes('VAV-1'), 'matrix: start shows the first equipment name (VAV-1)');
    await remoteKey('en_eqmatrix_' + PID, emMatrix('AHU-7'));
    await page.waitForTimeout(1500);
    const emAfter = await tabText('#em-table-wrap');
    ok(emAfter.includes('AHU-7'), 'matrix: shows the remote equipment name: ' + emAfter.slice(0, 80));
    ok(!emAfter.includes('VAV-1'), 'matrix: old equipment name gone');
    // the remote row is stored with the wrong type; the self-heal pass must run again on the new records
    ok(await page.evaluate(() => emLoadMatrix(emGetActiveProjId()).rows[0].category === 'ahu'), 'matrix: self-heal ran again on the remote records');
    ok((await page.evaluate(() => window.__sentinel)) === 'same-page', 'matrix: page was not reloaded');
    // Hours tab
    const hours = (note) => ({ projId: PID, entries: [{ id: 'h1', date: '2026-01-05', hours: 2, category: 'Reporting', note }] });
    await page.evaluate(async (a) => {
      await DB.set('en_hours_' + a.pid, a.v);
      sPTab('dashboard', null, 'hours');
    }, { pid: PID, v: hours('first synthetic note') });
    await page.waitForTimeout(800);
    ok((await tabText('#projDetailView')).includes('first synthetic note'), 'hours: start shows the first note');
    await remoteKey('en_hours_' + PID, hours('remote synthetic note'));
    await page.waitForTimeout(1000);
    const hrAfter = await tabText('#projDetailView');
    ok(hrAfter.includes('remote synthetic note') && !hrAfter.includes('first synthetic note'), 'hours: shows the remote note');
    // Tasks list (the core list in app/core.js)
    await page.evaluate(() => sv('home'));
    const task = (title) => [{ id: 999000777, title, text: title, name: title, projId: PID, status: 'open', due: new Date().toISOString().slice(0, 10), done: false, pri: 'med' }];
    await remoteKey('en_tasks', task('Remote synthetic task'));
    await page.waitForTimeout(800);
    ok((await page.evaluate(() => window.__sentinel)) === 'same-page', 'tasks: page was not reloaded');
    ok((await page.evaluate(() => document.getElementById('upcomingTasksList').innerText)).includes('Remote synthetic task'), 'tasks: home list shows the remote task');
    await page.evaluate(() => { showList(); sv('projects'); });
    // 3. conflict history wording
    const texts = await page.evaluate(() => {
      document.getElementById('ch-archive-link').click();
      return Array.from(document.querySelectorAll('#ch-archive-panel .ch-archive-meta'))
        .map((e) => e.textContent)
        .concat(Array.from(document.querySelectorAll('#ch-archive-panel button.ch-conflict-btn')).map((e) => 'BTN:' + e.textContent));
    });
    const all = texts.join('\n');
    ok(!/hydration|server-wins|write-conflict|held-draft|record-conflict|—/.test(all), 'no internal codes or dashes: ' + all);
    ok(
      all.includes(
        'Equipment matrix (Third Remote Name): another user saved a newer version on Nov 2, 2026 at 4:41 PM. Their version was kept. Download your version to compare.',
      ),
      'sentence for the equipment matrix: ' + all,
    );
    ok(all.includes('Equipment matrix, AHU-1 (Third Remote Name): another user saved a newer version on Nov 2, 2026 at 5:00 PM.'), 'record name in the sentence: ' + all);
    ok(/Tasks list: another user saved a newer version on Nov 2, 2026 at 10:04 AM\./.test(all), 'tasks sentence: ' + all);
    ok(
      texts.every((t) => t.startsWith('BTN:') || /^[A-Z]/.test(t)),
      'every sentence starts with a capital',
    );
    ok(texts.some((t) => t.startsWith('BTN:Download your version')), 'button says Download your version');
    if (OUT) {
      require('fs').mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, 'conflict-panel-after.png') });
    }
    ok(errs.length === 0, 'no page errors: ' + errs.join('|'));
    console.log(texts.join('\n'));
  } finally {
    await ctx.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
