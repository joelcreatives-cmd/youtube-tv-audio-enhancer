# YouTube TV Audio Enhancer

A [TizenBrew](https://github.com/reisxd/TizenBrew) module that adds volume boost and sound modes to
YouTube on Samsung (Tizen) TVs. It runs YouTube's own TV app (youtube.com/tv) and only changes the
audio: your account, subscriptions and the normal YouTube player all stay the same. No ad-blocking or
other changes.

## Remote controls

Uses the colour keys. On Samsung smart remotes without colour buttons, press the **123** button
(or long-press **Play/Pause** on some remotes) to bring up the on-screen colour keys.

| Key | Action |
| --- | --- |
| GREEN | Boost up (100 → 125 → 150 → 200 → 250 → 300 → 400%) |
| RED | Boost down |
| YELLOW | Next sound mode |
| BLUE | Enhancement on/off |
| BLUE (hold 3 s) | Try again after "not supported" |

Sound modes: **Boost only**, **Clear voice** (default), **Bass boost**, **Movie**, **Music**,
**Night (even volume)**. Settings are remembered on the TV.

## Set up on the TV

### 1. Developer Mode
1. Open **Apps** on the TV.
2. Type `1 2 3 4 5` (use the **123** button for the on-screen number pad if your remote has no numbers).
3. Turn **Developer mode** **On**, set **Host PC IP** to `127.0.0.1`, press **OK**.
4. Restart the TV fully: hold the power button until the Samsung logo shows.

### 2. Install TizenBrew
1. On your Mac (same Wi-Fi as the TV), download **TizenBrew Installer** from
   https://github.com/reisxd/TizenBrewInstaller/releases/latest and open it.
2. Click **Install TizenBrew**. On Tizen 7+ TVs it asks you to sign in to a Samsung account and create a certificate.
3. **TizenBrew** appears in the TV's Apps.

### 3. Add this module
1. Open **TizenBrew** on the TV and go to its module manager (add module).
2. Enter: `gh/joelcreatives-cmd/youtube-tv-audio-enhancer`
   (TizenBrew loads modules from GitHub through jsDelivr, so the repo must be public on GitHub.)
3. Launch **YouTube Audio Enhancer** from TizenBrew. A message at the top shows the current mode and boost.

## If there's no sound
Some TVs decode video in hardware and don't pass its audio to the browser's audio engine. The module
watches for this: if a video plays for 8 seconds with no audio getting through, it shows
"not supported on this TV", switches itself off and reloads, so YouTube plays normally. Hold **BLUE**
for 3 seconds to try again.

## How it works
`userScript.js` is injected into YouTube's TV page by TizenBrew. It sends the `<video>` element's
audio through Web Audio: boost gain → low shelf (120 Hz) → mud cut (350 Hz) → presence (2.8 kHz) →
air (9 kHz) → compressor/limiter → make-up gain → output.

## Status
Tested in desktop Chrome with a test page (remote keys, settings saved, silence fallback).
Working on a Samsung QA50QEF1 (2025) with TizenBrew 2.0.5.

Keep Developer Mode on with Host PC IP `127.0.0.1`: TizenBrew needs it every time it runs.
If TizenBrew shows "Launch Service failed: Unknown error.", restart the TV again (see
reisxd/TizenBrew#234 and #244).
