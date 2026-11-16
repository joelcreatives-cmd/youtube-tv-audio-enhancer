/*
 * YouTube TV Audio Enhancer — TizenBrew site-modification module.
 *
 * Runs inside YouTube's own TV web app (youtube.com/tv) on Samsung Tizen TVs.
 * Routes the player's audio through Web Audio:
 *   video -> boost (gain) -> EQ (low shelf, mud cut, presence, air) -> compressor/limiter -> make-up -> fade -> output
 * Also adds playback speed and a sleep timer.
 *
 * Remote control (colour keys; on Samsung smart remotes press the 123 / colour button to show them):
 *   GREEN  = boost up        RED  = boost down
 *   YELLOW = next sound mode BLUE = open / close the Enhancer menu
 * In the menu: UP/DOWN pick a setting, LEFT/RIGHT change it, OK / BACK / BLUE close it.
 *
 * Written in ES5-style JavaScript on purpose: older Tizen browser engines don't support newer syntax.
 */
(function () {
  "use strict";

  if (window.__ytAudioEnhancer) return; // TizenBrew may evaluate the script more than once
  window.__ytAudioEnhancer = true;

  var VERSION = "1.1.0";
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
  var KEY = { RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27 };

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
        toast("Audio enhancer isn't supported on this TV — turning it off", 4000);
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
    return (state.speed === 1 ? "Normal" : state.speed + "×");
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
    return sleep.choice + " min · " + m + ":" + (s < 10 ? "0" : "") + s + " left";
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
      toast("&#127769; Sleep timer: pausing in 1 minute<br><small style=\"opacity:.7;font-size:20px\">Press BLUE to change it</small>", 5000);
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
      dimEl = document.createElement("div");
      var s = dimEl.style;
      s.position = "fixed";
      s.left = s.top = "0";
      s.width = s.height = "100%";
      s.background = "#000";
      s.zIndex = "2147483646";
      s.color = "rgba(255,255,255,.35)";
      s.font = "400 28px/1.4 Roboto, Arial, sans-serif";
      s.display = "flex";
      s.alignItems = "center";
      s.justifyContent = "center";
      s.textAlign = "center";
      dimEl.innerHTML = "&#127769; Sleep timer ended<br>Press any button to wake";
    }
    if (document.body && dimEl.parentNode !== document.body) document.body.appendChild(dimEl);
  }
  function wakeFromSleep() {
    if (dimEl && dimEl.parentNode) { dimEl.parentNode.removeChild(dimEl); return true; }
    return false;
  }

  // ---------- on-screen indicator ----------
  var toastEl = null;
  var toastTimer = null;
  function toast(text, ms) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      var s = toastEl.style;
      s.position = "fixed";
      s.top = "6%";
      s.left = "50%";
      s.transform = "translateX(-50%)";
      s.webkitTransform = "translateX(-50%)";
      s.padding = "18px 34px";
      s.borderRadius = "48px";
      s.background = "rgba(0,0,0,0.82)";
      s.color = "#fff";
      s.font = "500 30px/1.3 Roboto, Arial, sans-serif";
      s.zIndex = "2147483647";
      s.pointerEvents = "none";
      s.textAlign = "center";
      s.transition = "opacity .25s";
      s.opacity = "0";
    }
    if (toastEl.parentNode !== document.body) document.body.appendChild(toastEl);
    toastEl.innerHTML = text;
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, ms || 2200);
  }

  function statusText() {
    if (state.unsupported) return "Audio enhancer: not supported on this TV<br><small>Hold BLUE 3 s to try again</small>";
    var parts = [];
    if (!state.enabled) parts.push("&#128264; Enhancement OFF");
    else parts.push("&#128266; " + modeById(state.mode).name + " &middot; " + Math.round(BOOST_STEPS[state.boostIndex] * 100) + "%");
    if (state.speed !== 1) parts.push(state.speed + "&times;");
    if (sleep.choice !== 0) parts.push("&#127769; " + (sleep.choice === "end" ? "end of video" : sleepText().split(" · ")[1]));
    return parts.join(" &middot; ") +
      '<br><small style="opacity:.7;font-size:20px">GREEN/RED boost &middot; YELLOW mode &middot; BLUE menu</small>';
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

  function buildMenu() {
    menuEl = document.createElement("div");
    var s = menuEl.style;
    s.position = "fixed";
    s.top = "50%";
    s.right = "4%";
    s.transform = "translateY(-50%)";
    s.webkitTransform = "translateY(-50%)";
    s.width = "620px";
    s.padding = "28px 0 20px";
    s.borderRadius = "28px";
    s.background = "rgba(18,18,18,0.94)";
    s.boxShadow = "0 20px 60px rgba(0,0,0,.6)";
    s.color = "#fff";
    s.font = "400 28px/1.3 Roboto, Arial, sans-serif";
    s.zIndex = "2147483647";
  }

  function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function renderMenu() {
    if (!menuOpen || !menuEl) return;
    var html = '<div style="padding:0 36px 16px;font-size:24px;letter-spacing:.06em;color:#aaa;text-transform:uppercase">Enhancer</div>';
    for (var i = 0; i < MENU.length; i++) {
      var sel = i === menuRow;
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:16px 36px;' +
        (sel ? "background:#fff;color:#0f0f0f;" : "") + '">' +
        '<span style="font-weight:500">' + esc(MENU[i].label) + "</span>" +
        '<span style="font-weight:' + (sel ? 600 : 400) + ';' + (sel ? "" : "color:#ccc;") + '">' +
        (sel ? "&#9664;&nbsp; " : "") + esc(MENU[i].value()) + (sel ? " &nbsp;&#9654;" : "") + "</span></div>";
    }
    html += '<div style="padding:18px 36px 0;font-size:20px;color:#888">&#9650;&#9660; choose &nbsp;&middot;&nbsp; &#9664;&#9654; change &nbsp;&middot;&nbsp; OK / BACK close</div>';
    menuEl.innerHTML = html;
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
      toast("&#127769; Sleep timer cancelled");
    }

    if (menuOpen) {
      if (code === KEY.UP || code === KEY.DOWN || code === KEY.LEFT || code === KEY.RIGHT ||
          code === KEY.ENTER || code === KEY.BACK || code === KEY.ESC || code === KEY.BLUE ||
          code === KEY.RED || code === KEY.GREEN || code === KEY.YELLOW) {
        consume(e);
        if (code === KEY.UP) menuRow = (menuRow - 1 + MENU.length) % MENU.length;
        else if (code === KEY.DOWN) menuRow = (menuRow + 1) % MENU.length;
        else if (code === KEY.LEFT) { if (!(state.unsupported && menuRow < 3)) MENU[menuRow].change(-1); }
        else if (code === KEY.RIGHT) { if (!(state.unsupported && menuRow < 3)) MENU[menuRow].change(1); }
        else if (code === KEY.GREEN) MENU[0].change(1);
        else if (code === KEY.RED) MENU[0].change(-1);
        else if (code === KEY.YELLOW) MENU[1].change(1);
        else if (!e.repeat) { closeMenu(); return; } // ENTER / BACK / ESC / BLUE
        renderMenu();
        return;
      }
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
        toast("Trying the audio enhancer again…");
        blueDownAt = 0;
        setTimeout(function () { location.reload(); }, 1200);
      }
      return;
    }
    if (e.repeat) return;

    resume();
    if (!state.unsupported) scan();
    if (state.unsupported) { toast(statusText()); return; }
    if (code === KEY.GREEN) MENU[0].change(1);
    else if (code === KEY.RED) MENU[0].change(-1);
    else if (code === KEY.YELLOW) MENU[1].change(1);
    toast(statusText());
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
    setTimeout(function () { toast(statusText(), 4000); }, 2500);
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
