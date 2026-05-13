/* ═══════════════════════════════════════════════════
   FEEDBACK WIDGET — CompanyHub
   In-browser feedback/inspection system
═══════════════════════════════════════════════════ */
(function () {
  'use strict';

  var state = {
    enabled: false,
    inspecting: false,
    highlightedEl: null,
    selectedEl: null,
    popup: null,
    btn: null,
    screenshotBlob: null,
    screenshotMethod: null,
  };

  /* ── Helpers ── */
  function genUUID() {
    return Math.random().toString(16).slice(2, 10);
  }

  function getPageName() {
    var path = window.location.pathname;
    var parts = path.split('/');
    return parts[parts.length - 1] || 'index.html';
  }

  function getSettings() {
    try {
      var s = localStorage.getItem('ch_settings');
      return s ? JSON.parse(s) : {};
    } catch (e) {
      return {};
    }
  }

  /* ── Element Identification ── */
  function findFbAncestor(el) {
    var current = el;
    while (current && current !== document.body) {
      if (current.hasAttribute('data-fb')) return current;
      current = current.parentElement;
    }
    return null;
  }

  function buildSelector(el, ancestor) {
    var parts = [];
    var current = el;
    while (current && current !== ancestor) {
      var tag = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift('#' + current.id);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        var cls = current.className
          .trim()
          .split(/\s+/)
          .filter(function (c) {
            return c !== 'fb-highlight';
          });
        if (cls.length) {
          parts.unshift(tag + '.' + cls[0]);
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getElementInfo(el) {
    var fbAncestor = findFbAncestor(el);
    var dataFb = '';
    var selector = '';

    if (el.hasAttribute('data-fb')) {
      dataFb = el.getAttribute('data-fb');
      selector = el.id ? '#' + el.id : buildSelector(el, document.body);
    } else if (fbAncestor) {
      dataFb = fbAncestor.getAttribute('data-fb');
      selector = buildSelector(el, fbAncestor);
      if (dataFb && selector) selector = '[data-fb="' + dataFb + '"] > ' + selector;
    } else {
      dataFb = 'untagged';
      selector = buildSelector(el, document.body);
    }

    var text = (el.textContent || '').trim();
    if (text.length > 120) text = text.substring(0, 120) + '...';

    return {
      dataFb: dataFb,
      id: el.id || null,
      selector: selector,
      textContent: text,
    };
  }

  /* ── Feedback Button ── */
  function createButton() {
    if (state.btn) return;
    var btn = document.createElement('button');
    btn.className = 'fb-btn';
    btn.title = 'Report feedback on a UI element';
    btn.innerHTML = '&#128172;';
    btn.onclick = function () {
      if (state.inspecting) {
        exitInspection();
      } else {
        enterInspection();
      }
    };
    document.body.appendChild(btn);
    state.btn = btn;
  }

  function removeButton() {
    if (state.btn) {
      state.btn.remove();
      state.btn = null;
    }
  }

  /* ── Inspection Mode ── */
  function enterInspection() {
    state.inspecting = true;
    state.btn.classList.add('active');
    state.btn.innerHTML = '&#10005;';
    document.documentElement.classList.add('fb-inspect-active');
    document.addEventListener('mousemove', onInspectHover, true);
    document.addEventListener('click', onInspectClick, true);
    document.addEventListener('keydown', onInspectKey, true);
  }

  function exitInspection() {
    state.inspecting = false;
    if (state.btn) {
      state.btn.classList.remove('active');
      state.btn.innerHTML = '&#128172;';
    }
    document.documentElement.classList.remove('fb-inspect-active');
    document.removeEventListener('mousemove', onInspectHover, true);
    document.removeEventListener('click', onInspectClick, true);
    document.removeEventListener('keydown', onInspectKey, true);
    clearHighlight();
    closePopup();
  }

  function onInspectHover(e) {
    if (state.popup) return;
    var el = e.target;
    if (el === state.btn || state.btn.contains(el)) return;
    if (el.closest('.fb-popup')) return;

    clearHighlight();

    el.classList.add('fb-highlight');
    state.highlightedEl = el;
  }

  function onInspectClick(e) {
    var el = e.target;
    if (el === state.btn || state.btn.contains(el)) return;
    if (el.closest('.fb-popup')) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    clearHighlight();

    state.selectedEl = el;
    el.classList.add('fb-highlight');
    state.highlightedEl = el;

    showPopup(el, el);
  }

  function onInspectKey(e) {
    if (e.key === 'Escape') {
      exitInspection();
    }
  }

  function clearHighlight() {
    if (state.highlightedEl) {
      state.highlightedEl.classList.remove('fb-highlight');
      state.highlightedEl = null;
    }
  }

  /* ── Popup ── */
  function showPopup(clickedEl, targetEl) {
    closePopup();

    var info = getElementInfo(clickedEl);
    state.screenshotBlob = null;
    state.screenshotMethod = null;

    var popup = document.createElement('div');
    popup.className = 'fb-popup';

    popup.innerHTML =
      '<div class="fb-popup-hdr">' +
      '<span class="fb-popup-tag" title="' +
      info.dataFb +
      '">' +
      info.dataFb +
      '</span>' +
      '<button class="fb-popup-x" title="Cancel">&#10005;</button>' +
      '</div>' +
      '<textarea class="fb-popup-textarea" placeholder="Describe the issue..." autofocus></textarea>' +
      '<div class="fb-popup-row">' +
      '<select class="fb-popup-select">' +
      '<option value="P1">P1 — Fix Now</option>' +
      '<option value="P2">P2 — Fix Today</option>' +
      '<option value="P3" selected>P3 — This Week</option>' +
      '<option value="P4">P4 — Backlog</option>' +
      '</select>' +
      '<button class="fb-popup-submit" id="fbSubmitBtn">Submit</button>' +
      '</div>' +
      '<div class="fb-screenshot-stack">' +
      '<button class="fb-screenshot-btn" id="fbQuickCapBtn">&#128247; Quick Capture</button>' +
      '<button class="fb-screenshot-btn" id="fbScreenCapBtn">&#128187; Screen Capture</button>' +
      '</div>';

    var rect = targetEl.getBoundingClientRect();
    var top = rect.bottom + 8;
    var left = rect.left;

    if (top + 220 > window.innerHeight) {
      top = Math.max(8, rect.top - 228);
    }
    if (left + 320 > window.innerWidth) {
      left = Math.max(8, window.innerWidth - 328);
    }

    popup.style.top = top + 'px';
    popup.style.left = left + 'px';

    document.body.appendChild(popup);
    state.popup = popup;

    document.removeEventListener('mousemove', onInspectHover, true);

    popup.querySelector('.fb-popup-x').onclick = function () {
      exitInspection();
    };

    var quickCapBtn = popup.querySelector('#fbQuickCapBtn');
    var screenCapBtn = popup.querySelector('#fbScreenCapBtn');

    quickCapBtn.onclick = function () {
      doQuickCapture(clickedEl, quickCapBtn);
    };

    screenCapBtn.onclick = function () {
      doScreenCapture(clickedEl, screenCapBtn);
    };

    popup.querySelector('#fbSubmitBtn').onclick = function () {
      var textarea = popup.querySelector('.fb-popup-textarea');
      var feedback = textarea.value.trim();
      if (!feedback) {
        textarea.style.borderColor = '#da3633';
        textarea.focus();
        return;
      }
      var priority = popup.querySelector('.fb-popup-select').value;
      submitFeedback(info, feedback, priority);
    };

    setTimeout(function () {
      popup.querySelector('.fb-popup-textarea').focus();
    }, 50);
  }

  function closePopup() {
    if (state.popup) {
      state.popup.remove();
      state.popup = null;
    }
    state.screenshotBlob = null;
    state.screenshotMethod = null;
  }

  /* ── Screenshot Capture ── */
  function doQuickCapture(el, btn) {
    if (typeof html2canvas === 'undefined') {
      var script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      script.onload = function () {
        captureWithHtml2canvas(el, btn);
      };
      script.onerror = function () {
        btn.textContent = 'Failed';
        setTimeout(function () {
          btn.innerHTML = '&#128247; Capture';
        }, 2000);
      };
      document.head.appendChild(script);
    } else {
      captureWithHtml2canvas(el, btn);
    }
  }

  function captureWithHtml2canvas(el, btn) {
    btn.textContent = 'Capturing...';
    el.classList.remove('fb-highlight');

    html2canvas(el, {
      backgroundColor: null,
      scale: 2,
      logging: false,
      useCORS: true,
      allowTaint: true,
      // Disable foreignObject rendering to avoid CORS/CSS failures (backdrop-filter,
      // cross-origin fonts like Google Fonts) that cause silent blank captures.
      foreignObjectRendering: false,
    })
      .then(function (canvas) {
        el.classList.add('fb-highlight');
        canvas.toBlob(function (blob) {
          if (blob) {
            state.screenshotBlob = blob;
            state.screenshotMethod = 'quick';
            btn.classList.add('captured');
            btn.innerHTML = '&#10003; Captured';
          } else {
            console.warn('[feedback-widget] html2canvas returned null blob — falling back to text description');
            el.classList.add('fb-highlight');
            _applyTextFallback(el, btn);
          }
        }, 'image/png');
      })
      .catch(function (err) {
        el.classList.add('fb-highlight');
        console.error('[feedback-widget] html2canvas failed:', err && (err.message || err));
        _applyTextFallback(el, btn);
      });
  }

  // Text-description fallback used when screenshot capture fails.
  // Stores a plain-text description of the element as the "screenshot" so the
  // feedback submission still includes useful context even without an image.
  function _applyTextFallback(el, btn) {
    var info = getElementInfo(el);
    var desc =
      '[Screenshot unavailable — html2canvas error]\n' +
      'Element: ' +
      (info.dataFb || info.selector || 'unknown') +
      '\n' +
      'Text: ' +
      (info.textContent || '(none)') +
      '\n' +
      'Page: ' +
      getPageName() +
      '\n' +
      'URL: ' +
      window.location.href;
    var fallbackBlob = new Blob([desc], { type: 'text/plain' });
    state.screenshotBlob = fallbackBlob;
    state.screenshotMethod = 'text-fallback';
    btn.classList.add('captured');
    btn.innerHTML = '&#10003; Text Fallback';
    btn.title = 'Screenshot failed — element description will be attached instead';
  }

  function doScreenCapture(targetEl, btn) {
    btn.textContent = 'Capturing...';

    navigator.mediaDevices
      .getDisplayMedia({ video: { displaySurface: 'browser' } })
      .then(function (stream) {
        var video = document.createElement('video');
        video.srcObject = stream;
        return video.play().then(function () {
          var canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0);
          stream.getTracks().forEach(function (t) {
            t.stop();
          });

          var rect = targetEl.getBoundingClientRect();
          var scaleX = video.videoWidth / window.innerWidth;
          var scaleY = video.videoHeight / window.innerHeight;

          var cropCanvas = document.createElement('canvas');
          var cx = Math.round(rect.left * scaleX);
          var cy = Math.round(rect.top * scaleY);
          var cw = Math.round(rect.width * scaleX);
          var ch = Math.round(rect.height * scaleY);

          cw = Math.min(cw, canvas.width - cx);
          ch = Math.min(ch, canvas.height - cy);

          if (cw > 10 && ch > 10) {
            cropCanvas.width = cw;
            cropCanvas.height = ch;
            cropCanvas.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
          } else {
            cropCanvas = canvas;
          }

          cropCanvas.toBlob(function (blob) {
            state.screenshotBlob = blob;
            state.screenshotMethod = 'screen';
            btn.classList.add('captured');
            btn.innerHTML = '&#10003; Captured';
          }, 'image/png');
        });
      })
      .catch(function () {
        btn.innerHTML = '&#128247; Capture';
      });
  }

  /* ── Submit & Download ── */
  function submitFeedback(elementInfo, feedback, priority) {
    var uuid = genUUID();
    var timestamp = new Date().toISOString().replace(/\.\d+Z$/, '');

    var data = {
      source: 'feedback-widget',
      uuid: uuid,
      timestamp: timestamp,
      page: getPageName(),
      element: elementInfo,
      feedback: feedback,
      priority: priority,
    };

    if (state.screenshotBlob) {
      data.screenshot = 'feedback-' + uuid + '.png';
    }

    /* ── localStorage fallback ── */
    try {
      var existing = localStorage.getItem('fb_issues');
      var issues = existing ? JSON.parse(existing) : [];
      var entry = JSON.parse(JSON.stringify(data)); // clone
      issues.push(entry);
      localStorage.setItem('fb_issues', JSON.stringify(issues));

      // Async: if there's a screenshot blob, convert to base64 and update the entry
      if (state.screenshotBlob) {
        (function (blob, entryUuid) {
          var reader = new FileReader();
          reader.onload = function () {
            try {
              var stored = localStorage.getItem('fb_issues');
              var arr = stored ? JSON.parse(stored) : [];
              for (var i = 0; i < arr.length; i++) {
                if (arr[i].uuid === entryUuid) {
                  arr[i].screenshotDataUrl = reader.result;
                  break;
                }
              }
              localStorage.setItem('fb_issues', JSON.stringify(arr));
            } catch (e2) {
              /* ignore */
            }
          };
          reader.readAsDataURL(blob);
        })(state.screenshotBlob, uuid);
      }
    } catch (e) {
      /* localStorage failure must not break submit */
    }

    var jsonBlob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var downloadOk = downloadBlob(jsonBlob, 'feedback-' + uuid + '.json');

    if (state.screenshotBlob) {
      // Delay PNG download by 600ms — Edge blocks rapid back-to-back programmatic downloads
      var pngBlob = state.screenshotBlob;
      var pngName = 'feedback-' + uuid + '.png';
      setTimeout(function () {
        downloadBlob(pngBlob, pngName);
      }, 600);
    }

    showConfirmation(uuid, downloadOk);
    exitInspection();
  }

  function downloadBlob(blob, filename) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);
      return true;
    } catch (e) {
      return false;
    }
  }

  function showConfirmation(uuid, downloadOk) {
    var el = document.createElement('div');
    el.className = 'fb-confirm';
    var downloadNote =
      downloadOk === false ? '<div class="fb-confirm-note">Download blocked — data saved to app storage</div>' : '';
    el.innerHTML = '&#9989; Feedback submitted <span class="fb-confirm-uuid">' + uuid + '</span>' + downloadNote;
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function () {
        el.remove();
      }, 300);
    }, 3000);
  }

  /* ── Init ── */
  function init() {
    var settings = getSettings();
    if (settings.feedbackMode) {
      enable();
    }

    document.addEventListener('feedbackModeChanged', function (e) {
      if (e.detail.enabled) {
        enable();
      } else {
        disable();
      }
    });
  }

  function enable() {
    state.enabled = true;
    createButton();
  }

  function disable() {
    state.enabled = false;
    if (state.inspecting) exitInspection();
    removeButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
