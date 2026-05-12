      /* ═══════════════════════════════════════════════════
         TOOLTIP & HELP SYSTEM
         Settings keys stored in ch_settings:
           showTooltips    — boolean, default true
           showQuickStart  — boolean, default true
         Dismissed tips: ch_dismissed_tips (JSON array of tip IDs)
         First-visit flag: ch_qs_seen
      ═══════════════════════════════════════════════════ */

      /* ── Settings helpers ── */
      function chGetSetting(key, def) {
        try {
          var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
          return key in s ? s[key] : def;
        } catch (e) {
          return def;
        }
      }
      function chSetSetting(key, val) {
        try {
          var s = JSON.parse(localStorage.getItem('ch_settings') || '{}');
          s[key] = val;
          localStorage.setItem('ch_settings', JSON.stringify(s));
        } catch (e) {}
      }

      /* ── Dismissed tips helpers ── */
      function chGetDismissed() {
        try {
          return JSON.parse(localStorage.getItem('ch_dismissed_tips') || '[]');
        } catch (e) {
          return [];
        }
      }
      function chDismissTip(tipId) {
        var d = chGetDismissed();
        if (d.indexOf(tipId) === -1) d.push(tipId);
        try {
          localStorage.setItem('ch_dismissed_tips', JSON.stringify(d));
        } catch (e) {}
      }
      function chIsDismissed(tipId) {
        return chGetDismissed().indexOf(tipId) !== -1;
      }
      function chResetDismissedTips() {
        try {
          localStorage.removeItem('ch_dismissed_tips');
        } catch (e) {}
        showToast('All tips reset — they will show again next time ✓');
      }

      /* ── Core tooltip function ──
         element  — DOM element to anchor the tip near
         message  — plain text message string
         options  — {
           id: string,        tip ID for "don't show again" (required for DSA feature)
           icon: string,      emoji icon (default '💡')
           position: string,  'below' (default) | 'above'
           delay: number,     ms before showing (default 0)
         }
      */
      function showTooltip(element, message, options) {
        if (!chGetSetting('showTooltips', true)) return;
        options = options || {};
        var tipId = options.id || null;
        if (tipId && chIsDismissed(tipId)) return;

        // Remove existing tip on same element
        if (element._chTipEl) {
          element._chTipEl.remove();
          delete element._chTipEl;
        }

        var icon = options.icon || '💡';
        var position = options.position || 'below';
        var delay = options.delay || 0;

        function _show() {
          var bubble = document.createElement('div');
          bubble.className = 'ch-tip-bubble' + (position === 'above' ? ' tip-above' : '');

          var dsaHtml = tipId
            ? '<div class="ch-tip-footer"><button class="ch-tip-dsa" onclick="chDismissTip(\'' +
              tipId +
              "');this.closest('.ch-tip-bubble').remove()\">Don't show again</button></div>"
            : '';

          bubble.innerHTML =
            '<div class="ch-tip-hdr">' +
            '<span class="ch-tip-icon">' +
            icon +
            '</span>' +
            '<span class="ch-tip-msg">' +
            message +
            '</span>' +
            '<button class="ch-tip-close" onclick="this.closest(\'.ch-tip-bubble\').remove()" title="Dismiss">&#10005;</button>' +
            '</div>' +
            dsaHtml;

          // Use fixed positioning relative to viewport
          bubble.style.position = 'fixed';
          bubble.style.zIndex = '9000';
          bubble.style.visibility = 'hidden'; // hide until positioned
          document.body.appendChild(bubble);

          var rect = element.getBoundingClientRect();
          var bh = bubble.offsetHeight;
          var bw = bubble.offsetWidth;

          if (position === 'above') {
            bubble.style.top = rect.top - bh - 10 + 'px';
          } else {
            bubble.style.top = rect.bottom + 10 + 'px';
          }
          var left = rect.left;
          if (left + bw > window.innerWidth - 12) left = window.innerWidth - bw - 12;
          if (left < 8) left = 8;
          bubble.style.left = left + 'px';
          bubble.style.visibility = '';

          element._chTipEl = bubble;

          // Auto-dismiss after 12 seconds
          setTimeout(function () {
            if (bubble.parentNode) bubble.remove();
          }, 12000);
        }

        if (delay > 0) {
          setTimeout(_show, delay);
        } else {
          _show();
        }
      }

      /* ── Dismiss all visible tips ── */
      function dismissAllTooltips() {
        document.querySelectorAll('.ch-tip-bubble').forEach(function (b) {
          b.remove();
        });
      }

      /* ═══════════════════════════════════════════════════
         QUICK START GUIDE
      ═══════════════════════════════════════════════════ */
      var _qsStep = 0;
      var _qsSteps = [
        {
          icon: '📁',
          title: 'Step 1 — Create a Project',
          desc: 'Every building or client site lives inside a <strong>Project</strong>. Click the <strong>+ New Project</strong> button in the sidebar. Give it a clear name — the building name or client name works well.',
          tips: '<strong>Tip:</strong> You can create as many projects as needed. Each one tracks its own buildings, meters, and bills completely separately.',
        },
        {
          icon: '🏢',
          title: 'Step 2 — Add Buildings',
          desc: 'Inside your project, click <strong>+ Add Building</strong>. Enter the building name and address. One project can hold multiple buildings — for example, a campus with several facilities.',
          tips: '<strong>Tip:</strong> Square footage is optional but helps with energy intensity calculations like kWh per square foot.',
        },
        {
          icon: '⚡',
          title: 'Step 3 — Add Utility Meters',
          desc: 'For each building, add the utility meters that serve it. Click <strong>+ Add Meter</strong> and choose the commodity: Electric, Gas, or Water. Enter the utility provider and account number.',
          tips: '<strong>Tip:</strong> Each meter gets its own billing history. If a building has both electric and gas service, add one meter for each commodity.',
        },
        {
          icon: '📄',
          title: 'Step 4 — Upload Utility Bills',
          desc: 'Go to the <strong>PDF / OCR</strong> tab. Drop a utility bill PDF onto the drop zone or click to browse. The app reads the bill and pulls out usage, demand, and cost automatically.',
          tips: "<strong>Tip:</strong> After extraction, review the fields and correct anything that looks wrong. Then click <strong>Save to Project</strong> to add it to the meter's history.",
        },
        {
          icon: '📊',
          title: 'Step 5 — View Performance',
          desc: "Once you have at least one year of bills saved, go to <strong>Utility Data</strong> and click <strong>Performance</strong>. Set a baseline period in the <strong>Baseline</strong> tab first — that's the reference point for all savings calculations.",
          tips: '<strong>Tip:</strong> The Performance tab shows actual vs. baseline usage and cost side-by-side, month by month. Use it to demonstrate energy savings to clients.',
        },
      ];

      function openQuickStart() {
        var overlay = document.getElementById('qsOverlay');
        if (!overlay) return;
        _qsStep = 0;
        _qsRender();
        overlay.classList.add('open');
        overlay.onclick = function (e) {
          if (e.target === overlay) closeQuickStart();
        };
      }

      function closeQuickStart() {
        var overlay = document.getElementById('qsOverlay');
        if (overlay) overlay.classList.remove('open');
      }

      function qsNav(dir) {
        _qsStep = Math.max(0, Math.min(_qsSteps.length - 1, _qsStep + dir));
        _qsRender();
      }

      function qsJump(idx) {
        _qsStep = idx;
        _qsRender();
      }

      function _qsRender() {
        var dotsEl = document.getElementById('qsStepDots');
        var bodyEl = document.getElementById('qsBody');
        var prevBtn = document.getElementById('qsPrevBtn');
        var nextBtn = document.getElementById('qsNextBtn');
        var fill = document.getElementById('qsProgressFill');
        if (!dotsEl || !bodyEl) return;

        var total = _qsSteps.length;
        var shortLabels = ['Project', 'Buildings', 'Meters', 'Upload Bills', 'Performance'];

        // Build step dots
        var dotsHtml = '';
        for (var i = 0; i < total; i++) {
          var cls = i < _qsStep ? 'done' : i === _qsStep ? 'active' : '';
          var numOrCheck = i < _qsStep ? '&#10003;' : i + 1;
          dotsHtml +=
            '<div class="qs-step-dot ' +
            cls +
            '" onclick="qsJump(' +
            i +
            ')" style="cursor:pointer">' +
            '<div class="qs-dot-circle">' +
            numOrCheck +
            '</div>' +
            '<div class="qs-step-label">' +
            shortLabels[i] +
            '</div>' +
            '</div>';
        }
        dotsEl.innerHTML = dotsHtml;

        // Build step content
        var step = _qsSteps[_qsStep];
        bodyEl.innerHTML =
          '<div class="qs-step-content active">' +
          '<div class="qs-step-icon">' +
          step.icon +
          '</div>' +
          '<div class="qs-step-title">' +
          step.title +
          '</div>' +
          '<div class="qs-step-desc">' +
          step.desc +
          '</div>' +
          '<div class="qs-step-tips">' +
          step.tips +
          '</div>' +
          '</div>';

        // Progress bar
        if (fill) fill.style.width = ((_qsStep + 1) / total) * 100 + '%';

        // Nav buttons
        if (prevBtn) prevBtn.style.display = _qsStep > 0 ? '' : 'none';
        if (nextBtn) {
          if (_qsStep === total - 1) {
            nextBtn.textContent = 'Done ✓';
            nextBtn.onclick = closeQuickStart;
          } else {
            nextBtn.innerHTML = 'Next &#8594;';
            nextBtn.onclick = function () {
              qsNav(1);
            };
          }
        }
      }

      /* ── Initial contextual tooltips + auto Quick Start ── */
      document.addEventListener('DOMContentLoaded', function () {
        // Auto-show quick start on first visit
        var seen = localStorage.getItem('ch_qs_seen');
        if (!seen && chGetSetting('showQuickStart', true)) {
          setTimeout(function () {
            openQuickStart();
            localStorage.setItem('ch_qs_seen', '1');
          }, 1200);
        }

        // Attach contextual tooltips after DOM is settled
        setTimeout(function () {
          if (!chGetSetting('showTooltips', true)) return;

          // 2. Performance tab button (project level)
          var perfBtn = document.getElementById('ud-proj-perf-btn');
          if (perfBtn) {
            showTooltip(
              perfBtn,
              'Click to see usage and cost vs. your baseline period. Requires a saved baseline first.',
              {
                id: 'tip_perf_tab',
                icon: '📊',
                position: 'above',
                delay: 3000,
              },
            );
          }

          // 3. Baseline tab button (project level)
          var blBtn = document.getElementById('ud-proj-baseline-btn');
          if (blBtn) {
            showTooltip(
              blBtn,
              'Select your pre-project billing months and save a baseline — the reference point for all savings calculations.',
              { id: 'tip_baseline_btn', icon: '📈', position: 'above', delay: 5500 },
            );
          }

          // 4. Projected Savings button
          var savProjBtn = document.getElementById('ud-proj-savproj-btn');
          if (savProjBtn) {
            showTooltip(savProjBtn, 'Model future savings based on a proposed % reduction in usage or cost.', {
              id: 'tip_savproj_btn',
              icon: '💰',
              position: 'above',
              delay: 8000,
            });
          }
        }, 700);
      });

      /* ── Baseline save button tip — call this after blSaveBtn is rendered ──
         The baseline tab renders dynamically, so attach the tip after render. */
      function attachBaselineSaveTip() {
        var btn = document.getElementById('blSaveBtn');
        if (!btn) return;
        if (btn._chTipAttached) return;
        btn._chTipAttached = true;
        showTooltip(
          btn,
          'Locks the selected months as your baseline. This freezes the regression so Performance can calculate savings.',
          { id: 'tip_baseline_save', icon: '✅', position: 'above', delay: 400 },
        );
      }

      /* ══════════════════════════════════════
         STATE PERSISTENCE — pagehide
         Saves extraction state automatically when
         navigating away so it survives page changes.
      ══════════════════════════════════════ */
      window._hasUnsavedWork = false;
      window._pdfBillsSaved = false;
      window.addEventListener('beforeunload', function (e) {
        // Warn if extracted bills haven't been saved yet
        var hasUnsavedBills = window._pdfMultiBills && window._pdfMultiBills.length && !window._pdfBillsSaved;
        // Warn if a batch extraction is actively running (reloading would abort it)
        var extractionRunning = window._pdfQueue && window._pdfQueue.status === 'running';
        if (hasUnsavedBills || extractionRunning) {
          e.preventDefault();
          return (e.returnValue = '');
        }
      });
