      /* ══════════════════════════════════════
         DISTRICT CALENDAR — pure JS
      ══════════════════════════════════════ */
      let dcEvents = [],
        dcViewYear = new Date().getFullYear(),
        dcViewMonth = new Date().getMonth();

      // ── Tab switching ──
      function dcTab(mode, el) {
        document.querySelectorAll('.dc-itab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.dc-input-panel').forEach((p) => p.classList.remove('active'));
        el.classList.add('active');
        document.getElementById('dc-panel-' + mode).classList.add('active');
      }

      // ── URL load ──
      async function dcLoadURL() {
        const url = document.getElementById('dc-url').value.trim();
        if (!url) {
          showToast('Paste a URL first');
          return;
        }
        if (!/^https?:\/\//i.test(url)) {
          showToast('URL must start with https://');
          return;
        }
        dcShowProg('Fetching PDF...');
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const buf = await resp.arrayBuffer();
          dcShowProg('Extracting text from PDF...');
          const text = await dcExtractPDFText(buf);
          dcParseAndRender(text, url.split('/').pop());
        } catch (e) {
          dcHideProg();
          showToast('Fetch failed — try uploading the PDF directly');
          document.getElementById('dcEmpty').style.display = 'block';
        }
      }

      // ── File upload / drop ──
      function dcDrop(e) {
        e.preventDefault();
        document.getElementById('dcDropZone').classList.remove('drag');
        const f = e.dataTransfer.files[0];
        if (f && f.type === 'application/pdf') dcReadFile(f);
        else showToast('Drop a PDF file');
      }
      function dcFileChosen(e) {
        const f = e.target.files[0];
        if (f) dcReadFile(f);
      }
      async function dcReadFile(file) {
        document.getElementById('dcDropLabel').textContent = 'Loading: ' + file.name;
        dcShowProg('Reading PDF...');
        const buf = await file.arrayBuffer();
        dcShowProg('Extracting text from PDF...');
        const text = await dcExtractPDFText(buf);
        dcParseAndRender(text, file.name);
      }

      // ── PDF text extraction via PDF.js ──
      async function dcExtractPDFText(arrayBuffer) {
        if (!window.pdfjsLib) {
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            s.onload = res;
            s.onerror = rej;
            document.head.appendChild(s);
          });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let fullText = '';
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const content = await page.getTextContent();
          const items = content.items.filter((i) => i.str.trim());
          if (!items.length) continue;
          // Reconstruct layout: group by Y position, sort by X within each line
          const yTol = 3;
          const lines = [];
          items.forEach((item) => {
            const x = item.transform[4];
            const y = item.transform[5];
            let line = lines.find((l) => Math.abs(l.y - y) < yTol);
            if (!line) {
              line = { y, items: [] };
              lines.push(line);
            }
            line.items.push({ x, str: item.str, w: item.width || 0 });
          });
          lines.sort((a, b) => b.y - a.y);
          lines.forEach((line) => {
            line.items.sort((a, b) => a.x - b.x);
            let out = '';
            let cursor = 0;
            line.items.forEach((it) => {
              const col = Math.round(it.x / 4);
              if (col > cursor + 1) {
                out += ' '.repeat(Math.min(col - cursor, 40));
              } else if (out.length > 0) {
                out += ' ';
              }
              out += it.str;
              cursor = col + Math.round(it.w / 4);
            });
            fullText += out + '\n';
          });
          fullText += '\n';
        }
        return fullText;
      }

      // ── Text paste parse ──
      function dcParseText() {
        const text = document.getElementById('dist-cal').value.trim();
        if (!text) {
          showToast('Paste calendar text first');
          return;
        }
        dcParseAndRender(text, 'pasted text');
      }

      // ── Core parser: text → events ──
      function dcParseAndRender(text, sourceName) {
        dcHideProg();
        let events = dcExtractCalendarEvents(text);
        if (events.length <= 3) events = dcExtractEvents(text);
        if (!events.length) {
          showToast('No dates found in ' + sourceName + '. Try pasting text instead.');
          document.getElementById('dcEmpty').style.display = 'block';
          return;
        }
        dcEvents = events;
        // Set view to first event month
        const first = new Date(events[0].date + 'T12:00:00');
        dcViewYear = first.getFullYear();
        dcViewMonth = first.getMonth();
        dcRenderAll();
        sset('en_dc_events', { events: dcEvents, viewYear: dcViewYear, viewMonth: dcViewMonth });
        showToast('Loaded ' + events.length + ' events from ' + sourceName + ' ✓');
      }

      // ── Event extraction: regex-based date+keyword detection ──
      function dcExtractEvents(text) {
        const events = [];
        const seen = new Set();

        // Keyword → type mapping (ordered: most specific first)
        const KEYWORDS = [
          { re: /early\s*(release|dismissal|out|close)|half[\s-]day/i, type: 'early', label: 'Early Release' },
          {
            re: /professional\s*dev|prof\.?\s*dev|inservice|in[\s-]service|teacher\s*(work|inst)|pd\s*day/i,
            type: 'pd',
            label: 'Prof Dev',
          },
          {
            re: /no\s*school|school\s*(closed?|not\s*in\s*session|holiday)|classes?\s*(cancel|suspend)/i,
            type: 'noschool',
            label: 'No School',
          },
          { re: /thanksgiving/i, type: 'holiday', label: 'Thanksgiving' },
          { re: /christmas|winter\s*break|holiday\s*break|winter\s*recess/i, type: 'break', label: 'Winter Break' },
          { re: /spring\s*break|spring\s*recess/i, type: 'break', label: 'Spring Break' },
          { re: /fall\s*break|autumn\s*break/i, type: 'break', label: 'Fall Break' },
          { re: /summer\s*break|last\s*day|end\s*of\s*school/i, type: 'break', label: 'Summer Break' },
          { re: /martin\s*luther\s*king|mlk/i, type: 'holiday', label: 'MLK Day' },
          { re: /president'?s?[\s-]*day|presidents?[\s-]*day/i, type: 'holiday', label: "Presidents' Day" },
          { re: /memorial\s*day/i, type: 'holiday', label: 'Memorial Day' },
          { re: /labor\s*day/i, type: 'holiday', label: 'Labor Day' },
          { re: /veterans?[\s-]*day/i, type: 'holiday', label: "Veterans' Day" },
          { re: /independence\s*day|july\s*4th|4th\s*of\s*july/i, type: 'holiday', label: 'Independence Day' },
          { re: /new\s*year/i, type: 'holiday', label: "New Year's" },
          { re: /columbus\s*day|indigenous\s*peoples/i, type: 'holiday', label: 'Columbus Day' },
          { re: /holiday/i, type: 'holiday', label: 'Holiday' },
          { re: /first\s*day|school\s*start|school\s*begin|back\s*to\s*school/i, type: 'event', label: 'First Day' },
          { re: /graduation|commencement/i, type: 'event', label: 'Graduation' },
          { re: /snow\s*day|weather|inclement/i, type: 'noschool', label: 'No School' },
        ];

        const MONTHS_LONG = 'January|February|March|April|May|June|July|August|September|October|November|December';
        const MONTHS_SHORT = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

        // Date patterns to try (order: most specific first)
        const DATE_PATS = [
          // MM/DD/YYYY or MM-DD-YYYY
          /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g,
          // Month DD, YYYY  or  Month DD YYYY
          new RegExp(
            `\\b(${MONTHS_LONG}|${MONTHS_SHORT})\\.?[ \\t\\n\\r]+([0-9]{1,2}),?[ \\t\\n\\r]+([0-9]{4})\\b`,
            'gi',
          ),
          // Month DD (no year — will use guessed year)
          new RegExp(
            `\\b(${MONTHS_LONG}|${MONTHS_SHORT})\\.?[ \\t\\n\\r]+([0-9]{1,2})\\b(?![ \\t\\n\\r]*,?[ \\t\\n\\r]*[0-9]{4})`,
            'gi',
          ),
          // YYYY-MM-DD
          /\b(\d{4})-(\d{2})-(\d{2})\b/g,
        ];

        const MONTH_MAP = {
          january: 0,
          february: 1,
          march: 2,
          april: 3,
          may: 4,
          june: 5,
          july: 6,
          august: 7,
          september: 8,
          october: 9,
          november: 10,
          december: 11,
          jan: 0,
          feb: 1,
          mar: 2,
          apr: 3,
          jun: 5,
          jul: 6,
          aug: 7,
          sep: 8,
          oct: 9,
          nov: 10,
          dec: 11,
        };

        // Split into lines for context-window keyword matching
        const lines = text.split(/\n/);

        function addEvent(dateStr, name, type) {
          if (!_isValidDate(dateStr)) return;
          const key = dateStr + '|' + name;
          if (seen.has(key)) return;
          seen.add(key);
          events.push({ date: dateStr, name, type });
        }

        function guessType(context) {
          for (const kw of KEYWORDS) {
            if (kw.re.test(context)) return { type: kw.type, label: kw.label };
          }
          return null;
        }

        function toISO(y, m, d) {
          return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }

        // Guess the school year from text (e.g. "2025-2026" → start=2025)
        let guessYear = new Date().getFullYear();
        const syMatch = text.match(/\b(20\d\d)[–\-\/](20\d\d)\b/);
        if (syMatch) guessYear = parseInt(syMatch[1]);
        const yearInText = text.match(/\b(20\d\d)\b/);
        if (!syMatch && yearInText) guessYear = parseInt(yearInText[1]);
        const _endYear = syMatch ? parseInt(syMatch[2]) : guessYear + 1;
        const _earliest = new Date(guessYear, 6, 1);
        const _latest = new Date(_endYear, 6, 31);
        function _isValidDate(isoStr) {
          const d = new Date(isoStr + 'T12:00:00');
          return !isNaN(d) && d >= _earliest && d <= _latest;
        }

        // Process each line
        lines.forEach((line) => {
          const kw = guessType(line);
          if (!kw) return; // only process lines that have a keyword

          // Try each date pattern on this line
          let found = false;

          // Pattern 1: MM/DD/YYYY
          let m;
          const p1 = new RegExp(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/, 'g');
          while ((m = p1.exec(line)) !== null) {
            const mo = parseInt(m[1]) - 1,
              d = parseInt(m[2]);
            let y = parseInt(m[3]);
            if (y < guessYear - 1 || y > _endYear + 1) y = mo >= 7 ? guessYear : _endYear;
            if (mo >= 0 && mo < 12 && d >= 1 && d <= 31) {
              addEvent(toISO(y, mo, d), kw.label, kw.type);
              found = true;
            }
          }

          // Pattern 2: Month DD, YYYY
          const p2 = new RegExp(
            `\\b(${MONTHS_LONG}|${MONTHS_SHORT})\\.?[ \\t\\n\\r]+([0-9]{1,2}),?[ \\t\\n\\r]+([0-9]{4})\\b`,
            'gi',
          );
          while ((m = p2.exec(line)) !== null) {
            const mo = MONTH_MAP[m[1].toLowerCase()];
            const d = parseInt(m[2]);
            let y = parseInt(m[3]);
            if (y < guessYear - 1 || y > _endYear + 1) y = mo >= 7 ? guessYear : _endYear;
            if (mo !== undefined && d >= 1 && d <= 31) {
              addEvent(toISO(y, mo, d), kw.label, kw.type);
              found = true;
            }
          }

          // Pattern 3: Month DD (no year)
          if (!found) {
            const p3 = new RegExp(`\\b(${MONTHS_LONG}|${MONTHS_SHORT})\\.?[ \\t\\n\\r]+([0-9]{1,2})\\b`, 'gi');
            while ((m = p3.exec(line)) !== null) {
              const mo = MONTH_MAP[m[1].toLowerCase()];
              const d = parseInt(m[2]);
              if (mo === undefined || d < 1 || d > 31) continue;
              // Pick year: if month is Aug–Dec use guessYear, else guessYear+1
              const y = mo >= 7 ? guessYear : guessYear + 1;
              addEvent(toISO(y, mo, d), kw.label, kw.type);
              found = true;
            }
          }

          // Pattern 4: YYYY-MM-DD
          const p4 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
          while ((m = p4.exec(line)) !== null) {
            let y = parseInt(m[1]);
            const mo = parseInt(m[2]) - 1,
              d = parseInt(m[3]);
            if (y < guessYear - 1 || y > _endYear + 1) y = mo >= 7 ? guessYear : _endYear;
            if (mo >= 0 && mo < 12 && d >= 1 && d <= 31) {
              addEvent(toISO(y, mo, d), kw.label, kw.type);
              found = true;
            }
          }
        });

        // Also scan for date ranges (e.g. "Dec 22 – Jan 3") and expand them
        const rangeRe = new RegExp(
          `(${MONTHS_LONG}|${MONTHS_SHORT})\\.?\\s+(\\d{1,2})\\s*[–\\-—]+\\s*(${MONTHS_LONG}|${MONTHS_SHORT})?\\.?\\s*(\\d{1,2})`,
          'gi',
        );
        let rCtx = text;
        while ((m = rangeRe.exec(rCtx)) !== null) {
          const context = rCtx.substring(Math.max(0, m.index - 80), m.index + m[0].length + 80);
          const kw = guessType(context) || { type: 'noschool', label: 'No School' };
          const mo1 = MONTH_MAP[m[1].toLowerCase()];
          const d1 = parseInt(m[2]);
          const mo2 = m[3] ? MONTH_MAP[m[3].toLowerCase()] : mo1;
          const d2 = parseInt(m[4]);
          if (mo1 === undefined || mo2 === undefined) continue;
          const y1 = mo1 >= 7 ? guessYear : guessYear + 1;
          const y2 = mo2 >= 7 ? guessYear : guessYear + 1;
          // Expand range day by day (cap at 60)
          let cur = new Date(y1, mo1, d1);
          const end = new Date(y2, mo2, d2);
          let cnt = 0;
          while (cur <= end && cnt < 60) {
            addEvent(toISO(cur.getFullYear(), cur.getMonth(), cur.getDate()), kw.label, kw.type);
            cur.setDate(cur.getDate() + 1);
            cnt++;
          }
        }

        return events.sort((a, b) => a.date.localeCompare(b.date));
      }

      // ── Render everything ──
      function dcRenderAll() {
        const dist = document.getElementById('dist-name').value || 'District Calendar';
        const yr = document.getElementById('dist-year').value || '';
        document.getElementById('dcCalTitle').textContent = '📅 ' + dist + (yr ? ' — ' + yr : '');

        // Stats
        const hol = dcEvents.filter((e) => e.type === 'holiday' || e.type === 'noschool').length;
        const early = dcEvents.filter((e) => e.type === 'early').length;
        const pd = dcEvents.filter((e) => e.type === 'pd').length;
        const brk = dcEvents.filter((e) => e.type === 'break').length;
        document.getElementById('dc-s-hol').textContent = hol;
        document.getElementById('dc-s-early').textContent = early;
        document.getElementById('dc-s-pd').textContent = pd;
        document.getElementById('dc-s-break').textContent = brk;

        // BAS schedule
        const os = document.getElementById('dist-occ-s').value || '7:00 AM';
        const oe = document.getElementById('dist-occ-e').value || '5:00 PM';
        const sh = document.getElementById('dist-sh').value || 60;
        const sc = document.getElementById('dist-sc').value || 85;
        const basLines = dcEvents.map((ev) => {
          const d = new Date(ev.date + 'T12:00:00');
          const ds = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
          const schName = ev.name.toUpperCase().replace(/\s+/g, '_').substring(0, 20);
          return `${ds} | ${schName.padEnd(22)} | Unocc | Heat:${sh}°F Cool:${sc}°F | (Normal: ${os}–${oe})`;
        });
        document.getElementById('distBox').textContent =
          `WebCTRL Exception Schedule — ${dist} ${yr}\nGenerated: ${new Date().toLocaleDateString()}\n${'─'.repeat(70)}\n` +
          `DATE       | SCHEDULE NAME            | MODE  | SETPOINTS\n${'─'.repeat(70)}\n` +
          basLines.join('\n');

        // Show elements
        document.getElementById('dcStatsRow').style.display = 'grid';
        document.getElementById('dcEventCard').style.display = 'block';
        document.getElementById('dcBasCard').style.display = 'block';
        document.getElementById('dcCalWrap').style.display = 'block';
        document.getElementById('dcEmpty').style.display = 'none';

        dcRenderCalendar();
        dcRenderEventList();
      }

      // ── Calendar grid ──
      function dcNav(dir) {
        dcViewMonth += dir;
        if (dcViewMonth > 11) {
          dcViewMonth = 0;
          dcViewYear++;
        }
        if (dcViewMonth < 0) {
          dcViewMonth = 11;
          dcViewYear--;
        }
        dcRenderCalendar();
      }
      function dcRenderCalendar() {
        const byDate = {};
        dcEvents.forEach((ev) => {
          if (!byDate[ev.date]) byDate[ev.date] = [];
          byDate[ev.date].push(ev);
        });
        const MO = [
          'January',
          'February',
          'March',
          'April',
          'May',
          'June',
          'July',
          'August',
          'September',
          'October',
          'November',
          'December',
        ];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let html = '';
        for (let m = 0; m < 3; m++) {
          let mo = dcViewMonth + m,
            yr = dcViewYear;
          if (mo > 11) {
            mo -= 12;
            yr++;
          }
          const fd = new Date(yr, mo, 1).getDay();
          const dim = new Date(yr, mo + 1, 0).getDate();
          html += `<div class="dc-month-block"><div class="dc-month-hdr">${MO[mo]} ${yr}</div>
            <div class="dc-dow-row"><div class="dc-dow">Su</div><div class="dc-dow">Mo</div><div class="dc-dow">Tu</div><div class="dc-dow">We</div><div class="dc-dow">Th</div><div class="dc-dow">Fr</div><div class="dc-dow">Sa</div></div>
            <div class="dc-days">`;
          for (let b = 0; b < fd; b++) html += `<div class="dc-day dc-other"></div>`;
          for (let d = 1; d <= dim; d++) {
            const ds = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const evs = byDate[ds] || [];
            const isToday = new Date(yr, mo, d).getTime() === today.getTime();
            html += `<div class="dc-day${isToday ? ' dc-today' : ''}${evs.length ? ' has-ev' : ''}"${evs.length ? ` title="${evs.map((e) => e.name).join(', ')}"` : ''}>
              <div class="dc-day-n">${d}</div>
              <div class="dc-day-evs">${evs
                .slice(0, 2)
                .map((ev) => `<div class="dc-ev-pill ev-${ev.type}">${ev.name}</div>`)
                .join('')}${evs.length > 2 ? `<div class="dc-ev-pill ev-event">+${evs.length - 2}</div>` : ''}</div>
            </div>`;
          }
          html += `</div></div>`;
        }
        document.getElementById('dcCalMonths').innerHTML = html;
      }

      // ── Event list ──
      function dcRenderEventList(filter = '') {
        const fl = filter.toLowerCase();
        const TYPE_COLOR = {
          holiday: 'var(--warn)',
          noschool: 'var(--danger)',
          early: 'var(--violet)',
          pd: 'var(--em2)',
          break: 'var(--em)',
          event: 'var(--lime)',
        };
        const TYPE_LBL = {
          holiday: 'Holiday',
          noschool: 'No School',
          early: 'Early Release',
          pd: 'Prof Dev',
          break: 'Break',
          event: 'Event',
        };
        const filtered = fl
          ? dcEvents.filter((e) => e.name.toLowerCase().includes(fl) || e.type.includes(fl))
          : dcEvents;
        document.getElementById('dcEventList').innerHTML = filtered.length
          ? filtered
              .map((ev) => {
                const d = new Date(ev.date + 'T12:00:00');
                const ds = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                return `<div class="dc-ev-row"><div class="dc-ev-date">${ds}</div><div><div class="dc-ev-name">${ev.name}</div><div class="dc-ev-type-lbl" style="color:${TYPE_COLOR[ev.type] || 'var(--text2)'}">${TYPE_LBL[ev.type] || ev.type}</div></div></div>`;
              })
              .join('')
          : '<div style="font-size:12px;color:var(--text2);padding:6px">No events match.</div>';
      }
      function dcFilterEvents() {
        dcRenderEventList(document.getElementById('dcSearch').value);
      }

      // ── Helpers ──
      function dcShowProg(msg) {
        document.getElementById('dcProgressMsg').textContent = msg;
        document.getElementById('dcProgress').classList.add('show');
      }
      function dcHideProg() {
        document.getElementById('dcProgress').classList.remove('show');
      }
      function dcClear() {
        dcEvents = [];
        localStorage.removeItem('en_dc_events');
        document.getElementById('dist-cal').value = '';
        document.getElementById('dc-url').value = '';
        document.getElementById('dcCalMonths').innerHTML = '';
        document.getElementById('dcCalWrap').style.display = 'none';
        document.getElementById('dcStatsRow').style.display = 'none';
        document.getElementById('dcEventCard').style.display = 'none';
        document.getElementById('dcBasCard').style.display = 'none';
        document.getElementById('dcEmpty').style.display = 'block';
        document.getElementById('dcDropLabel').textContent = 'Drop PDF calendar here or click to browse';
        showToast('Calendar cleared');
      }
      function dcExport() {
        if (!dcEvents.length) {
          showToast('No calendar data to export');
          return;
        }
        const txt = document.getElementById('distBox').textContent;
        const blob = new Blob([txt], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const dist = (document.getElementById('dist-name').value || 'District').replace(/\s+/g, '_');
        a.download = dist + '_Calendar_Schedule.txt';
        a.click();
        showToast('Exported ✓');
      }

      // ── District Calendar CRUD + Parse (new flow) ──
      const DIST_CAL_TYPES = ['Holiday', 'Break', 'Early Release', 'Teacher Day', 'First Day', 'Last Day', 'Other'];

      window._distCalView = window._distCalView || {};
      function distCalToggleView(projId) {
        window._distCalView[projId] = window._distCalView[projId] === 'calendar' ? 'list' : 'calendar';
        renderDistCalTable(projId);
      }
      function renderDistCalTable(projId) {
        const p = projects.find((x) => x.id === projId);
        if (!p) return;
        p.districtCalendar = p.districtCalendar || [];
        const wrap = document.getElementById('distcal-table-' + projId);
        if (!wrap) return;
        if (!p.districtCalendar.length) {
          wrap.innerHTML =
            '<div style="text-align:center;color:var(--text3);padding:30px;font-size:13px">No calendar events yet. Click "+ Add Event" or "Parse from Text" to add district calendar dates.</div>';
          return;
        }
        const rows = p.districtCalendar.sort((a, b) => new Date(a.date) - new Date(b.date));
        const viewMode = window._distCalView[projId] || 'list';
        const toggleBtn = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          <button class="btn btn-ghost btn-sm" onclick="distCalToggleView(${projId})" style="font-size:11px">
            ${viewMode === 'list' ? '📅 Calendar View' : '📋 List View'}
          </button></div>`;

        if (viewMode === 'calendar') {
          const evByDate = {};
          for (const ev of rows) {
            if (!ev.date) continue;
            if (!evByDate[ev.date]) evByDate[ev.date] = [];
            evByDate[ev.date].push(ev);
          }
          const TYPE_COLORS = {
            Holiday: '#ef4444',
            Break: '#f59e0b',
            'Early Release': '#8b5cf6',
            'Teacher Day': '#3b82f6',
            'First Day': '#22c55e',
            'Last Day': '#f97316',
            Conference: '#06b6d4',
            'End of Quarter': '#ec4899',
            Other: '#6b7280',
          };
          const firstEv = rows[0]?.date ? new Date(rows[0].date + 'T12:00:00') : new Date();
          const lastEv = rows[rows.length - 1]?.date ? new Date(rows[rows.length - 1].date + 'T12:00:00') : new Date();
          let startMo = new Date(firstEv.getFullYear(), firstEv.getMonth(), 1);
          const endMo = new Date(lastEv.getFullYear(), lastEv.getMonth() + 1, 0);
          let calHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">';
          while (startMo <= endMo) {
            const yr = startMo.getFullYear(),
              mo = startMo.getMonth();
            const moName = startMo.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            const firstDay = new Date(yr, mo, 1).getDay();
            const daysInMo = new Date(yr, mo + 1, 0).getDate();
            let grid = `<div style="border:1px solid var(--border);border-radius:8px;padding:10px">
              <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:var(--em)">${moName}</div>
              <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px;font-size:10px;text-align:center">
              <div style="color:var(--text3);font-weight:600">Su</div><div style="color:var(--text3);font-weight:600">Mo</div><div style="color:var(--text3);font-weight:600">Tu</div><div style="color:var(--text3);font-weight:600">We</div><div style="color:var(--text3);font-weight:600">Th</div><div style="color:var(--text3);font-weight:600">Fr</div><div style="color:var(--text3);font-weight:600">Sa</div>`;
            for (let e = 0; e < firstDay; e++) grid += '<div></div>';
            for (let d = 1; d <= daysInMo; d++) {
              const iso = yr + '-' + String(mo + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
              const dayEvs = evByDate[iso] || [];
              const bg = dayEvs.length ? TYPE_COLORS[dayEvs[0].type] || '#6b7280' : 'transparent';
              const title = dayEvs.map((e) => e.name + ' (' + e.type + ')').join('\n');
              const opacity = dayEvs.length ? '0.25' : '0';
              grid += `<div style="position:relative;padding:2px;border-radius:3px;min-height:22px" title="${title.replace(/"/g, '&quot;')}">
                <div style="position:absolute;inset:0;background:${bg};opacity:${opacity};border-radius:3px"></div>
                <span style="position:relative;${dayEvs.length ? 'font-weight:700;color:' + bg : 'color:var(--text2)'}">${d}</span></div>`;
            }
            grid += '</div></div>';
            calHtml += grid;
            startMo = new Date(yr, mo + 1, 1);
          }
          calHtml += '</div>';
          const legend = Object.entries(TYPE_COLORS)
            .map(
              ([t, c]) =>
                `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:10px;font-size:10px"><span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block"></span>${t}</span>`,
            )
            .join('');
          wrap.innerHTML = toggleBtn + `<div style="margin-bottom:10px">${legend}</div>` + calHtml;
          return;
        }

        wrap.innerHTML =
          toggleBtn +
          `<table class="dtbl" style="width:100%">
          <thead><tr><th style="width:140px">Date</th><th>Event Name</th><th style="width:140px">Type</th><th style="width:36px"></th></tr></thead>
          <tbody>${rows
            .map((ev, i) => {
              const selType = ev.type || 'Other';
              const opts = DIST_CAL_TYPES.map((t) => `<option${t === selType ? ' selected' : ''}>${t}</option>`).join(
                '',
              );
              return `<tr>
            <td><input class="fi" type="date" value="${ev.date || ''}" onchange="distCalUpdate(${projId},${i},'date',this.value)" style="font-family:var(--mono)"></td>
            <td><input class="fi" value="${esc(ev.name || '')}" onchange="distCalUpdate(${projId},${i},'name',this.value)" style="width:100%"></td>
            <td><select class="fs" onchange="distCalUpdate(${projId},${i},'type',this.value)">${opts}</select></td>
            <td><button class="btn-del" onclick="distCalRemove(${projId},${i})">✕</button></td>
          </tr>`;
            })
            .join('')}</tbody>
        </table>`;
      }

      function distCalAddRow(projId) {
        const p = projects.find((x) => x.id === projId);
        if (!p) return;
        p.districtCalendar = p.districtCalendar || [];
        p.districtCalendar.push({ id: Date.now(), date: '', name: '', type: 'Holiday' });
        sset('en_projects', projects);
        renderDistCalTable(projId);
      }

      function distCalUpdate(projId, idx, field, val) {
        const p = projects.find((x) => x.id === projId);
        if (!p) return;
        if (!p.districtCalendar[idx]) return;
        p.districtCalendar[idx][field] = val;
        sset('en_projects', projects);
      }

      function distCalRemove(projId, idx) {
        const p = projects.find((x) => x.id === projId);
        if (!p) return;
        p.districtCalendar.splice(idx, 1);
        sset('en_projects', projects);
        renderDistCalTable(projId);
      }

      function distCalDeleteAll(projId) {
        const p = projects.find((x) => x.id === projId);
        if (!p) return;
        const count = (p.districtCalendar || []).length;
        if (count === 0) {
          showToast('No calendar events to delete');
          return;
        }
        if (
          !confirm(
            'Are you sure you want to delete all ' +
              count +
              ' calendar events for this project? This cannot be undone.',
          )
        )
          return;
        p.districtCalendar = [];
        sset('en_projects', projects);
        renderDistCalTable(projId);
        showToast('All calendar events deleted');
      }

      function distCalShowImport(projId) {
        document.getElementById('distcal-import-' + projId).style.display = '';
      }
      function distCalImportTab(projId, mode, btn) {
        btn.parentElement.querySelectorAll('.ptpill').forEach((b) => b.classList.remove('sel'));
        btn.classList.add('sel');
        ['url', 'pdf', 'text'].forEach((m) => {
          const el = document.getElementById('distcal-import-' + m + '-' + projId);
          if (el) el.style.display = m === mode ? '' : 'none';
        });
      }
      async function distCalLoadURL(projId) {
        const url = document.getElementById('distcal-url-' + projId)?.value?.trim();
        if (!url) {
          showToast('Paste a URL first');
          return;
        }
        if (!/^https?:\/\//i.test(url)) {
          showToast('URL must start with https://');
          return;
        }
        const status = document.getElementById('distcal-import-status-' + projId);
        if (status) {
          status.style.display = '';
          status.textContent = 'Fetching PDF...';
        }
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const buf = await resp.arrayBuffer();
          if (status) status.textContent = 'Extracting text from PDF...';
          const text = await dcExtractPDFText(buf);
          distCalProcessText(projId, text);
        } catch (e) {
          if (status) {
            status.textContent = 'Fetch failed — try uploading the PDF directly';
          }
          showToast('Could not fetch URL — try PDF upload instead');
        }
      }
      function distCalDropFile(e, projId) {
        e.preventDefault();
        e.currentTarget.style.borderColor = 'var(--border2)';
        const f = e.dataTransfer.files[0];
        if (f && f.type === 'application/pdf') distCalReadFile(f, projId);
        else showToast('Drop a PDF file');
      }
      function distCalFileChosen(e, projId) {
        const f = e.target.files[0];
        if (f) distCalReadFile(f, projId);
      }
      async function distCalReadFile(file, projId) {
        const status = document.getElementById('distcal-import-status-' + projId);
        if (status) {
          status.style.display = '';
          status.textContent = 'Reading: ' + file.name + '...';
        }
        const buf = await file.arrayBuffer();
        if (status) status.textContent = 'Extracting text from PDF...';
        const text = await dcExtractPDFText(buf);
        distCalProcessText(projId, text);
      }
      // #74: Store pending import events keyed by projId for the preview/approval flow
      window._distCalPendingImport = window._distCalPendingImport || {};

      function distCalProcessText(projId, text) {
        const events = dcExtractCalendarEvents(text);
        const status = document.getElementById('distcal-import-status-' + projId);
        if (!events.length) {
          if (status) status.textContent = 'No events found — try different source';
          showToast('No events found');
          return;
        }
        // #74: Show preview instead of saving immediately
        if (status) status.style.display = 'none';
        distCalShowPreview(projId, events);
      }

      function distCalParse(projId) {
        document.getElementById('distcal-parse-' + projId).style.display = '';
      }

      function distCalRunParse(projId) {
        const text = document.getElementById('distcal-text-' + projId)?.value || '';
        if (!text.trim()) {
          showToast('Paste calendar text first');
          return;
        }
        const events = dcExtractCalendarEvents(text);
        if (!events.length) {
          showToast('No events found — try different text');
          return;
        }
        // #74: Show preview instead of saving immediately
        distCalShowPreview(projId, events);
      }

      // #74: Render an editable preview table of extracted events before saving
      function distCalShowPreview(projId, events) {
        // Store pending events so rows can be edited/deleted before confirm
        window._distCalPendingImport[projId] = events.map((ev, i) => ({ ...ev, _previewIdx: i, _deleted: false }));
        _distCalRenderPreview(projId);
      }

      function _distCalRenderPreview(projId) {
        const pending = window._distCalPendingImport[projId] || [];
        const active = pending.filter((r) => !r._deleted);
        const _scrollContainer = document.querySelector('#distcal-preview-' + projId + ' [style*="overflow-y"]');
        const _savedScroll = _scrollContainer ? _scrollContainer.scrollTop : 0;
        // Build preview table HTML; inject into a dedicated preview div inside the card
        let previewEl = document.getElementById('distcal-preview-' + projId);
        if (!previewEl) {
          // Create the preview container right before the table div
          const tableDiv = document.getElementById('distcal-table-' + projId);
          if (!tableDiv) return;
          previewEl = document.createElement('div');
          previewEl.id = 'distcal-preview-' + projId;
          tableDiv.parentNode.insertBefore(previewEl, tableDiv);
        }
        if (active.length === 0) {
          previewEl.innerHTML =
            '<div style="padding:10px;color:var(--text3);font-size:13px">All events removed from preview.</div>';
          return;
        }
        const opts = DIST_CAL_TYPES.map((t) => `<option>${t}</option>`).join('');
        let rows = '';
        pending.forEach((ev, i) => {
          if (ev._deleted) return;
          const selOpts = DIST_CAL_TYPES.map(
            (t) => `<option${t === (ev.type || 'Other') ? ' selected' : ''}>${t}</option>`,
          ).join('');
          rows += `<tr>
            <td style="padding:3px 5px"><input class="fi" type="date" value="${ev.date || ''}" onchange="window._distCalPendingImport[${projId}][${i}].date=this.value" style="font-family:var(--mono)"></td>
            <td style="padding:3px 5px"><input class="fi" value="${esc(ev.name || '')}" onchange="window._distCalPendingImport[${projId}][${i}].name=this.value" style="width:100%"></td>
            <td style="padding:3px 5px"><select class="fs" onchange="window._distCalPendingImport[${projId}][${i}].type=this.value">${selOpts}</select></td>
            <td style="padding:3px 5px"><button class="btn-del" onclick="window._distCalPendingImport[${projId}][${i}]._deleted=true;_distCalRenderPreview(${projId})">✕</button></td>
          </tr>`;
        });
        previewEl.innerHTML = `
          <div style="border:1px solid var(--border2);border-radius:8px;padding:12px;margin-bottom:12px;background:var(--s2)">
            <div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--em)">Preview — ${active.length} event${active.length !== 1 ? 's' : ''} extracted</div>
            <div style="font-size:11px;color:var(--text3);margin-bottom:10px">Review the events below. Edit dates or names, delete unwanted rows, then click <strong>Approve &amp; Save</strong> to add them to your calendar. Nothing is saved until you confirm.</div>
            <div style="max-height:480px;overflow-y:auto;margin-bottom:10px">
              <table class="dtbl" style="width:100%">
                <thead><tr><th style="width:140px">Date</th><th>Event Name</th><th style="width:140px">Type</th><th style="width:36px"></th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button class="btn btn-ghost btn-sm" onclick="_distCalCancelPreview(${projId})">Cancel</button>
              <button class="btn btn-em btn-sm" onclick="_distCalApproveImport(${projId})">Approve &amp; Save (${active.length})</button>
            </div>
          </div>`;
        // Restore scroll position after re-render
        if (_savedScroll > 0) {
          const _newScroll = previewEl.querySelector('[style*="overflow-y"]');
          if (_newScroll) _newScroll.scrollTop = _savedScroll;
        }
        // Hide the import panel while preview is shown
        const importEl = document.getElementById('distcal-import-' + projId);
        if (importEl) importEl.style.display = 'none';
      }

      function _distCalCancelPreview(projId) {
        delete window._distCalPendingImport[projId];
        const previewEl = document.getElementById('distcal-preview-' + projId);
        if (previewEl) previewEl.innerHTML = '';
        showToast('Import cancelled');
      }

      function _distCalApproveImport(projId) {
        const pending = window._distCalPendingImport[projId] || [];
        const active = pending.filter((r) => !r._deleted);
        if (!active.length) {
          showToast('No events to import');
          return;
        }
        const p = projects.find((x) => x.id === projId);
        if (!p) return;
        p.districtCalendar = p.districtCalendar || [];
        let added = 0;
        active.forEach((ev) => {
          if (!p.districtCalendar.some((e) => e.date === ev.date && e.name === ev.name)) {
            p.districtCalendar.push({
              id: Date.now() + Math.random(),
              date: ev.date,
              name: ev.name,
              type: ev.type || 'Other',
            });
            added++;
          }
        });
        sset('en_projects', projects);
        delete window._distCalPendingImport[projId];
        const previewEl = document.getElementById('distcal-preview-' + projId);
        if (previewEl) previewEl.innerHTML = '';
        renderDistCalTable(projId);
        showToast(added + ' events imported ✓');
      }

      function dcExtractCalendarEvents(text) {
        const events = [];
        // Bug 079df33b: dedup set keyed on "date|name" so same event text on
        // different dates is NOT a duplicate, and different events on the same
        // date are NOT a duplicate. Only identical date+name pairs are dupes.
        const _dcSeen = new Set();
        const monthMap = {
          january: 1,
          february: 2,
          march: 3,
          april: 4,
          may: 5,
          june: 6,
          july: 7,
          august: 8,
          september: 9,
          october: 10,
          november: 11,
          december: 12,
          jan: 1,
          feb: 2,
          mar: 3,
          apr: 4,
          jun: 6,
          jul: 7,
          aug: 8,
          sep: 9,
          oct: 10,
          nov: 11,
          dec: 12,
        };
        const typeKeywords = {
          Holiday:
            /holiday|mlk|martin luther|presidents|memorial|labor day|independence|thanksgiving|christmas|new year|veteran/i,
          Break: /break|recess/i,
          'Early Release': /early release|early dismiss|early out|half day|early dismissal/i,
          'Teacher Day': /teacher|in-?service|professional dev|pd day|staff dev|workday|planning|staff pd|onboarding/i,
          'First Day': /first day|1st day|school (begins|starts|resumes)/i,
          'Last Day': /last day|last school|school ends|commencement|graduation/i,
          Conference: /conference|pt conference/i,
          'End of Quarter': /end of.*quarter|end of.*semester/i,
        };
        function detectType(name) {
          for (const [type, re] of Object.entries(typeKeywords)) {
            if (re.test(name)) return type;
          }
          return 'Other';
        }

        // Match "2025-2026 School Year" or plain "2025-2026" or "2025–26"
        const yearMatch =
          text.match(/(\d{4})\s*[-–]\s*(\d{4})\s+(?:School|District|Academic)/i) ||
          text.match(/\b(20\d{2})\s*[-–]\s*(20\d{2})\b/) ||
          text.match(/\b(20\d{2})\s*[-–]\s*(\d{2})\b/);
        let startSchoolYear = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();
        let endSchoolYear = yearMatch
          ? yearMatch[2].length === 2
            ? startSchoolYear - (startSchoolYear % 100) + parseInt(yearMatch[2])
            : parseInt(yearMatch[2])
          : startSchoolYear + 1;
        // Sanity: endSchoolYear should be startSchoolYear+1 for a school year
        if (endSchoolYear <= startSchoolYear) endSchoolYear = startSchoolYear + 1;
        function yearForMonth(mo) {
          return mo >= 8 ? startSchoolYear : endSchoolYear;
        }
        // Reject dates outside the school year range (July start year – July end year)
        const _syEarliest = new Date(startSchoolYear, 6, 1);
        const _syLatest = new Date(endSchoolYear, 6, 31);
        function isValidSchoolDate(dateStr) {
          const d = new Date(dateStr + 'T12:00:00');
          return !isNaN(d) && d >= _syEarliest && d <= _syLatest;
        }

        const monthYearMap = {};
        // Match "August - 2025", "August – 25", "August 2025", "August-25"
        const myRe =
          /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s*[-–]?\s*(\d{2,4})\b/gi;
        let myM;
        while ((myM = myRe.exec(text)) !== null) {
          const mo = monthMap[myM[1].toLowerCase()];
          let yr = parseInt(myM[2]);
          if (yr < 100) yr += 2000;
          if (yr < 2000 || yr > 2099) continue; // skip bad years
          if (mo) monthYearMap[mo] = yr;
        }

        const MONTH_NAMES_RE = 'JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER';
        const monthHeaderRe = new RegExp('\\b(' + MONTH_NAMES_RE + ')\\b', 'gi');
        const monthHeaderStartRe = new RegExp('^(' + MONTH_NAMES_RE + ')\\b', 'i');

        // Filter out calendar grid rows and month-year labels (e.g. "August-25")
        const rawLines = text.split(/\n/).filter((l) => {
          if (/\bSU\s+M\s+T\s+W\b/i.test(l)) return false;
          if (/^\s*\d[\d\s]*$/.test(l.trim())) return false;
          if (
            /^\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s*[-–]\s*\d{2,4}\s*$/i.test(
              l.trim(),
            )
          )
            return false;
          return true;
        });

        // Detect events section: find the first line containing a month header
        // that is NOT a month-year label. The events section has month names
        // followed by "day - description" patterns on subsequent lines.
        let eventsStartIdx = -1;
        for (let i = 0; i < rawLines.length; i++) {
          if (monthHeaderStartRe.test(rawLines[i].trim())) {
            eventsStartIdx = i;
            break;
          }
        }
        if (eventsStartIdx < 0) return events;
        const eventLines = rawLines.slice(eventsStartIdx);

        // Detect multi-column layout: find a line with 2+ month headers.
        // Use header character positions to determine column boundaries.
        let colBounds = null;
        for (const line of eventLines) {
          const headers = [];
          let hm;
          const re = new RegExp(monthHeaderRe.source, 'gi');
          while ((hm = re.exec(line)) !== null) {
            headers.push({ name: hm[1], pos: hm.index });
          }
          if (headers.length >= 2) {
            colBounds = [];
            for (let c = 0; c < headers.length; c++) {
              const start =
                c === 0 ? 0 : Math.floor((headers[c - 1].pos + headers[c - 1].name.length + headers[c].pos) / 2);
              colBounds.push(start);
            }
            break;
          }
        }

        // Split each line into column segments, then process each column
        // independently with its own month context.
        const numCols = colBounds ? colBounds.length : 1;
        const colStreams = Array.from({ length: numCols }, () => []);

        const _isColStart = (s) =>
          /^(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\b/i.test(s) ||
          /^\d{1,2}(?:-\d{1,2})?\s*[-–]/.test(s);

        // Also build a per-column month-header map by scanning all lines that have
        // month headers, so each column's month context can be set from the header row
        // rather than relying solely on in-stream detection (fixes off-by-month errors).
        const colMonthMap = Array.from({ length: numCols }, () => ({})); // col -> {pos: {mo,yr}}
        if (colBounds) {
          for (const line of eventLines) {
            const re = new RegExp(monthHeaderRe.source, 'gi');
            let hm2;
            while ((hm2 = re.exec(line)) !== null) {
              const mo = monthMap[hm2[1].toLowerCase()];
              if (!mo) continue;
              // Determine which column this header falls in
              let col = 0;
              for (let c = numCols - 1; c >= 0; c--) {
                if (hm2.index >= colBounds[c]) {
                  col = c;
                  break;
                }
              }
              const yr = monthYearMap[mo] || yearForMonth(mo);
              colMonthMap[col][mo] = yr;
            }
          }
        }

        eventLines.forEach((line) => {
          if (!colBounds) {
            colStreams[0].push(line.trim());
            return;
          }
          const segs = [];
          for (let c = 0; c < numCols; c++) {
            const start = colBounds[c];
            const end = c < numCols - 1 ? colBounds[c + 1] : line.length;
            segs.push((start < line.length ? line.substring(start, end) : '').trim());
          }
          // Route each segment to its correct column stream.
          // A segment belongs to column c if it starts with a month header or a day-event
          // pattern (e.g. "15 – No School"). Segments that are clearly continuations of a
          // multi-word name from the previous column get merged back into that column.
          const pushed = new Array(numCols).fill(false);
          for (let c = 0; c < numCols; c++) {
            if (!segs[c]) continue;
            if (c > 0 && !_isColStart(segs[c])) {
              // Continuation of previous column — append, do not push separately
              if (!pushed[c - 1] && segs[c - 1]) {
                segs[c - 1] = (segs[c - 1] + ' ' + segs[c]).trim();
              } else {
                // Previous already pushed; append directly to the last entry of that stream
                const prev = colStreams[c - 1];
                if (prev.length) prev[prev.length - 1] = (prev[prev.length - 1] + ' ' + segs[c]).trim();
              }
              segs[c] = '';
              continue;
            }
            colStreams[c].push(segs[c]);
            pushed[c] = true;
          }
        });

        // Process each column stream: track current month, parse events
        colStreams.forEach((stream) => {
          let curMonth = null;
          let curYear = startSchoolYear;

          stream.forEach((seg) => {
            // Check for month header(s) in this segment
            const hm = seg.match(monthHeaderStartRe);
            if (hm) {
              curMonth = monthMap[hm[1].toLowerCase()];
              curYear = monthYearMap[curMonth] || yearForMonth(curMonth);
              seg = seg.slice(hm[0].length).trim();
              if (!seg) return;
            }
            if (curMonth === null) return;

            // Check if segment contains an inline month header mid-text
            // e.g. "1st Day for Preschool, 6th, 9th Grade DECEMBER"
            // Split at inline headers and process each part
            const inlineRe = new RegExp('[ \\t\\n\\r]+(' + MONTH_NAMES_RE + ')\\b', 'gi');
            let lastIdx = 0;
            let imatch;
            const parts = [];
            while ((imatch = inlineRe.exec(seg)) !== null) {
              if (imatch.index > lastIdx) {
                parts.push({ text: seg.slice(lastIdx, imatch.index).trim(), month: curMonth, year: curYear });
              }
              curMonth = monthMap[imatch[1].toLowerCase()];
              curYear = monthYearMap[curMonth] || yearForMonth(curMonth);
              lastIdx = imatch.index + imatch[0].length;
            }
            if (lastIdx < seg.length) {
              parts.push({ text: seg.slice(lastIdx).trim(), month: curMonth, year: curYear });
            }

            parts.forEach((part) => {
              if (!part.text) return;
              _parseMonthEvents(part.text, part.month, part.year, events, detectType, isValidSchoolDate, _dcSeen);
            });
          });
        });

        // Fallback: if column-based parse found very few events, try a
        // direct global scan for date tokens (Strategy 2).
        if (events.length <= 3) {
          events.length = 0;
          const dateRe =
            /(\d{1,2})\/(\d{1,2})\/(\d{2,4})|(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?,?\s*(\d{4})?/gi;
          const hits = [];
          let mm;
          while ((mm = dateRe.exec(text)) !== null) {
            let iso, dayEnd;
            if (mm[1]) {
              let yr = parseInt(mm[3]) || startSchoolYear;
              if (String(mm[3]).length === 2) yr = 2000 + yr;
              // Override impossible years with school-year-aware guess
              if (yr < startSchoolYear - 1 || yr > endSchoolYear + 1) {
                const mo = parseInt(mm[1]);
                yr = mo >= 8 ? startSchoolYear : endSchoolYear;
              }
              iso = yr + '-' + String(mm[1]).padStart(2, '0') + '-' + String(mm[2]).padStart(2, '0');
              dayEnd = parseInt(mm[2]);
            } else {
              const mo = monthMap[mm[4].toLowerCase().replace(/\.$/, '')];
              if (!mo) continue;
              const yr = mm[7] || monthYearMap[mo] || yearForMonth(mo);
              iso = yr + '-' + String(mo).padStart(2, '0') + '-' + String(mm[5]).padStart(2, '0');
              dayEnd = mm[6] ? parseInt(mm[6]) : parseInt(mm[5]);
            }
            if (!isValidSchoolDate(iso)) continue;
            hits.push({ idx: mm.index, end: mm.index + mm[0].length, iso, dayEnd, match: mm[0] });
          }
          for (let i = 0; i < hits.length; i++) {
            const h = hits[i];
            const sliceEnd = i < hits.length - 1 ? hits[i + 1].idx : Math.min(text.length, h.end + 160);
            let name = text
              .slice(h.end, sliceEnd)
              .replace(/\s+/g, ' ')
              .replace(/^[\s\-–—:,]+/, '')
              .replace(/[\s\-–—:,]+$/, '')
              .trim();
            const stop = name.search(/\s(?:•|·|\|)\s|\s{3,}/);
            if (stop > 2) name = name.slice(0, stop).trim();
            if (name.length < 2 || name.length > 80) continue;
            // Bug 079df33b: dedup by date+name, not date or name alone
            const _fbKey = h.iso + '|' + name;
            if (!_dcSeen.has(_fbKey)) {
              _dcSeen.add(_fbKey);
              events.push({ date: h.iso, name, type: detectType(name) });
            }
            if (h.dayEnd && /\d{4}-\d{2}-(\d{2})$/.test(h.iso)) {
              const startDay = parseInt(h.iso.slice(-2));
              for (let d = startDay + 1; d <= h.dayEnd; d++) {
                const isoD = h.iso.slice(0, 8) + String(d).padStart(2, '0');
                const _fbKeyD = isoD + '|' + name;
                if (!_dcSeen.has(_fbKeyD)) {
                  _dcSeen.add(_fbKeyD);
                  events.push({ date: isoD, name, type: detectType(name) });
                }
              }
            }
          }
        }
        return events;
      }

      function _parseMonthEvents(text, month, year, events, detectType, dateValidator, seen) {
        // Bug 079df33b: seen is a Set used for dedup keyed on "date|name".
        // Two events are only duplicates when BOTH date AND name match.
        // Match: "15 – Description" or "15-17 – Description" or "15- Description"
        // Allow any whitespace (including none) after the separating dash/en-dash.
        //
        // Cross-month range support (bug 772d1832): detect patterns like
        // "22-January 2 – Winter Recess" where the range end is in the next month.
        // The month name map (1-indexed) for cross-month detection:
        const _xMonthMap = {
          january: 1,
          february: 2,
          march: 3,
          april: 4,
          may: 5,
          june: 6,
          july: 7,
          august: 8,
          september: 9,
          october: 10,
          november: 11,
          december: 12,
          jan: 1,
          feb: 2,
          mar: 3,
          apr: 4,
          jun: 6,
          jul: 7,
          aug: 8,
          sep: 9,
          oct: 10,
          nov: 11,
          dec: 12,
        };
        const _MNRE =
          'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
        // Cross-month range: "D1-MonthName D2" or "D1 – MonthName D2" preceding a description
        const xRangeRe = new RegExp('(?:^|\\b)(\\d{1,2})\\s*[-–]\\s*(' + _MNRE + ')\\s+(\\d{1,2})\\s*[-–]\\s*', 'gi');
        let xm;
        const xRangeHandled = [];
        while ((xm = xRangeRe.exec(text)) !== null) {
          const d1 = parseInt(xm[1]);
          const mo2 = _xMonthMap[xm[2].toLowerCase()];
          const d2 = parseInt(xm[3]);
          if (!mo2 || d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) continue;
          // Description follows the full match
          const descRaw = text
            .slice(xm.index + xm[0].length)
            .replace(/[\s;,]+$/, '')
            .split(/\n/)[0]
            .trim();
          const descClean = descRaw.replace(/[\s;,]+$/, '');
          if (!descClean || descClean.length < 2) continue;
          const type = detectType(descClean);
          // Emit days from d1 to end-of-month in current month
          for (let d = d1; d <= 31; d++) {
            const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            if (!dateValidator || dateValidator(dateStr)) {
              const dk = dateStr + '|' + descClean;
              if (!seen || !seen.has(dk)) {
                if (seen) seen.add(dk);
                events.push({ date: dateStr, name: descClean, type });
              }
            }
          }
          // Emit days from start-of-next-month to d2
          // Next month year: if current month is December (12), next month is January of endYear
          const mo2year = mo2 === 1 && month === 12 ? year + 1 : mo2 >= 8 ? year : year + 1;
          for (let d = 1; d <= d2; d++) {
            const dateStr = mo2year + '-' + String(mo2).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            if (!dateValidator || dateValidator(dateStr)) {
              const dk = dateStr + '|' + descClean;
              if (!seen || !seen.has(dk)) {
                if (seen) seen.add(dk);
                events.push({ date: dateStr, name: descClean, type });
              }
            }
          }
          xRangeHandled.push({ start: xm.index, end: xm.index + xm[0].length + descClean.length });
        }

        const re = /(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*[-–]\s*/g;
        let m;
        const positions = [];
        while ((m = re.exec(text)) !== null) {
          const d1 = parseInt(m[1]);
          // Reject: looks like a year (e.g. 2025) or clearly out-of-range day
          if (d1 < 1 || d1 > 31) continue;
          // Reject if the character right before is a digit (mid-number match)
          if (m.index > 0 && /\d/.test(text[m.index - 1])) continue;
          // Skip if this position was already handled by the cross-month range parser
          if (xRangeHandled.some((r) => m.index >= r.start && m.index < r.end)) continue;
          positions.push({
            idx: m.index,
            dayStart: d1,
            dayEnd: m[2] ? parseInt(m[2]) : d1,
            descStart: m.index + m[0].length,
          });
        }
        for (let i = 0; i < positions.length; i++) {
          const descEnd = i < positions.length - 1 ? positions[i + 1].idx : text.length;
          let desc = text
            .slice(positions[i].descStart, descEnd)
            .trim()
            .replace(/[\s;,]+$/, '');
          // Strip leading cross-month suffix like "January 2 –" from description
          // so it doesn't appear as event name (e.g. "January 2 – Winter Recess" → "Winter Recess")
          const xSuffixRe = new RegExp('^(?:' + _MNRE + ')\\s+\\d{1,2}\\s*[-–]\\s*', 'i');
          const xSuffix = desc.match(xSuffixRe);
          if (xSuffix) desc = desc.slice(xSuffix[0].length).trim();
          if (!desc || desc.length < 2) continue;
          const type = detectType(desc);
          for (let d = positions[i].dayStart; d <= positions[i].dayEnd; d++) {
            if (d < 1 || d > 31) continue;
            const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            if (dateValidator && !dateValidator(dateStr)) continue;
            const dedupKey = dateStr + '|' + desc;
            if (seen && seen.has(dedupKey)) continue;
            if (seen) seen.add(dedupKey);
            events.push({ date: dateStr, name: desc, type });
          }
        }
      }

      // ── Legacy shims for per-project district tab ──
      async function parseDistCal() {
        dcParseText();
      }
      async function parseProjDistCal(projId) {
        const cal = document.getElementById('dist-cal-' + projId)?.value || '';
        if (!cal) {
          showToast('Paste calendar text first');
          return;
        }
        const box = document.getElementById('dist-box-' + projId);
        const events = dcExtractEvents(cal);
        if (!events.length) {
          box.textContent =
            'No dates found. Make sure the calendar text includes dates and keywords like "no school", "holiday", "early release", etc.';
          return;
        }
        const os = document.getElementById('dist-occ-s-' + projId)?.value || '7:00 AM';
        const oe = document.getElementById('dist-occ-e-' + projId)?.value || '5:00 PM';
        const sh = document.getElementById('dist-sh-' + projId)?.value || 60;
        const sc = document.getElementById('dist-sc-' + projId)?.value || 85;
        const dist = document.getElementById('dist-name-' + projId)?.value || 'District';
        const lines = events.map((ev) => {
          const d = new Date(ev.date + 'T12:00:00').toLocaleDateString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric',
          });
          return `${d} | ${ev.name.substring(0, 22).padEnd(22)} | Unocc | Heat:${sh}°F Cool:${sc}°F`;
        });
        box.textContent =
          `${dist} — WebCTRL Exception Schedule\nOccupied: ${os}–${oe}\n${'─'.repeat(60)}\n` +
          lines.join('\n') +
          `\n\nTotal events: ${events.length}`;
      }

      /* ── EQUIPMENT ── */
      function renderEquip() {
        const q = (document.getElementById('equipQ')?.value || '').toLowerCase();
        const tbody = document.getElementById('equipBody');
        if (!tbody) return;
        tbody.innerHTML = equipment
          .filter((e) => (e.tag + e.type + e.make + e.model + e.loc).toLowerCase().includes(q))
          .map(
            (e) => `<tr>
          <td><span class="eq-tag">${e.tag}</span></td><td>${e.type}</td><td>${e.make} ${e.model}</td>
          <td>${e.cap || '—'}</td><td>${e.eff || '—'}</td>
          <td style="font-size:12px;color:var(--text2)">${e.loc || '—'}</td>
          <td style="font-size:12px;color:var(--text2)">${e.notes || '—'}</td>
          <td><button class="btn-del" onclick="removeEquip(${e.id})">✕</button></td>
        </tr>`,
          )
          .join('');
      }
      function openEquipModal() {
        document.getElementById('equipModal').classList.add('open');
      }
      function closeEquipModal() {
        document.getElementById('equipModal').classList.remove('open');
      }
      function saveEquip() {
        const tag = document.getElementById('eq-tag').value.trim();
        if (!tag) {
          showToast('Enter equipment tag');
          return;
        }
        equipment.push({
          id: Date.now(),
          tag,
          type: document.getElementById('eq-type').value,
          make: document.getElementById('eq-make').value,
          model: document.getElementById('eq-model').value,
          cap: document.getElementById('eq-cap').value,
          eff: document.getElementById('eq-eff').value,
          loc: document.getElementById('eq-loc').value,
          notes: document.getElementById('eq-notes').value,
        });
        sset('en_equipment', equipment);
        closeEquipModal();
        renderEquip();
        updateHomeStats();
        showToast(tag + ' added ✓');
        ['eq-tag', 'eq-make', 'eq-model', 'eq-cap', 'eq-eff', 'eq-loc', 'eq-notes'].forEach(
          (id) => (document.getElementById(id).value = ''),
        );
      }
      function removeEquip(id) {
        equipment = equipment.filter((e) => e.id !== id);
        sset('en_equipment', equipment);
        renderEquip();
        updateHomeStats();
      }

      /* ── DRAWINGS ── */
      async function handleDrawingUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        const box = document.getElementById('dwgBox');
        box.innerHTML =
          '<div class="ai-thinking"><div class="tdots"><span></span><span></span><span></span></div> Analyzing drawing...</div>';
        const reader = new FileReader();
        reader.onload = async (ev) => {
          const b64 = ev.target.result.split(',')[1];
          const result = await claudePDF(
            'Analyze this construction drawing. Identify all equipment tags, system types, control points, equipment schedules, notes, and information relevant to controls programming or commissioning.',
            b64,
            'You are an expert controls engineer analyzing mechanical and electrical construction drawings.',
          );
          box.textContent = result;
          showToast('Drawing analyzed ✓');
        };
        reader.readAsDataURL(file);
      }

      /* ── SPEC WRITER ── */
      async function writeSpec() {
        const out = document.getElementById('specOut');
        const systems = [...document.querySelectorAll('.schip.sel')].map((b) => b.dataset.sys).join(', ');
        if (!systems) {
          showToast('Select at least one system type');
          return;
        }
        out.textContent = 'Generating specification...';
        const result = await claude(
          `Write a complete Division 25 controls spec for:\nProject: ${document.getElementById('sp-proj').value || '[Project]'}\nOwner: ${document.getElementById('sp-owner').value || '[Owner]'}\nBuilding: ${document.getElementById('sp-bldg').value || '[Building]'}\nBAS: ${document.getElementById('sp-bas').value}\nSystems: ${systems}\nNotes: ${document.getElementById('sp-notes').value || 'None'}\n\nInclude for each system: Sequences, Control Points, Setpoints, Alarms, Commissioning requirements.`,
          'You are an expert controls engineer writing Division 25 specifications.',
        );
        out.textContent = result;
      }

      /* ── CONTRACTS ── */
      let contractTemplate = '';
      const DEFAULT_CONTRACT = `SERVICE AGREEMENT\n\nThis agreement is entered between [COMPANY_NAME] ("Contractor") and [CLIENT_NAME] ("Client").\n\nProject: [PROJECT_NAME]\nAddress: [PROJECT_ADDRESS]\nContract Value: $[CONTRACT_VALUE]\nStart Date: [START_DATE]\nEnd Date: [END_DATE]\n\nSCOPE OF WORK:\n[SCOPE_OF_WORK]\n\nPAYMENT TERMS:\n[PAYMENT_TERMS]\n\nWARRANTY:\nContractor warrants all work for [WARRANTY_PERIOD] from completion.\n\n___________________\nContractor Signature\n\n___________________\nClient Signature`;
      const CONTRACT_VARS = [
        'CLIENT_NAME',
        'PROJECT_NAME',
        'PROJECT_ADDRESS',
        'CONTRACT_VALUE',
        'START_DATE',
        'END_DATE',
        'SCOPE_OF_WORK',
        'PAYMENT_TERMS',
        'WARRANTY_PERIOD',
        'COMPANY_NAME',
      ];
      function loadDefaultTemplate() {
        contractTemplate = DEFAULT_CONTRACT;
        document.getElementById('tmplStatus').innerHTML =
          '<div style="font-size:13px;color:var(--em)">✓ Generic template loaded</div>';
        document.getElementById('contractVarsCard').style.display = 'block';
        renderContractVars(CONTRACT_VARS);
      }
      async function loadTemplate(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
          contractTemplate = typeof ev.target.result === 'string' ? ev.target.result : DEFAULT_CONTRACT;
          const m = contractTemplate.match(/\[([A-Z_]+)\]/g) || [];
          const vars = m.length ? [...new Set(m.map((v) => v.replace(/[\[\]]/g, '')))] : CONTRACT_VARS;
          document.getElementById('tmplStatus').innerHTML =
            `<div style="font-size:13px;color:var(--em)">✓ Loaded: ${file.name}</div>`;
          document.getElementById('contractVarsCard').style.display = 'block';
          renderContractVars(vars);
        };
        reader.readAsText(file);
      }
      function renderContractVars(vars) {
        document.getElementById('contractVars').innerHTML = vars
          .map(
            (v) =>
              `<div class="cv-row"><div class="cv-key">[${v}]</div><input class="cv-inp" id="cv-${v}" placeholder="${v.replace(/_/g, ' ').toLowerCase()}..."></div>`,
          )
          .join('');
      }
      async function generateContract() {
        const out = document.getElementById('contractOut');
        out.innerHTML =
          '<div class="ai-thinking"><div class="tdots"><span></span><span></span><span></span></div> Generating contract...</div>';
        const vars = {};
        document.querySelectorAll('.cv-inp').forEach((inp) => {
          vars[inp.id.replace('cv-', '')] = inp.value || `[${inp.id.replace('cv-', '')}]`;
        });
        const result = await claude(
          `Generate a complete professional client contract using this template and variables.\n\nTEMPLATE:\n${contractTemplate || DEFAULT_CONTRACT}\n\nVARIABLES:\n${Object.entries(
            vars,
          )
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')}\n\nReplace all placeholders. Make it professional and ready to present.`,
          'You are an expert contracts specialist for building automation and energy services companies.',
        );
        out.textContent = result;
        showToast('Contract generated ✓');
      }

      /* ── WEBCTRL ── */
      function setWCMode(mode, el) {
        document.querySelectorAll('.wcm').forEach((m) => m.classList.remove('active'));
        el.classList.add('active');
        ['wc-guide', 'wc-diagnose', 'wc-write'].forEach((id) => (document.getElementById(id).style.display = 'none'));
        document.getElementById('wc-' + mode).style.display = 'block';
      }
      async function runWC(mode) {
        const SYS =
          'You are a senior WebCTRL/Automated Logic expert with 20+ years experience. Provide technically accurate, field-ready guidance.';
        if (mode === 'guide') {
          const q = document.getElementById('wc-g-q').value;
          if (!q) {
            showToast('Enter a question');
            return;
          }
          const out = document.getElementById('wc-g-out');
          out.innerHTML =
            '<div class="ai-thinking"><div class="tdots"><span></span><span></span><span></span></div> Generating explanation...</div>';
          out.textContent = await claude(
            `Explain for ${document.getElementById('wc-g-lvl').value}: "${q}". Include concept explanation, WebCTRL specifics, step-by-step walkthrough, pitfalls, tips, and an example.`,
            SYS,
          );
        } else if (mode === 'diagnose') {
          const logic = document.getElementById('wc-d-logic').value;
          if (!logic) {
            showToast('Paste logic first');
            return;
          }
          const out = document.getElementById('wc-d-out');
          out.textContent = 'Diagnosing...';
          out.textContent = await claude(
            `Analyze this WebCTRL program:\n\n${logic}\n\n${document.getElementById('wc-d-issue').value ? 'ISSUE: ' + document.getElementById('wc-d-issue').value : ''}\n\nProvide: plain English explanation, logic flow, issues found, fixes, optimizations, field notes.`,
            SYS,
          );
        } else {
          const desc = document.getElementById('wc-w-desc').value;
          if (!desc) {
            showToast('Describe the sequence');
            return;
          }
          const out = document.getElementById('wc-w-out');
          out.textContent = 'Writing logic...';
          out.textContent = await claude(
            `Write WebCTRL logic for a ${document.getElementById('wc-w-sys').value}.\n\nSequence: ${desc}\n\n${document.getElementById('wc-w-pts').value ? 'Points: ' + document.getElementById('wc-w-pts').value : ''}\n\nProvide complete logic, control points list, setpoints, alarms, commissioning checklist.`,
            SYS,
          );
        }
      }

