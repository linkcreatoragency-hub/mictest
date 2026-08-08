/* mictest.live — all device test tools. Vanilla JS, no dependencies.
   Everything runs locally in the browser; no media is uploaded anywhere. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------------- mobile menu ---------------- */
  var mb = $('#menuBtn'), nav = $('#mainNav');
  if (mb && nav) mb.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    mb.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  function setStatus(el, cls, text) {
    if (!el) return;
    el.className = 'status' + (cls ? ' ' + cls : '');
    el.innerHTML = '<span class="dot"></span><span>' + text + '</span>';
  }
  function secure() {
    return window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost';
  }
  function gumSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function errText(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError')
      return 'Permission denied. Your browser blocked access. Click the padlock icon in the address bar, set the permission to Allow, then reload this page.';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError')
      return 'No device was found. Make sure it is plugged in and enabled in your system settings, then reload.';
    if (n === 'NotReadableError' || n === 'TrackStartError')
      return 'The device is busy. Another app (Zoom, Teams, Discord, OBS, another browser tab) may be using it. Close that app and try again.';
    if (n === 'OverconstrainedError') return 'The selected device could not start with these settings. Try a different device.';
    if (n === 'SecurityError') return 'Blocked for security reasons. This page must be loaded over HTTPS.';
    return 'Could not start the device' + (e && e.message ? ' (' + e.message + ')' : '') + '.';
  }

  /* ============================================================ MIC TEST */
  function initMic() {
    var wrap = $('#micTool');
    if (!wrap) return;

    var startBtn = $('#micStart'), stopBtn = $('#micStop'), sel = $('#micSelect'),
      st = $('#micStatus'), fill = $('#micFill'), curEl = $('#micCur'), peakEl = $('#micPeak'),
      avgEl = $('#micAvg'), wave = $('#micWave'), spec = $('#micSpec'), info = $('#micInfo'),
      verdict = $('#micVerdict'), recBtn = $('#micRec'), recList = $('#micRecList'),
      ecCb = $('#optEC'), nsCb = $('#optNS'), agcCb = $('#optAGC');

    var stream = null, ac = null, analyser = null, src = null, raf = null,
      rec = null, chunks = [], recTimer = null, running = false;
    var peak = 0, sum = 0, n = 0, sawSignal = false, startedAt = 0;
    var wctx = wave ? wave.getContext('2d') : null, sctx = spec ? spec.getContext('2d') : null;

    function fitCanvas(c) {
      if (!c) return;
      var r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(r.width * d));
      c.height = Math.max(1, Math.round(r.height * d));
      var x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0);
    }

    function listDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve();
      return navigator.mediaDevices.enumerateDevices().then(function (ds) {
        if (!sel) return;
        var cur = sel.value;
        var mics = ds.filter(function (d) { return d.kind === 'audioinput'; });
        sel.innerHTML = '';
        mics.forEach(function (d, i) {
          var o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || ('Microphone ' + (i + 1));
          sel.appendChild(o);
        });
        if (cur) sel.value = cur;
        sel.disabled = mics.length < 2;
        return mics;
      });
    }

    function constraints() {
      var a = {
        echoCancellation: ecCb ? ecCb.checked : true,
        noiseSuppression: nsCb ? nsCb.checked : true,
        autoGainControl: agcCb ? agcCb.checked : true
      };
      if (sel && sel.value) a.deviceId = { exact: sel.value };
      return { audio: a, video: false };
    }

    function showInfo(track) {
      if (!info) return;
      var s = {}, c = {};
      try { s = track.getSettings ? track.getSettings() : {}; } catch (e) { }
      try { c = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { }
      function yn(v) {
        if (v === true) return '<span class="badge on">On</span>';
        if (v === false) return '<span class="badge off">Off</span>';
        return '<span class="badge off">n/a</span>';
      }
      var rate = s.sampleRate || (ac && ac.sampleRate) || null;
      var rows = [
        ['Microphone', track.label || 'Unnamed device'],
        ['Sample rate', rate ? (rate / 1000).toFixed(1) + ' kHz (' + rate + ' Hz)' : 'Not reported'],
        ['Channels', s.channelCount ? (s.channelCount === 1 ? 'Mono (1)' : s.channelCount === 2 ? 'Stereo (2)' : s.channelCount) : 'Not reported'],
        ['Sample size', s.sampleSize ? s.sampleSize + '-bit' : 'Not reported'],
        ['Latency', (typeof s.latency === 'number') ? Math.round(s.latency * 1000) + ' ms' : 'Not reported'],
        ['Echo cancellation', yn(s.echoCancellation)],
        ['Noise suppression', yn(s.noiseSuppression)],
        ['Auto gain control', yn(s.autoGainControl)],
        ['Track state', track.readyState === 'live' ? '<span class="badge on">Live</span>' : '<span class="badge off">' + track.readyState + '</span>'],
        ['Supported rates', (c.sampleRate && c.sampleRate.min) ? (c.sampleRate.min + '–' + c.sampleRate.max + ' Hz') : 'Not reported']
      ];
      info.innerHTML = '<table class="info-table"><tbody>' + rows.map(function (r) {
        return '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>';
      }).join('') + '</tbody></table>';
    }

    function draw() {
      if (!running || !analyser) return;
      var N = analyser.fftSize;
      var buf = new Float32Array(N);
      if (analyser.getFloatTimeDomainData) analyser.getFloatTimeDomainData(buf);
      var s2 = 0, mx = 0;
      for (var i = 0; i < N; i++) { var v = buf[i]; s2 += v * v; if (Math.abs(v) > mx) mx = Math.abs(v); }
      var rms = Math.sqrt(s2 / N);
      var db = rms > 0 ? 20 * Math.log10(rms) : -100;
      if (db < -100) db = -100;
      var pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
      if (fill) fill.style.width = pct.toFixed(1) + '%';
      if (curEl) curEl.textContent = db <= -99 ? '−∞ dB' : db.toFixed(1) + ' dB';
      if (db > peak) { peak = db; if (peakEl) peakEl.textContent = peak.toFixed(1) + ' dB'; }
      if (db > -100) { sum += db; n++; if (avgEl) avgEl.textContent = (sum / n).toFixed(1) + ' dB'; }
      if (db > -45) sawSignal = true;

      /* waveform */
      if (wctx) {
        var w = wave.clientWidth, h = wave.clientHeight;
        wctx.clearRect(0, 0, w, h);
        wctx.fillStyle = '#0f172a'; wctx.fillRect(0, 0, w, h);
        wctx.strokeStyle = 'rgba(255,255,255,.13)'; wctx.lineWidth = 1;
        wctx.beginPath(); wctx.moveTo(0, h / 2); wctx.lineTo(w, h / 2); wctx.stroke();
        wctx.lineWidth = 2; wctx.strokeStyle = mx > 0.98 ? '#f87171' : '#34d399';
        wctx.beginPath();
        var step = Math.max(1, Math.floor(N / w));
        for (var x = 0, j = 0; j < N; j += step, x++) {
          var y = h / 2 - buf[j] * (h / 2 - 4);
          if (x === 0) wctx.moveTo(x, y); else wctx.lineTo(x, y);
        }
        wctx.stroke();
      }
      /* spectrum */
      if (sctx) {
        var fb = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(fb);
        var w2 = spec.clientWidth, h2 = spec.clientHeight;
        sctx.clearRect(0, 0, w2, h2);
        sctx.fillStyle = '#0f172a'; sctx.fillRect(0, 0, w2, h2);
        var bars = 64, bw = w2 / bars;
        for (var b = 0; b < bars; b++) {
          var idx = Math.floor(Math.pow(b / bars, 1.7) * fb.length);
          var val = fb[Math.min(idx, fb.length - 1)] / 255;
          var bh = val * (h2 - 6);
          var g = sctx.createLinearGradient(0, h2, 0, h2 - bh);
          g.addColorStop(0, '#22d3ee'); g.addColorStop(1, '#818cf8');
          sctx.fillStyle = g;
          sctx.fillRect(b * bw + 1, h2 - bh, bw - 2, bh);
        }
      }
      raf = requestAnimationFrame(draw);
    }

    function verdictNow() {
      if (!verdict) return;
      var avg = n ? sum / n : -100;
      var cls, title, msg;
      if (!sawSignal) {
        cls = 'bad'; title = 'No sound detected';
        msg = 'Your browser opened the microphone but no audio came through. The device may be muted in your system settings, the gain may be at zero, or the wrong input may be selected. Try another device from the dropdown, then check our <a href="/fix">fix guides</a>.';
      } else if (peak > -3) {
        cls = 'mid'; title = 'Working, but too loud';
        msg = 'Your microphone is picking up sound clearly, but the peaks are close to 0 dB, which causes clipping and a harsh, distorted recording. Lower the input volume in your system sound settings by 10–20% and test again.';
      } else if (avg < -45) {
        cls = 'mid'; title = 'Working, but very quiet';
        msg = 'Sound is coming through but the level is low. Move closer to the microphone, raise the input volume in your system settings, or enable a microphone boost. See <a href="/fix/microphone-too-quiet">how to fix a quiet microphone</a>.';
      } else {
        cls = 'good'; title = 'Your microphone is working';
        msg = 'Audio is being captured at a healthy level. Peaks are below clipping and the average level is in a good range for calls and recording. Use the record button to hear exactly how you sound to other people.';
      }
      verdict.className = 'verdict show ' + cls;
      verdict.innerHTML = '<h3>' + title + '</h3><p>' + msg + '</p>';
    }

    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf), raf = null;
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) { } }
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      if (ac) { try { ac.close(); } catch (e) { } ac = null; }
      analyser = null; src = null;
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
      if (recBtn) recBtn.disabled = true;
      if (fill) fill.style.width = '0%';
      setStatus(st, '', 'Microphone stopped. Press “Test My Microphone” to start again.');
      verdictNow();
    }

    function start() {
      if (!secure()) { setStatus(st, 'err', 'This page must be opened over HTTPS for microphone access to work.'); return; }
      if (!gumSupported()) { setStatus(st, 'err', 'Your browser does not support microphone access. Try the latest Chrome, Edge, Firefox or Safari.'); return; }
      setStatus(st, '', 'Waiting for permission… click “Allow” in your browser prompt.');
      if (startBtn) startBtn.disabled = true;
      peak = -100; sum = 0; n = 0; sawSignal = false; startedAt = Date.now();
      if (peakEl) peakEl.textContent = '—'; if (avgEl) avgEl.textContent = '—';
      if (verdict) verdict.className = 'verdict';

      navigator.mediaDevices.getUserMedia(constraints()).then(function (s) {
        stream = s;
        var track = s.getAudioTracks()[0];
        ac = new (window.AudioContext || window.webkitAudioContext)();
        if (ac.state === 'suspended') ac.resume();
        src = ac.createMediaStreamSource(s);
        analyser = ac.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.75;
        src.connect(analyser);
        running = true;
        fitCanvas(wave); fitCanvas(spec);
        showInfo(track);
        listDevices();
        setStatus(st, 'live', 'Microphone is live — speak normally and watch the meter move.');
        if (stopBtn) stopBtn.disabled = false;
        if (recBtn && window.MediaRecorder) recBtn.disabled = false;
        track.addEventListener('ended', function () { setStatus(st, 'err', 'The microphone was disconnected.'); stop(); });
        draw();
      }).catch(function (e) {
        if (startBtn) startBtn.disabled = false;
        setStatus(st, 'err', errText(e));
        if (verdict) {
          verdict.className = 'verdict show bad';
          verdict.innerHTML = '<h3>Microphone could not start</h3><p>' + errText(e) +
            ' Step-by-step fixes are in our <a href="/fix">troubleshooting guides</a>.</p>';
        }
      });
    }

    function toggleRecord() {
      if (!stream || !window.MediaRecorder) return;
      if (rec && rec.state === 'recording') { rec.stop(); return; }
      chunks = [];
      var mime = '';
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].some(function (m) {
        if (window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) { mime = m; return true; }
        return false;
      });
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { setStatus(st, 'err', 'Recording is not supported in this browser.'); return; }
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        clearInterval(recTimer);
        recBtn.textContent = 'Record 5 seconds';
        recBtn.classList.remove('btn-danger');
        if (!chunks.length) return;
        var blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        var url = URL.createObjectURL(blob);
        var item = document.createElement('div');
        item.className = 'rec-item';
        var idx = recList.children.length + 1;
        item.innerHTML = '<span class="rn">Take ' + idx + '</span>';
        var a = document.createElement('audio'); a.controls = true; a.src = url;
        item.appendChild(a);
        var dl = document.createElement('a');
        dl.className = 'btn btn-ghost'; dl.href = url; dl.textContent = 'Download';
        dl.download = 'mic-test-take-' + idx + '.webm';
        item.appendChild(dl);
        recList.appendChild(item);
        if (running) setStatus(st, 'live', 'Recording saved below — press play to hear how you sound to other people.');
      };
      rec.start();
      var left = 5;
      recBtn.classList.add('btn-danger');
      recBtn.textContent = 'Recording… ' + left + 's (stop)';
      recTimer = setInterval(function () {
        left--;
        if (left <= 0) { if (rec.state === 'recording') rec.stop(); return; }
        recBtn.textContent = 'Recording… ' + left + 's (stop)';
      }, 1000);
    }

    if (startBtn) startBtn.addEventListener('click', start);
    if (stopBtn) stopBtn.addEventListener('click', stop);
    if (recBtn) recBtn.addEventListener('click', toggleRecord);
    if (sel) sel.addEventListener('change', function () { if (running) { stop(); setTimeout(start, 120); } });
    [ecCb, nsCb, agcCb].forEach(function (cb) {
      if (cb) cb.addEventListener('change', function () { if (running) { stop(); setTimeout(start, 120); } });
    });
    window.addEventListener('resize', function () { if (running) { fitCanvas(wave); fitCanvas(spec); } });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener)
      navigator.mediaDevices.addEventListener('devicechange', listDevices);

    if (!secure()) setStatus(st, 'err', 'Microphone access needs a secure (HTTPS) connection.');
    else if (!gumSupported()) setStatus(st, 'err', 'This browser does not support microphone access.');
    else setStatus(st, '', 'Ready. Press the button below and allow access when your browser asks.');
    listDevices();
  }

  /* ============================================================ WEBCAM */
  function initCam() {
    var wrap = $('#camTool');
    if (!wrap) return;
    var v = $('#camVideo'), startBtn = $('#camStart'), stopBtn = $('#camStop'), sel = $('#camSelect'),
      st = $('#camStatus'), info = $('#camInfo'), shot = $('#camShot'), mir = $('#camMirror'),
      shotWrap = $('#shotWrap'), canvas = $('#shotCanvas'), dl = $('#shotDl'), res = $('#camRes');
    var stream = null, timer = null;

    function listDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices.enumerateDevices().then(function (ds) {
        if (!sel) return;
        var cur = sel.value;
        var cams = ds.filter(function (d) { return d.kind === 'videoinput'; });
        sel.innerHTML = '';
        cams.forEach(function (d, i) {
          var o = document.createElement('option');
          o.value = d.deviceId; o.textContent = d.label || ('Camera ' + (i + 1));
          sel.appendChild(o);
        });
        if (cur) sel.value = cur;
        sel.disabled = cams.length < 2;
      });
    }

    function showInfo() {
      if (!info || !stream) return;
      var t = stream.getVideoTracks()[0]; if (!t) return;
      var s = {}; try { s = t.getSettings ? t.getSettings() : {}; } catch (e) { }
      var rows = [
        ['Camera', t.label || 'Unnamed camera'],
        ['Resolution', (s.width && s.height) ? s.width + ' × ' + s.height + ' px' : 'Not reported'],
        ['Frame rate', s.frameRate ? Math.round(s.frameRate) + ' fps' : 'Not reported'],
        ['Aspect ratio', s.aspectRatio ? s.aspectRatio.toFixed(2) + ':1' : 'Not reported'],
        ['Facing mode', s.facingMode || 'Not reported (typical on desktop)'],
        ['Track state', t.readyState === 'live' ? '<span class="badge on">Live</span>' : '<span class="badge off">' + t.readyState + '</span>']
      ];
      info.innerHTML = '<table class="info-table"><tbody>' + rows.map(function (r) {
        return '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>';
      }).join('') + '</tbody></table>';
      if (res && v.videoWidth) res.textContent = v.videoWidth + ' × ' + v.videoHeight;
    }

    function stop() {
      if (timer) clearInterval(timer), timer = null;
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      if (v) v.srcObject = null;
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
      if (shot) shot.disabled = true;
      setStatus(st, '', 'Camera stopped.');
    }

    function start() {
      if (!secure()) { setStatus(st, 'err', 'This page must be opened over HTTPS for camera access to work.'); return; }
      if (!gumSupported()) { setStatus(st, 'err', 'Your browser does not support camera access.'); return; }
      setStatus(st, '', 'Waiting for permission… click “Allow” in your browser prompt.');
      if (startBtn) startBtn.disabled = true;
      var c = { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
      if (sel && sel.value) c.video.deviceId = { exact: sel.value };
      navigator.mediaDevices.getUserMedia(c).then(function (s) {
        stream = s;
        v.srcObject = s;
        v.play().catch(function () { });
        if (stopBtn) stopBtn.disabled = false;
        if (shot) shot.disabled = false;
        setStatus(st, 'live', 'Camera is live — if you can see yourself below, your webcam works.');
        listDevices();
        setTimeout(showInfo, 400);
        timer = setInterval(showInfo, 2000);
      }).catch(function (e) {
        if (startBtn) startBtn.disabled = false;
        setStatus(st, 'err', errText(e));
      });
    }

    if (startBtn) startBtn.addEventListener('click', start);
    if (stopBtn) stopBtn.addEventListener('click', stop);
    if (sel) sel.addEventListener('change', function () { if (stream) { stop(); setTimeout(start, 120); } });
    if (mir) mir.addEventListener('change', function () { v.classList.toggle('mirror', mir.checked); });
    if (shot) shot.addEventListener('click', function () {
      if (!v || !v.videoWidth) return;
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      var x = canvas.getContext('2d');
      if (mir && mir.checked) { x.translate(canvas.width, 0); x.scale(-1, 1); }
      x.drawImage(v, 0, 0, canvas.width, canvas.height);
      shotWrap.classList.add('show');
      try { dl.href = canvas.toDataURL('image/png'); dl.download = 'webcam-test.png'; } catch (e) { }
    });
    if (!secure()) setStatus(st, 'err', 'Camera access needs a secure (HTTPS) connection.');
    else setStatus(st, '', 'Ready. Press the button below and allow access when your browser asks.');
    listDevices();
  }

  /* ============================================================ SPEAKERS */
  function initSpeaker() {
    var wrap = $('#spkTool');
    if (!wrap) return;
    var ac = null, osc = null, gain = null, panner = null, sweepTimer = null;
    var st = $('#spkStatus');

    function ctx() {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }
    function stopTone() {
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      if (osc) { try { gain.gain.setTargetAtTime(0, ac.currentTime, 0.02); } catch (e) { }
        var o = osc; setTimeout(function () { try { o.stop(); o.disconnect(); } catch (e) { } }, 120); osc = null; }
      $$('.chan').forEach(function (c) { c.classList.remove('active'); });
      $$('.freq-grid button').forEach(function (b) { b.classList.remove('on'); });
      var f = $('#spkFreqNow'); if (f) f.textContent = '—';
      setStatus(st, '', 'Stopped. Pick a test below to play a tone.');
    }
    function play(freq, pan, label) {
      stopTone();
      var c = ctx();
      osc = c.createOscillator();
      gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0;
      var vol = $('#spkVol') ? (+$('#spkVol').value / 100) : 0.25;
      if (c.createStereoPanner) { panner = c.createStereoPanner(); panner.pan.value = pan; osc.connect(gain).connect(panner).connect(c.destination); }
      else { osc.connect(gain).connect(c.destination); }
      osc.start();
      gain.gain.setTargetAtTime(vol * 0.5, c.currentTime, 0.03);
      var f = $('#spkFreqNow'); if (f) f.textContent = Math.round(freq) + ' Hz';
      setStatus(st, 'live', 'Playing ' + label + '. If you hear nothing, check your volume and output device.');
    }
    $$('[data-chan]').forEach(function (el) {
      el.addEventListener('click', function () {
        var ch = el.getAttribute('data-chan');
        var pan = ch === 'left' ? -1 : ch === 'right' ? 1 : 0;
        var name = ch === 'left' ? 'the LEFT channel only' : ch === 'right' ? 'the RIGHT channel only' : 'BOTH channels';
        play(440, pan, name);
        el.classList.add('active');
      });
    });
    $$('[data-freq]').forEach(function (b) {
      b.addEventListener('click', function () {
        var f = +b.getAttribute('data-freq');
        play(f, 0, f + ' Hz on both channels');
        b.classList.add('on');
      });
    });
    var sweepBtn = $('#spkSweep');
    if (sweepBtn) sweepBtn.addEventListener('click', function () {
      stopTone();
      var c = ctx();
      osc = c.createOscillator(); gain = c.createGain();
      osc.type = 'sine'; osc.frequency.value = 20; gain.gain.value = 0;
      osc.connect(gain).connect(c.destination); osc.start();
      var vol = $('#spkVol') ? (+$('#spkVol').value / 100) : 0.25;
      gain.gain.setTargetAtTime(vol * 0.4, c.currentTime, 0.05);
      osc.frequency.exponentialRampToValueAtTime(20000, c.currentTime + 20);
      setStatus(st, 'live', 'Sweeping 20 Hz → 20 kHz over 20 seconds. Note where sound starts and stops.');
      var t0 = Date.now();
      sweepTimer = setInterval(function () {
        var el = (Date.now() - t0) / 1000;
        var f = 20 * Math.pow(1000, Math.min(el / 20, 1));
        var fe = $('#spkFreqNow'); if (fe) fe.textContent = Math.round(f) + ' Hz';
        if (el >= 20.4) stopTone();
      }, 100);
    });
    var stopBtn = $('#spkStop');
    if (stopBtn) stopBtn.addEventListener('click', stopTone);
    var vol = $('#spkVol');
    if (vol) vol.addEventListener('input', function () {
      var lbl = $('#spkVolVal'); if (lbl) lbl.textContent = vol.value + '%';
      if (gain && ac) gain.gain.setTargetAtTime((+vol.value / 100) * 0.5, ac.currentTime, 0.02);
    });
    setStatus(st, '', 'Ready. Put your volume at about 30% first, then pick a test.');
  }

  /* ============================================================ KEYBOARD */
  var KB_ROWS = [
    [['Escape', 'Esc'], ['F1', 'F1'], ['F2', 'F2'], ['F3', 'F3'], ['F4', 'F4'], ['F5', 'F5'], ['F6', 'F6'], ['F7', 'F7'], ['F8', 'F8'], ['F9', 'F9'], ['F10', 'F10'], ['F11', 'F11'], ['F12', 'F12']],
    [['Backquote', '`'], ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'], ['Minus', '-'], ['Equal', '='], ['Backspace', 'Backspace', 'w2']],
    [['Tab', 'Tab', 'w15'], ['KeyQ', 'Q'], ['KeyW', 'W'], ['KeyE', 'E'], ['KeyR', 'R'], ['KeyT', 'T'], ['KeyY', 'Y'], ['KeyU', 'U'], ['KeyI', 'I'], ['KeyO', 'O'], ['KeyP', 'P'], ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\', 'w15']],
    [['CapsLock', 'Caps', 'w175'], ['KeyA', 'A'], ['KeyS', 'S'], ['KeyD', 'D'], ['KeyF', 'F'], ['KeyG', 'G'], ['KeyH', 'H'], ['KeyJ', 'J'], ['KeyK', 'K'], ['KeyL', 'L'], ['Semicolon', ';'], ['Quote', "'"], ['Enter', 'Enter', 'w225']],
    [['ShiftLeft', 'Shift', 'w225'], ['KeyZ', 'Z'], ['KeyX', 'X'], ['KeyC', 'C'], ['KeyV', 'V'], ['KeyB', 'B'], ['KeyN', 'N'], ['KeyM', 'M'], ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['ShiftRight', 'Shift', 'w275']],
    [['ControlLeft', 'Ctrl', 'w15'], ['MetaLeft', 'Win', 'w15'], ['AltLeft', 'Alt', 'w15'], ['Space', 'Space', 'w6'], ['AltRight', 'Alt', 'w15'], ['MetaRight', 'Win', 'w15'], ['ContextMenu', 'Menu', 'w15'], ['ControlRight', 'Ctrl', 'w15']],
    [['ArrowUp', '↑'], ['ArrowLeft', '←'], ['ArrowDown', '↓'], ['ArrowRight', '→'], ['Insert', 'Ins'], ['Delete', 'Del'], ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PgUp'], ['PageDown', 'PgDn'], ['PrintScreen', 'PrtSc'], ['ScrollLock', 'ScrLk'], ['Pause', 'Pause']]
  ];
  function initKeyboard() {
    var kb = $('#kbBoard');
    if (!kb) return;
    var html = '';
    KB_ROWS.forEach(function (row) {
      html += '<div class="kb-row">';
      row.forEach(function (k) {
        html += '<div class="key ' + (k[2] || '') + '" data-code="' + k[0] + '">' + k[1] + '</div>';
      });
      html += '</div>';
    });
    kb.innerHTML = html;
    var hitCount = 0, total = kb.querySelectorAll('.key').length;
    var lastEl = $('#kbLast'), cntEl = $('#kbCount'), st = $('#kbStatus'), logEl = $('#kbLog');
    function keyEl(code) { return kb.querySelector('[data-code="' + (window.CSS && CSS.escape ? CSS.escape(code) : code) + '"]'); }
    function log(e, type) {
      if (!logEl) return;
      var row = document.createElement('div');
      row.className = 'rn';
      row.textContent = type + ' — key: "' + e.key + '"   code: ' + e.code + '   keyCode: ' + e.keyCode;
      logEl.insertBefore(row, logEl.firstChild);
      while (logEl.children.length > 8) logEl.removeChild(logEl.lastChild);
    }
    document.addEventListener('keydown', function (e) {
      if (['Tab', 'F1', 'F3', 'F5', 'F7', 'F10', 'F11', 'Space', 'ArrowUp', 'ArrowDown', 'Backspace', "'", '/'].indexOf(e.key) >= 0 ||
        (e.code && e.code.indexOf('Arrow') === 0) || e.code === 'Space') e.preventDefault();
      var el = keyEl(e.code);
      if (el) {
        if (!el.classList.contains('hit')) { el.classList.add('hit'); hitCount++; if (cntEl) cntEl.textContent = hitCount + ' / ' + total; }
        el.classList.add('down');
      }
      if (lastEl) lastEl.textContent = e.code + '  (key: "' + e.key + '", keyCode: ' + e.keyCode + ')';
      log(e, 'down');
      setStatus(st, 'live', 'Listening — press any key. Keys turn green once they have been detected.');
    });
    document.addEventListener('keyup', function (e) {
      var el = keyEl(e.code);
      if (el) el.classList.remove('down');
      log(e, 'up');
    });
    var reset = $('#kbReset');
    if (reset) reset.addEventListener('click', function () {
      $$('.key', kb).forEach(function (k) { k.classList.remove('hit', 'down'); });
      hitCount = 0; if (cntEl) cntEl.textContent = '0 / ' + total;
      if (logEl) logEl.innerHTML = '';
      if (lastEl) lastEl.textContent = '—';
      setStatus(st, '', 'Reset. Press any key to start again.');
    });
    if (cntEl) cntEl.textContent = '0 / ' + total;
    setStatus(st, '', 'Click anywhere on this page first, then press any key.');
  }

  /* ============================================================ MOUSE */
  function initMouse() {
    var area = $('#mouseArea');
    if (!area) return;
    var st = $('#mouseStatus'), posEl = $('#mousePos'), scrollEl = $('#mouseScroll'), dblEl = $('#mouseDbl');
    var scrolls = 0, dbls = 0;
    function mark(id, on) {
      var b = $('#mb-' + id); if (b) b.classList.toggle('on', on !== false);
      var z = $('#z-' + id); if (z) z.classList.toggle('on', on !== false);
    }
    area.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    area.addEventListener('mousedown', function (e) {
      var names = ['left', 'middle', 'right', 'back', 'forward'];
      mark(names[e.button] || ('b' + e.button), true);
      setStatus(st, 'live', 'Button detected: ' + (names[e.button] || 'button ' + e.button) + ' (button index ' + e.button + ')');
      e.preventDefault();
    });
    area.addEventListener('mouseup', function (e) {
      var names = ['left', 'middle', 'right', 'back', 'forward'];
      var el = $('#z-' + (names[e.button] || ''));
      if (el) el.classList.remove('on');
    });
    area.addEventListener('dblclick', function () { dbls++; if (dblEl) dblEl.textContent = dbls; });
    var hovering = false;
    area.addEventListener('mouseenter', function () { hovering = true; });
    area.addEventListener('mouseleave', function () { hovering = false; });
    window.addEventListener('wheel', function (e) {
      var r = area.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside && !hovering && !area.contains(e.target)) return;
      scrolls++; if (scrollEl) scrollEl.textContent = scrolls + ' (' + (e.deltaY < 0 ? 'up' : 'down') + ')';
      mark('scroll', true);
      clearTimeout(area._st); area._st = setTimeout(function () { mark('scroll', false); }, 250);
    }, { passive: true });
    area.addEventListener('mousemove', function (e) {
      var r = area.getBoundingClientRect();
      if (posEl) posEl.textContent = Math.round(e.clientX - r.left) + ', ' + Math.round(e.clientY - r.top);
    });
    var reset = $('#mouseReset');
    if (reset) reset.addEventListener('click', function () {
      $$('.mbtn').forEach(function (b) { b.classList.remove('on'); });
      $$('.mouse-svg .z').forEach(function (z) { z.classList.remove('on'); });
      scrolls = 0; dbls = 0;
      if (scrollEl) scrollEl.textContent = '0'; if (dblEl) dblEl.textContent = '0';
      setStatus(st, '', 'Reset. Click inside the grey area to test again.');
    });
    setStatus(st, '', 'Click, right-click, scroll and move inside the box below.');
  }

  /* ============================================================ CPS TEST */
  function initClick() {
    var pad = $('#clickPad');
    if (!pad) return;
    var nEl = $('#cpsCount'), tEl = $('#cpsTime'), rEl = $('#cpsResult'), st = $('#cpsStatus');
    var durSel = $('#cpsDur');
    var clicks = 0, t0 = 0, running = false, timer = null, dur = 5;
    function reset() {
      running = false; clearInterval(timer); clicks = 0;
      dur = durSel ? +durSel.value : 5;
      if (nEl) nEl.textContent = '0';
      if (tEl) tEl.textContent = dur.toFixed(1) + 's';
      pad.querySelector('span').textContent = 'Click here to start the ' + dur + '-second test';
      setStatus(st, '', 'Pick a duration, then click the panel to begin.');
    }
    function finish() {
      running = false; clearInterval(timer);
      var cps = clicks / dur;
      if (rEl) {
        rEl.className = 'verdict show ' + (cps >= 8 ? 'good' : cps >= 5 ? 'mid' : 'bad');
        var lbl = cps >= 10 ? 'Exceptional' : cps >= 8 ? 'Very fast' : cps >= 6 ? 'Above average' : cps >= 4 ? 'Average' : 'Below average';
        rEl.innerHTML = '<h3>' + cps.toFixed(2) + ' clicks per second — ' + lbl + '</h3><p>You made <strong>' +
          clicks + '</strong> clicks in ' + dur + ' seconds. Most people score between 4 and 7 CPS with a normal grip. ' +
          'If your count looks far lower than it felt, your mouse switch may be missing clicks — check it with the <a href="/double-click-test">double click test</a>.</p>';
      }
      pad.querySelector('span').textContent = 'Click to run the test again';
      setStatus(st, '', 'Finished. Result is shown below.');
    }
    function hit() {
      if (!running) {
        running = true; clicks = 1; t0 = Date.now();
        dur = durSel ? +durSel.value : 5;
        if (nEl) nEl.textContent = '1';
        pad.querySelector('span').textContent = 'Keep clicking!';
        setStatus(st, 'live', 'Test running — click as fast as you can.');
        timer = setInterval(function () {
          var left = dur - (Date.now() - t0) / 1000;
          if (left <= 0) { if (tEl) tEl.textContent = '0.0s'; finish(); return; }
          if (tEl) tEl.textContent = left.toFixed(1) + 's';
        }, 50);
        return;
      }
      clicks++;
      if (nEl) nEl.textContent = clicks;
    }
    pad.addEventListener('mousedown', function (e) { e.preventDefault(); hit(); });
    pad.addEventListener('touchstart', function (e) { e.preventDefault(); hit(); }, { passive: false });
    var rb = $('#cpsReset'); if (rb) rb.addEventListener('click', function () { if (rEl) rEl.className = 'verdict'; reset(); });
    if (durSel) durSel.addEventListener('change', reset);
    reset();
  }

  /* ============================================================ DOUBLE-CLICK */
  function initDouble() {
    var pad = $('#dblPad');
    if (!pad) return;
    var st = $('#dblStatus'), listEl = $('#dblList'), okEl = $('#dblOk'), badEl = $('#dblBad'), resEl = $('#dblResult');
    var last = 0, ok = 0, bad = 0, total = 0;
    pad.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var now = performance.now();
      var gap = last ? now - last : null;
      last = now;
      if (gap === null) {
        setStatus(st, 'live', 'First click registered — now click normally, at your usual pace.');
        return;
      }
      total++;
      var chatter = gap < 70;
      if (chatter) bad++; else ok++;
      if (okEl) okEl.textContent = ok;
      if (badEl) badEl.textContent = bad;
      var row = document.createElement('div');
      row.className = 'rec-item';
      row.innerHTML = '<span class="rn">Click ' + total + '</span><span style="flex:1">Gap since previous click: <strong>' +
        gap.toFixed(1) + ' ms</strong></span><span class="badge ' + (chatter ? 'off' : 'on') + '">' +
        (chatter ? 'Suspicious' : 'Normal') + '</span>';
      if (chatter) row.style.background = '#fef2f2';
      listEl.insertBefore(row, listEl.firstChild);
      while (listEl.children.length > 12) listEl.removeChild(listEl.lastChild);
      pad.querySelector('b').textContent = gap.toFixed(0) + ' ms';
      if (total >= 8 && resEl) {
        var rate = bad / total;
        resEl.className = 'verdict show ' + (bad === 0 ? 'good' : rate > 0.15 ? 'bad' : 'mid');
        resEl.innerHTML = bad === 0
          ? '<h3>No double-click fault detected</h3><p>All ' + total + ' clicks were spaced far enough apart to be real, separate presses. Your left mouse button switch looks healthy.</p>'
          : '<h3>' + bad + ' of ' + total + ' clicks looked like switch chatter</h3><p>Gaps under 70 ms are almost never made by a human hand. When they show up during normal clicking, the switch inside the mouse is bouncing and registering one press as two. That is a hardware fault, and it usually gets worse over time. Cleaning the switch with contact cleaner sometimes helps; replacing the switch or the mouse is the reliable fix.</p>';
      }
    });
    var rb = $('#dblReset');
    if (rb) rb.addEventListener('click', function () {
      last = 0; ok = 0; bad = 0; total = 0;
      if (okEl) okEl.textContent = '0'; if (badEl) badEl.textContent = '0';
      if (listEl) listEl.innerHTML = '';
      if (resEl) resEl.className = 'verdict';
      pad.querySelector('b').textContent = '—';
      setStatus(st, '', 'Reset. Click the panel at a normal pace to test again.');
    });
    setStatus(st, '', 'Click the panel below at your normal pace, about ten times.');
  }

  /* ============================================================ DEAD PIXEL */
  function initPixel() {
    var full = $('#pxFull');
    if (!full) return;
    var hint = $('#pxHint');
    var colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#00ffff', '#ff00ff', '#ffff00', '#808080'];
    var idx = 0, auto = null;
    function show(c) {
      full.style.background = c;
      full.classList.add('show');
      if (hint) { hint.classList.add('show'); hint.textContent = 'Click / press any key to change colour · Esc to exit'; }
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () { });
    }
    function hide() {
      full.classList.remove('show');
      if (hint) hint.classList.remove('show');
      if (auto) clearInterval(auto), auto = null;
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { });
    }
    $$('[data-color]').forEach(function (b) {
      b.style.background = b.getAttribute('data-color');
      b.addEventListener('click', function () { idx = colors.indexOf(b.getAttribute('data-color')); show(b.getAttribute('data-color')); });
    });
    var startBtn = $('#pxStart');
    if (startBtn) startBtn.addEventListener('click', function () { idx = 0; show(colors[0]); });
    var autoBtn = $('#pxAuto');
    if (autoBtn) autoBtn.addEventListener('click', function () {
      idx = 0; show(colors[0]);
      auto = setInterval(function () { idx = (idx + 1) % colors.length; full.style.background = colors[idx]; }, 3000);
      if (hint) hint.textContent = 'Auto-cycling every 3 seconds · Esc to exit';
    });
    full.addEventListener('click', function () { idx = (idx + 1) % colors.length; full.style.background = colors[idx]; });
    document.addEventListener('keydown', function (e) {
      if (!full.classList.contains('show')) return;
      if (e.key === 'Escape') { hide(); return; }
      e.preventDefault();
      idx = (idx + 1) % colors.length; full.style.background = colors[idx];
    });
  }

  function boot() {
    initMic(); initCam(); initSpeaker();
    initKeyboard(); initMouse(); initClick(); initDouble(); initPixel();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
