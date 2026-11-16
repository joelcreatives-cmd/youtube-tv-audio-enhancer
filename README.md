# YouTube TV Audio Enhancer

A [TizenBrew](https://github.com/reisxd/TizenBrew) module that adds volume boost, sound modes,
playback speed, minute jumps and a sleep timer to YouTube on Samsung (Tizen) TVs. It runs YouTube's own
TV app (youtube.com/tv) and only adds these controls: your account, subscriptions and the normal YouTube
player all stay the same. No ad-blocking or other changes.

## Remote controls

Everything works without opening the menu. Colour keys are the **A B C D** buttons on Samsung
remotes that have them (A red, B green, C yellow, D blue); on smart remotes without them, press the
**123** button to bring up on-screen colour keys.

| Button | Action |
| --- | --- |
| **B** (green) | Boost up (100 → 125 → 150 → 200 → 250 → 300 → 400%) |
| **A** (red) | Boost down |
| **C** (yellow) | Next sound mode |
| **D** (blue) | Open / close the **Enhancer menu** |
| **CH ▲ / CH ▼** | Playback speed faster / slower (0.75× to 2×) |
| **1 – 9** | Jump forward that many minutes |
| **0**, then **1 – 9** | Jump back that many minutes (0 waits 3 s for the number) |
| **GUIDE** | Sleep timer: Off → 15 → 30 → 45 → 60 → 90 → 120 min → End of video → Off |
| **PRE-CH** | Enhancement on / off (compare with the original sound) |
| **D** (hold 3 s) | Try again after "not supported" |

Number keys only jump while a video is open, so typing numbers elsewhere in YouTube isn't affected.

### Enhancer menu (D)
UP/DOWN choose a setting, LEFT/RIGHT change it. **OK** puts the playback speed back to Normal.
**RETURN/BACK** (or D again) closes the menu. All the buttons above also work while it's open. It closes by itself after 20 s.

| Setting | Choices |
| --- | --- |
| Volume boost | 100–400% |
| Sound mode | the six modes below |
| Enhancement | On / Off (compare with the original sound) |
| Playback speed | 0.75×, Normal, 1.25×, 1.5×, 1.75×, 2× — kept for every video until you change it |
| Sleep timer | Off, 15, 30, 45, 60, 90, 120 min, or End of this video |

**Sleep timer:** a minute before the end a message warns you. Then the sound fades out over 10 seconds,
the video pauses and the screen goes dark. Press any button during the fade to cancel, or any button
afterwards to wake the screen. The timer resets each time you open the module. (Apps can't switch the
TV itself off, so set the TV's own sleep timer too if you want it to turn off.)

**Speed:** if you change speed in YouTube's own menu instead, the module keeps that speed.

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

## Releasing an update
jsDelivr caches files for up to 12 hours and doesn't reliably clear the script's cache. So each release
copies `userScript.js` to a new file, `dist/userScript-<version>.js`, and points `main` in `package.json`
at it. A file name jsDelivr has never seen can't be stale. Restart the TV afterwards so TizenBrew
reloads the module.

## How it works
`userScript.js` is injected into YouTube's TV page by TizenBrew. It sends the `<video>` element's
audio through Web Audio: boost gain → low shelf (120 Hz) → mud cut (350 Hz) → presence (2.8 kHz) →
air (9 kHz) → compressor/limiter → make-up gain → output.

## Status
Tested in desktop Chrome with a test page (remote keys, settings saved, silence fallback).
Working on a Samsung QA50QEF1 (2025) with TizenBrew 2.0.5 (remote BN59-01483C).

Keep Developer Mode on with Host PC IP `127.0.0.1`: TizenBrew needs it every time it runs.
If TizenBrew shows "Launch Service failed: Unknown error.", restart the TV again (see
reisxd/TizenBrew#234 and #244).
