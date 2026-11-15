/*
 * YouTube TV Audio Enhancer — TizenBrew site-modification module.
 *
 * Runs inside YouTube's own TV web app (youtube.com/tv) on Samsung Tizen TVs.
 * Routes the player's audio through Web Audio:
 *   video -> boost (gain) -> EQ (low shelf, mud cut, presence, air) -> compressor/limiter -> output
 *
 * Remote control (colour keys; on Samsung smart remotes press the 123 / colour button to show them):
 *   GREEN  = boost up        RED  = boost down
 *   YELLOW = next sound mode BLUE = enhancement on/off (bypass)
 *
 * Written in ES5-style JavaScript on purpose: older Tizen browser engines don't support newer syntax.
 */
(function () {
  "use strict";

  if (window.__ytAudioEnhancer) return; // TizenBrew may evaluate the script more than once
  window.__ytAudioEnhancer = true;

  var STORE_KEY = "ytAudioEnhancer.v1";
  var BOOST_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4];

  // Sound modes. EQ gains in dB; comp = compressor settings (threshold dB, ratio).
  var MODES = [
    { id: "boost", name: "Boost only", low: 0, mud: 0, presence: 0, air: 0, comp: { threshold: -3, ratio: 20 } },
    { id: "voice", name: "Clear voice", low: -2, mud: -3, presence: 5, air: 2, comp: { threshold: -18, ratio: 3 } },
    { id: "bass", name: "Bass boost", low: 7, mud: -1, presence: 1, air: 1, comp: { threshold: -10, ratio: 4 } },
    { id: "movie", name: "Movie", low: 4, mud: -2, presence: 3, air: 3, comp: { threshold: -14, ratio: 3 } },
    { id: "music", name: "Music", low: 3, mud: -1, presence: 1, air: 3, comp: { threshold: -8, ratio: 3 } },
    { id: "night", name: "Night (even volume)", low: -3, mud: -2, presence: 4, air: 0, comp: { threshold: -30, ratio: 8 } }
  ];

  // Key codes for Tizen colour keys (registered via package.json "keys").
  var KEY = { RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406 };

  var state = load();
  var ctx = null;
  var chain = null; // { video, source, boost, low, mud, presence, air, comp, makeup, analyser }

  // ---------- settings ----------
  function load() {
    var s = { boostIndex: 2, mode: "voice", enabled: true, unsupported: false };
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      for (var k in saved) if (Object.prototype.hasOwnProperty.call(s, k)) s[k] = saved[k];
    } catch (e) {}
    if (s.boostIndex < 0 || s.boostIndex >= BOOST_STEPS.length) s.boostIndex = 2;
    if (!modeById(s.mode)) s.mode = "voice";
    return s;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function modeById(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
    return null;
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
      c.makeup.connect(c.analyser);
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
      if (!playing) return;
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
    if (v) attach(v);
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
    if (!state.enabled) return "&#128264; Enhancement OFF";
    var pct = Math.round(BOOST_STEPS[state.boostIndex] * 100);
    return "&#128266; " + modeById(state.mode).name + " &middot; " + pct + "%" +
      '<br><small style="opacity:.7;font-size:20px">GREEN/RED boost &middot; YELLOW mode &middot; BLUE on/off</small>';
  }

  // ---------- remote keys ----------
  var blueDownAt = 0;
  function onKeyDown(e) {
    var code = e.keyCode;
    if (code !== KEY.RED && code !== KEY.GREEN && code !== KEY.YELLOW && code !== KEY.BLUE) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.repeat && code !== KEY.BLUE) return;

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

    resume();
    if (!state.unsupported) scan();
    if (code === KEY.GREEN) {
      state.enabled = true;
      state.boostIndex = Math.min(BOOST_STEPS.length - 1, state.boostIndex + 1);
    } else if (code === KEY.RED) {
      state.enabled = true;
      state.boostIndex = Math.max(0, state.boostIndex - 1);
    } else if (code === KEY.YELLOW) {
      state.enabled = true;
      var idx = 0;
      for (var i = 0; i < MODES.length; i++) if (MODES[i].id === state.mode) idx = i;
      state.mode = MODES[(idx + 1) % MODES.length].id;
    }
    save();
    applySettings();
    toast(statusText());
  }
  function onKeyUp(e) {
    if (e.keyCode !== KEY.BLUE) return;
    e.preventDefault();
    e.stopPropagation();
    var held = blueDownAt ? Date.now() - blueDownAt : 0;
    blueDownAt = 0;
    if (held < 1500 && !state.unsupported) {
      state.enabled = !state.enabled;
      save();
      scan();
      applySettings();
    }
    toast(statusText());
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
    state: function () { return state; },
    chain: function () { return chain; },
    context: function () { return ctx; }
  };
})();
