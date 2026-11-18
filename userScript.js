/*
 * YouTube TV Audio Enhancer \u2014 TizenBrew site-modification module.
 *
 * Runs inside YouTube's own TV web app (youtube.com/tv) on Samsung Tizen TVs.
 * Routes the player's audio through Web Audio:
 *   video -> boost (gain) -> EQ (low shelf, mud cut, presence, air) -> compressor/limiter -> make-up -> fade -> output
 * Also adds playback speed and a sleep timer.
 *
 * Remote control (colour keys; on Samsung smart remotes press the 123 / colour button to show them):
 *   GREEN  = boost up        RED  = boost down
 *   YELLOW = next sound mode BLUE = open / close the Enhancer menu
 * GUIDE = cycle sleep timer. PRE-CH = enhancement on/off.
 * CH UP/DOWN = playback speed; OK (while sped up and playing) = normal speed. Number keys: type seconds to jump back (3 0 = 30 s); start with 0 to jump forward.
 * In the menu: UP/DOWN pick a setting, LEFT/RIGHT change it, OK = normal speed, BACK / BLUE close it.
 *
 * Written in ES5-style JavaScript on purpose: older Tizen browser engines don't support newer syntax.
 */
(function () {
  "use strict";

  // Only run in the top-level YouTube page (TizenBrew evaluates the script in every new context).
  if (window.top !== window) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  if (window.__ytAudioEnhancer) return; // TizenBrew may evaluate the script more than once
  window.__ytAudioEnhancer = true;

  var VERSION = "1.4.0";
  var STORE_KEY = "ytAudioEnhancer.v1";
  var BOOST_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4];
  var SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  // Sleep timer choices: minutes, or "end" = after the current video.
  var SLEEP_CHOICES = [0, 15, 30, 45, 60, 90, 120, "end"];
  var FADE_SECONDS = 10;

  // Sound modes. EQ gains in dB; comp = compressor settings (threshold dB, ratio).
  var MODES = [
    { id: "boost", name: "Boost only", low: 0, mud: 0, presence: 0, air: 0, comp: { threshold: -3, ratio: 20 } },
    { id: "voice", name: "Clear voice", low: -2, mud: -3, presence: 5, air: 2, comp: { threshold: -18, ratio: 3 } },
    { id: "bass", name: "Bass boost", low: 7, mud: -1, presence: 1, air: 1, comp: { threshold: -10, ratio: 4 } },
    { id: "movie", name: "Movie", low: 4, mud: -2, presence: 3, air: 3, comp: { threshold: -14, ratio: 3 } },
    { id: "music", name: "Music", low: 3, mud: -1, presence: 1, air: 3, comp: { threshold: -8, ratio: 3 } },
    { id: "night", name: "Night (even volume)", low: -3, mud: -2, presence: 4, air: 0, comp: { threshold: -30, ratio: 8 } }
  ];

  // Tizen key codes. Colour keys are registered via package.json "keys"; arrows, OK and Back always arrive.
  var KEY = { RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, CH_UP: 427, CH_DOWN: 428, GUIDE: 458, PRE_CH: 10190 };

  var state = load();
  var ctx = null;
  var chain = null; // { video, source, boost, low, mud, presence, air, comp, makeup, fade, analyser }

  // ---------- settings ----------
  function load() {
    var s = { boostIndex: 2, mode: "voice", enabled: true, unsupported: false, speed: 1 };
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      for (var k in saved) if (Object.prototype.hasOwnProperty.call(s, k)) s[k] = saved[k];
    } catch (e) {}
    if (s.boostIndex < 0 || s.boostIndex >= BOOST_STEPS.length) s.boostIndex = 2;
    if (!modeById(s.mode)) s.mode = "voice";
    if (SPEEDS.indexOf(s.speed) < 0) s.speed = 1;
    return s;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function modeById(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
    return null;
  }
  function modeIndex() {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === state.mode) return i;
    return 0;
  }

  // ---------- audio graph ----------
  function makeFilter(type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    return f;
  }

  function attach(video) {
    if (state.unsupported) return;
    if (chain && chain.video === video) return;
    if (video.__ytaeAttached) return;
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      var source = ctx.createMediaElementSource(video);
      video.__ytaeAttached = true;
      var c = {
        video: video,
        source: source,
        boost: ctx.createGain(),
        low: makeFilter("lowshelf", 120),
        mud: makeFilter("peaking", 350, 1.0),
        presence: makeFilter("peaking", 2800, 0.9),
        air: makeFilter("highshelf", 9000),
        comp: ctx.createDynamicsCompressor(),
        makeup: ctx.createGain(),
        fade: ctx.createGain(),
        analyser: ctx.createAnalyser()
      };
      c.comp.knee.value = 6;
      c.comp.attack.value = 0.005;
      c.comp.release.value = 0.2;
      c.analyser.fftSize = 2048;

      source.connect(c.boost);
      c.boost.connect(c.low);
      c.low.connect(c.mud);
      c.mud.connect(c.presence);
      c.presence.connect(c.air);
      c.air.connect(c.comp);
      c.comp.connect(c.makeup);
      c.makeup.connect(c.fade);
      c.fade.connect(c.analyser);
      c.analyser.connect(ctx.destination);

      chain = c;
      applySettings();
      watchForSilence(c);
      video.addEventListener("play", resume);
      resume();
    } catch (e) {
      log("could not attach: " + e);
    }
  }

  function applySettings() {
    if (!chain) return;
    var m = modeById(state.mode);
    var on = state.enabled;
    var boost = on ? BOOST_STEPS[state.boostIndex] : 1;
    setParam(chain.boost.gain, boost);
    setParam(chain.low.gain, on ? m.low : 0);
    setParam(chain.mud.gain, on ? m.mud : 0);
    setParam(chain.presence.gain, on ? m.presence : 0);
    setParam(chain.air.gain, on ? m.air : 0);
    // Bypassed: a compressor at 0 dB threshold and ratio 1 does nothing.
    setParam(chain.comp.threshold, on ? m.comp.threshold : 0);
    setParam(chain.comp.ratio, on ? m.comp.ratio : 1);
    // Make-up gain wins back loudness the compressor took off; capped so the limiter-style modes don't clip.
    var makeup = on ? Math.min(2, 1 + Math.max(0, -m.comp.threshold - 6) / 30) : 1;
    setParam(chain.makeup.gain, makeup);
  }

  function setParam(param, value) {
    // A suspended context's clock is frozen, so set values directly rather than scheduling them.
    try {
      param.cancelScheduledValues(ctx.currentTime);
      if (ctx.state === "running") {
        param.setValueAtTime(param.value, ctx.currentTime);
        param.setTargetAtTime(value, ctx.currentTime, 0.03);
      } else {
        param.value = value;
      }
    } catch (e) {
      param.value = value;
    }
  }

  function resume() {
    if (ctx && ctx.state === "suspended" && ctx.resume) ctx.resume();
  }

  // Some TVs decode video in hardware and don't hand its audio to Web Audio. If that happens the
  // player goes silent. Detect it (playing, not muted, exact digital silence for several seconds),
  // remember it, and reload so YouTube plays normally without the enhancer.
  function watchForSilence(c) {
    var buf = new Float32Array(c.analyser.fftSize);
    var silentFor = 0;
    var heardSound = false;
    var lastTime = -1;
    var timer = setInterval(function () {
      if (chain !== c || heardSound) { clearInterval(timer); return; }
      var v = c.video;
      var playing = !v.paused && !v.ended && !v.muted && v.volume > 0 && v.currentTime !== lastTime && v.readyState >= 3;
      lastTime = v.currentTime;
      if (!playing || sleep.fading) return;
      if (c.analyser.getFloatTimeDomainData) c.analyser.getFloatTimeDomainData(buf);
      var peak = 0;
      for (var i = 0; i < buf.length; i++) { var a = Math.abs(buf[i]); if (a > peak) peak = a; }
      if (peak > 0) { heardSound = true; return; }
      silentFor += 1;
      if (silentFor >= 8) { // 8 x 1 s of playback with nothing coming through
        clearInterval(timer);
        state.unsupported = true;
        save();
        toast("Audio enhancer isn't supported on this TV", "Turning it off so YouTube plays normally", 4000);
        setTimeout(function () { location.reload(); }, 3000);
      }
    }, 1000);
  }

  function findVideo() {
    var vids = document.getElementsByTagName("video");
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].src || vids[i].currentSrc || vids[i].readyState > 0) return vids[i];
    }
    return vids[0] || null;
  }

  function scan() {
    var v = findVideo();
    if (!v) return;
    watchSpeed(v);
    watchVideoForSleep(v);
    attach(v);
  }

  // ---------- playback speed ----------
  // YouTube resets the speed to 1x when a new video loads; re-apply ours. If the viewer changes the
  // speed in YouTube's own menu, adopt that instead of fighting it.
  var settingRate = false;
  var pendingReapply = false;
  function applySpeed(v) {
    v = v || findVideo();
    if (!v) return;
    if (Math.abs(v.playbackRate - state.speed) < 0.001) return;
    settingRate = true;
    try { v.playbackRate = state.speed; } catch (e) {}
    setTimeout(function () { settingRate = false; }, 0);
  }
  function watchSpeed(v) {
    if (v.__ytaeSpeed) return;
    v.__ytaeSpeed = true;
    v.addEventListener("loadstart", function () { pendingReapply = true; });
    v.addEventListener("playing", function () { pendingReapply = false; applySpeed(v); });
    v.addEventListener("loadedmetadata", function () { applySpeed(v); });
    v.addEventListener("ratechange", function () {
      if (settingRate) return;
      if (pendingReapply || v.readyState < 1) { applySpeed(v); return; }
      var r = Math.round(v.playbackRate * 100) / 100;
      if (SPEEDS.indexOf(r) >= 0 && r !== state.speed) {
        state.speed = r;
        save();
        renderMenu();
      }
    });
    applySpeed(v);
  }
  function stepSpeed(dir) {
    var i = SPEEDS.indexOf(state.speed);
    if (i < 0) i = 1;
    i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
    state.speed = SPEEDS[i];
    save();
    applySpeed();
  }
  function speedText() {
    return (state.speed === 1 ? "Normal" : state.speed + "\u00d7");
  }

  // ---------- sleep timer ----------
  // At the end it fades the sound out over FADE_SECONDS, pauses the video and dims the screen.
  var sleep = { choice: 0, endsAt: 0, timer: null, warned: false, fading: false, armedVideo: null };

  function sleepText() {
    if (sleep.choice === 0) return "Off";
    if (sleep.choice === "end") return "End of this video";
    var left = Math.max(0, sleep.endsAt - Date.now());
    var m = Math.floor(left / 60000);
    var s = Math.floor((left % 60000) / 1000);
    return sleep.choice + " min \u00b7 " + m + ":" + (s < 10 ? "0" : "") + s + " left";
  }

  function setSleep(choice) {
    clearInterval(sleep.timer);
    cancelFade();
    sleep.choice = choice;
    sleep.warned = false;
    sleep.endsAt = 0;
    sleep.armedVideo = null;
    if (choice === 0) return;
    if (choice === "end") {
      sleep.armedVideo = findVideo();
      return;
    }
    sleep.endsAt = Date.now() + choice * 60000;
    sleep.timer = setInterval(sleepTick, 1000);
  }
  // Exposed for tests: set the timer in seconds.
  function setSleepSeconds(sec) {
    setSleep(0);
    sleep.choice = Math.max(1, Math.round(sec / 60)) || 1;
    sleep.endsAt = Date.now() + sec * 1000;
    sleep.timer = setInterval(sleepTick, 250);
  }

  function sleepTick() {
    var left = sleep.endsAt - Date.now();
    if (!sleep.warned && left <= 60000 && left > FADE_SECONDS * 1000) {
      sleep.warned = true;
      toast("\uD83C\uDF19 Sleep timer: pausing in 1 minute", "Press GUIDE to change it", 5000);
    }
    if (left <= FADE_SECONDS * 1000 && !sleep.fading) startFade();
    if (menuOpen) renderMenu();
  }

  function watchVideoForSleep(v) {
    if (v.__ytaeSleep) return;
    v.__ytaeSleep = true;
    v.addEventListener("ended", function () {
      if (sleep.choice === "end") sleepNow();
    });
    // YouTube autoplays the next video in the same element, so a new load also counts as "video ended".
    v.addEventListener("loadstart", function () {
      if (sleep.choice === "end" && sleep.armedVideo === v && v.__ytaeSeenSrc && v.__ytaeSeenSrc !== (v.currentSrc || v.src)) sleepNow();
    });
    v.addEventListener("playing", function () { v.__ytaeSeenSrc = v.currentSrc || v.src; });
  }

  var fadeTimer = null;
  function startFade() {
    sleep.fading = true;
    var v = findVideo();
    var startVol = v ? v.volume : 1;
    var started = Date.now();
    if (chain && ctx) {
      try {
        chain.fade.gain.cancelScheduledValues(ctx.currentTime);
        chain.fade.gain.setValueAtTime(chain.fade.gain.value, ctx.currentTime);
        chain.fade.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + FADE_SECONDS);
      } catch (e) {}
    } else if (v) {
      // No Web Audio chain (e.g. not supported on this TV): fade the element volume instead.
      fadeTimer = setInterval(function () {
        var t = Math.min(1, (Date.now() - started) / (FADE_SECONDS * 1000));
        try { v.volume = startVol * (1 - t); } catch (e) {}
        if (t >= 1) clearInterval(fadeTimer);
      }, 200);
      v.__ytaeVolBeforeFade = startVol;
    }
    setTimeout(function () { if (sleep.fading) sleepNow(); }, FADE_SECONDS * 1000);
  }

  function cancelFade() {
    if (!sleep.fading) return;
    sleep.fading = false;
    clearInterval(fadeTimer);
    restoreVolume();
  }

  function restoreVolume() {
    if (chain && ctx) setParam(chain.fade.gain, 1);
    var v = findVideo();
    if (v && v.__ytaeVolBeforeFade !== undefined) {
      try { v.volume = v.__ytaeVolBeforeFade; } catch (e) {}
      v.__ytaeVolBeforeFade = undefined;
    }
  }

  var dimEl = null;
  function sleepNow() {
    clearInterval(sleep.timer);
    var v = findVideo();
    if (v && !v.paused) { try { v.pause(); } catch (e) {} }
    sleep.choice = 0;
    sleep.endsAt = 0;
    sleep.fading = false;
    // Put the volume back so it's normal next time; the video is paused so nothing is heard.
    setTimeout(restoreVolume, 300);
    closeMenu();
    if (!dimEl) {
      dimEl = el("div",
        "position:fixed;left:0;top:0;width:100%;height:100%;background:#000;z-index:2147483646;" +
        "color:rgba(255,255,255,.35);font:400 28px/1.4 Roboto,Arial,sans-serif;" +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center");
      dimEl.appendChild(el("div", "", "\uD83C\uDF19 Sleep timer ended"));
      dimEl.appendChild(el("div", "", "Press any button to wake"));
    }
    if (document.body && dimEl.parentNode !== document.body) document.body.appendChild(dimEl);
  }
  function wakeFromSleep() {
    if (dimEl && dimEl.parentNode) { dimEl.parentNode.removeChild(dimEl); return true; }
    return false;
  }

  // ---------- DOM helper ----------
  // YouTube's TV app enforces Trusted Types, which blocks innerHTML with plain strings. Every on-screen
  // element is therefore built with createElement + textContent, never innerHTML.
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---------- on-screen indicator ----------
  var toastEl = null;
  var toastTimer = null;
  // toast(mainLine, smallLine?, ms?)
  function toast(main, sub, ms) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = el("div",
        "position:fixed;top:6%;left:50%;transform:translateX(-50%);-webkit-transform:translateX(-50%);" +
        "padding:18px 34px;border-radius:48px;background:rgba(0,0,0,0.82);color:#fff;" +
        "font:500 30px/1.3 Roboto,Arial,sans-serif;z-index:2147483647;pointer-events:none;" +
        "text-align:center;transition:opacity .25s;opacity:0;white-space:nowrap");
    }
    if (toastEl.parentNode !== document.body) document.body.appendChild(toastEl);
    clear(toastEl);
    toastEl.appendChild(el("div", "", main));
    if (sub) toastEl.appendChild(el("div", "opacity:.7;font-size:20px;font-weight:400;margin-top:4px", sub));
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, ms || 2200);
  }

  var DOT = " \u00b7 ";
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
    return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (s2 < 10 ? "0" : "") + s2;
  }

  // ---------- jump (number keys) ----------
  // Type a number of seconds and it jumps back that far, e.g. 5, 30, 120. Start with 0 to jump forward
  // (0 3 0 = forward 30 s). It jumps ~1.5 s after the last digit. Only while a video is open, so typing
  // digits elsewhere in YouTube is left alone.
  var JUMP_WAIT_MS = 1500;
  var FWD_WAIT_MS = 3000;
  var entry = { fwd: false, digits: "", timer: null };
  function videoOpen() {
    var v = findVideo();
    return !!(v && isFinite(v.duration) && v.duration > 0 && /watch/.test(location.hash + location.pathname));
  }
  function jump(seconds) {
    var v = findVideo();
    if (!v || !isFinite(v.duration)) return;
    var target = Math.max(0, Math.min(v.duration - 1, v.currentTime + seconds));
    try { v.currentTime = target; } catch (e) {}
    toast((seconds > 0 ? "\u23e9 Forward " : "\u23ea Back ") + Math.abs(seconds) + " s" + DOT + fmtTime(target) + " / " + fmtTime(v.duration),
      "Type seconds to jump back" + DOT + "0 first to jump forward");
  }
  function resetEntry() {
    clearTimeout(entry.timer);
    entry.fwd = false;
    entry.digits = "";
  }
  function commitEntry() {
    var n = parseInt(entry.digits, 10);
    var fwd = entry.fwd;
    resetEntry();
    if (!n) { toast("Jump cancelled"); return; }
    jump(fwd ? n : -n);
  }
  function onDigit(n) {
    if (!entry.fwd && entry.digits === "" && n === 0) {
      entry.fwd = true;
    } else if (entry.digits.length < 5) {
      entry.digits += String(n);
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(commitEntry, entry.digits === "" ? FWD_WAIT_MS : JUMP_WAIT_MS);
    toast((entry.fwd ? "\u23e9 Jump forward: " : "\u23ea Jump back: ") + (entry.digits || "_") + " s",
      entry.digits === "" ? "Type the seconds" : "Jumping\u2026 keep typing to add digits");
  }

  function showSpeed() {
    toast("\u23e9 Speed: " + speedText(), "CH \u25b2 faster" + DOT + "CH \u25bc slower" + DOT + "OK = normal");
  }
  function showStatus(ms) {
    if (state.unsupported) { toast("Audio enhancer: not supported on this TV", "Hold D for 3 s to try again", ms); return; }
    var parts = [];
    if (!state.enabled) parts.push("\uD83D\uDD08 Enhancement OFF");
    else parts.push("\uD83D\uDD0A " + modeById(state.mode).name + DOT + Math.round(BOOST_STEPS[state.boostIndex] * 100) + "%");
    if (state.speed !== 1) parts.push(state.speed + "\u00d7");
    if (sleep.choice !== 0) parts.push("\uD83C\uDF19 " + (sleep.choice === "end" ? "end of video" : sleepText().split(DOT)[1]));
    toast(parts.join(DOT), "A/B boost" + DOT + "C mode" + DOT + "D menu" + DOT + "CH speed" + DOT + "numbers jump back (s)", ms);
  }

  // ---------- menu ----------
  var menuOpen = false;
  var menuEl = null;
  var menuRow = 0;
  var menuIdleTimer = null;

  var MENU = [
    {
      label: "Volume boost",
      value: function () { return state.unsupported ? "Not supported" : Math.round(BOOST_STEPS[state.boostIndex] * 100) + "%"; },
      change: function (d) {
        state.enabled = true;
        state.boostIndex = Math.max(0, Math.min(BOOST_STEPS.length - 1, state.boostIndex + d));
        save(); applySettings();
      }
    },
    {
      label: "Sound mode",
      value: function () { return state.unsupported ? "Not supported" : modeById(state.mode).name; },
      change: function (d) {
        state.enabled = true;
        state.mode = MODES[(modeIndex() + d + MODES.length) % MODES.length].id;
        save(); applySettings();
      }
    },
    {
      label: "Enhancement",
      value: function () { return state.unsupported ? "Not supported" : (state.enabled ? "On" : "Off"); },
      change: function () { state.enabled = !state.enabled; save(); applySettings(); }
    },
    {
      label: "Playback speed",
      value: speedText,
      change: function (d) { stepSpeed(d); }
    },
    {
      label: "Sleep timer",
      value: sleepText,
      change: function (d) {
        var i = SLEEP_CHOICES.indexOf(sleep.choice);
        if (i < 0) i = 0;
        i = (i + d + SLEEP_CHOICES.length) % SLEEP_CHOICES.length;
        setSleep(SLEEP_CHOICES[i]);
      }
    }
  ];

  var SPEED_ROW = 3; // index of "Playback speed" in MENU
  var SLEEP_ROW = 4; // index of "Sleep timer" in MENU

  function buildMenu() {
    menuEl = el("div",
      "position:fixed;top:50%;right:4%;transform:translateY(-50%);-webkit-transform:translateY(-50%);" +
      "width:620px;padding:28px 0 20px;border-radius:28px;background:rgba(18,18,18,0.94);" +
      "box-shadow:0 20px 60px rgba(0,0,0,.6);color:#fff;font:400 28px/1.3 Roboto,Arial,sans-serif;" +
      "z-index:2147483647;text-align:left");
  }

  function renderMenu() {
    if (!menuOpen || !menuEl) return;
    clear(menuEl);
    menuEl.appendChild(el("div", "padding:0 36px 16px;font-size:24px;letter-spacing:.06em;color:#aaa;text-transform:uppercase", "Enhancer"));
    for (var i = 0; i < MENU.length; i++) {
      var sel = i === menuRow;
      var row = el("div", "display:flex;justify-content:space-between;align-items:center;padding:16px 36px;" +
        (sel ? "background:#fff;color:#0f0f0f;" : "color:#fff;"));
      row.appendChild(el("span", "font-weight:500", MENU[i].label));
      row.appendChild(el("span", "font-weight:" + (sel ? 600 : 400) + ";" + (sel ? "" : "color:#ccc;"),
        (sel ? "\u25c0\u00a0 " : "") + MENU[i].value() + (sel ? " \u00a0\u25b6" : "")));
      menuEl.appendChild(row);
    }
    menuEl.appendChild(el("div", "padding:18px 36px 0;font-size:20px;color:#888",
      "\u25b2\u25bc choose" + DOT + "\u25c0\u25b6 change" + DOT + "OK normal speed" + DOT + "BACK close"));
    bumpIdle();
  }

  function bumpIdle() {
    clearTimeout(menuIdleTimer);
    menuIdleTimer = setTimeout(closeMenu, 20000);
  }

  function openMenu() {
    if (!document.body) return;
    if (!menuEl) buildMenu();
    if (menuEl.parentNode !== document.body) document.body.appendChild(menuEl);
    menuOpen = true;
    if (toastEl) toastEl.style.opacity = "0";
    renderMenu();
  }
  function closeMenu() {
    menuOpen = false;
    clearTimeout(menuIdleTimer);
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
  }

  // ---------- remote keys ----------
  var swallowUp = {}; // keys whose keydown we consumed: swallow the matching keyup too
  var blueDownAt = 0;

  function consume(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    swallowUp[e.keyCode] = true;
  }

  function onKeyDown(e) {
    var code = e.keyCode;

    // Any button wakes the screen after the sleep timer, without also acting on YouTube.
    if (dimEl && dimEl.parentNode) {
      consume(e);
      wakeFromSleep();
      return;
    }
    // Any button during the fade-out cancels it (the viewer is still awake).
    if (sleep.fading) {
      cancelFade();
      setSleep(0);
      toast("\uD83C\uDF19 Sleep timer cancelled");
    }

    // Number keys: type seconds to jump back / forward (only while a video is open).
    if (code >= 48 && code <= 57 && videoOpen()) {
      consume(e);
      if (!e.repeat) onDigit(code - 48);
      return;
    }

    if (menuOpen) {
      if (code === KEY.UP || code === KEY.DOWN || code === KEY.LEFT || code === KEY.RIGHT ||
          code === KEY.ENTER || code === KEY.BACK || code === KEY.ESC || code === KEY.BLUE ||
          code === KEY.RED || code === KEY.GREEN || code === KEY.YELLOW ||
          code === KEY.CH_UP || code === KEY.CH_DOWN || code === KEY.GUIDE || code === KEY.PRE_CH) {
        consume(e);
        if (code === KEY.UP) menuRow = (menuRow - 1 + MENU.length) % MENU.length;
        else if (code === KEY.DOWN) menuRow = (menuRow + 1) % MENU.length;
        else if (code === KEY.LEFT) { if (!(state.unsupported && menuRow < 3)) MENU[menuRow].change(-1); }
        else if (code === KEY.RIGHT) { if (!(state.unsupported && menuRow < 3)) MENU[menuRow].change(1); }
        else if (code === KEY.GREEN) MENU[0].change(1);
        else if (code === KEY.RED) MENU[0].change(-1);
        else if (code === KEY.YELLOW) MENU[1].change(1);
        else if (code === KEY.CH_UP || code === KEY.CH_DOWN) { stepSpeed(code === KEY.CH_UP ? 1 : -1); menuRow = SPEED_ROW; }
        else if (code === KEY.GUIDE) { if (!e.repeat) { MENU[SLEEP_ROW].change(1); menuRow = SLEEP_ROW; } }
        else if (code === KEY.PRE_CH) { if (!e.repeat && !state.unsupported) { MENU[2].change(1); menuRow = 2; } }
        else if (code === KEY.ENTER) {
          // OK puts playback speed back to Normal; the menu stays open.
          if (!e.repeat) { state.speed = 1; save(); applySpeed(); menuRow = SPEED_ROW; }
        }
        else if (!e.repeat) { closeMenu(); return; } // BACK / ESC / BLUE
        renderMenu();
        return;
      }
      return;
    }

    // GUIDE: cycle the sleep timer. PRE-CH: enhancement on / off. (No menu needed.)
    if (code === KEY.GUIDE) {
      consume(e);
      if (!e.repeat) MENU[SLEEP_ROW].change(1);
      toast("\uD83C\uDF19 Sleep timer: " + sleepText(), "Press GUIDE again to change" + DOT + "Off" + DOT + "15-120 min" + DOT + "end of video");
      return;
    }
    if (code === KEY.PRE_CH) {
      consume(e);
      if (!e.repeat && !state.unsupported) MENU[2].change(1);
      showStatus();
      return;
    }

    // OK while a video is sped up (or slowed down) and playing: back to Normal speed.
    // That press is used up; the next OK goes to YouTube as usual. Paused videos are left alone.
    if (code === KEY.ENTER && state.speed !== 1 && videoOpen()) {
      var pv = findVideo();
      if (pv && !pv.paused) {
        consume(e);
        if (!e.repeat) { state.speed = 1; save(); applySpeed(); }
        showSpeed();
        return;
      }
    }

    // CH up / down: playback speed without opening the menu.
    if (code === KEY.CH_UP || code === KEY.CH_DOWN) {
      consume(e);
      if (!e.repeat) stepSpeed(code === KEY.CH_UP ? 1 : -1);
      showSpeed();
      return;
    }

    if (code !== KEY.RED && code !== KEY.GREEN && code !== KEY.YELLOW && code !== KEY.BLUE) return;
    consume(e);

    if (code === KEY.BLUE) {
      if (!blueDownAt) blueDownAt = Date.now();
      // Holding BLUE for 3 s clears the "not supported" flag so it can be tried again.
      if (state.unsupported && Date.now() - blueDownAt > 3000) {
        state.unsupported = false;
        save();
        toast("Trying the audio enhancer again\u2026");
        blueDownAt = 0;
        setTimeout(function () { location.reload(); }, 1200);
      }
      return;
    }
    if (e.repeat) return;

    resume();
    if (!state.unsupported) scan();
    if (state.unsupported) { showStatus(); return; }
    if (code === KEY.GREEN) MENU[0].change(1);
    else if (code === KEY.RED) MENU[0].change(-1);
    else if (code === KEY.YELLOW) MENU[1].change(1);
    showStatus();
  }

  function onKeyUp(e) {
    var code = e.keyCode;
    if (!swallowUp[code]) return;
    swallowUp[code] = false;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (code === KEY.BLUE && blueDownAt) {
      var held = Date.now() - blueDownAt;
      blueDownAt = 0;
      if (held < 1500) openMenu();
    }
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Any remote press counts as the user gesture some engines need before audio can start.
  window.addEventListener("keydown", resume, true);

  // ---------- start ----------
  function log(msg) { try { console.log("[YT Audio Enhancer] " + msg); } catch (e) {} }

  function start() {
    scan();
    // YouTube TV swaps players without reloading; keep looking for the video element.
    setInterval(scan, 1500);
    setTimeout(function () { showStatus(4000); }, 2500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // Exposed for testing and troubleshooting from the remote debugger.
  window.__ytAudioEnhancerDebug = {
    version: VERSION,
    state: function () { return state; },
    chain: function () { return chain; },
    context: function () { return ctx; },
    sleep: function () { return sleep; },
    setSleepSeconds: setSleepSeconds,
    menuOpen: function () { return menuOpen; }
  };
})();
