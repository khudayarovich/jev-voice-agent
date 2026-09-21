# Jev Voice Agent

Voice control for macOS, routed by **Jev** — TypeSafe AI's System One model.

Say *"Hey Jeff"*, speak a command, and it runs. Feedback is short indicator
tones and a menu-bar indicator; there is no talking assistant.

## How it works

```
mic → VAD endpoint → local STT → wake phrase in the transcript?
    → local pre-parser (candidate generation)
    → ONE Jev systemOne call  → confidence gate → typed executor
    → conversation stays open: keep talking, no wake word needed
```

The wake phrase is matched **in the transcript**, not by a keyword spotter. A
spotter was tried first and measured: the same phrase at ordinary speaking
volume was missed at every threshold, while whisper — already running, and
returning in ~65 ms — recognises it dependably. The spotter is still there as an
optional fast path that lights the overlay early when it does fire, but nothing
depends on it. While the wake word is off, no ambient speech is transcribed at
all.

Say "Hey Jeff" once and the conversation stays open: keep giving commands until
you say "that's it", "thanks", or "that's all", or until it goes quiet. The
menu-bar icon shows sound waves the whole time it is still listening.

Everything from the microphone to the transcript runs **on this machine**. Only
the routing decision — a short transcript plus a small structured context
object — is sent to Jev.

### Why Jev, and what it changes

Jev is not a text-generating LLM. It evaluates a `state` and returns *typed
decisions with calibrated probabilities*: a `choice`, a `score`, or a `noul`
(yes/no). It cannot write an AppleScript or invent an app name.

So the usual "LLM writes code" design is inverted:

> The model never emits code or free text. It selects an index into a static,
> hand-written action registry. Numbers and text payloads are parsed
> deterministically in code, never generated.

That is both why it is fast (70–500 ms, ~0.003¢ per command) and why it is safe.

## Status

- [x] **Phase 1** — skeleton, tray, settings, permissions, earcons
- [x] **Phase 2** — audio capture → transcript (~65 ms on an M4 Pro)
- [x] **Phase 3** — wake word, VAD endpointing, auto-gain
- [x] **Phase 4** — Jev routing, typed executor, confirmations
- [ ] **Phase 5** — wider registry, native helper for hold-to-talk
- [ ] **Phase 6** — Apple SpeechAnalyzer engine, notarization

**To use it:** open Settings → Connection and paste your TypeSafe API key, then
turn on Listening. Without a key it falls back to the local matcher, which
handles the common commands but is much blunter.

## Measured on an M4 Pro

| Stage | Time |
|---|---|
| Transcription (3 s command, base.en + Metal) | ~65 ms |
| Jev routing | p50 410 ms, p95 1.2 s |
| Cost | ~$0.08 per 1000 commands |

### Routing accuracy

`npm run calibrate` replays 50 labelled commands through the real API:

```
accuracy          100.0%  (50/50)
local matcher      96.0%  (the offline fallback, for comparison)
confidence  hit   mean 0.980   p10 0.970
latency           mean 489ms   p50 410ms   p95 1222ms
tokens            1901 per command
```

Confidence is well separated: before the criteria were tightened, the two wrong
answers sat at 0.53 while every correct one was above 0.97 — so the default
0.55 gate refused exactly the wrong answers and nothing else. That is why the
threshold is set where it is, and re-running this is how to move it.

The focused app measurably helps. "copy that" is ambiguous on its own
(confidence 0.50 in Finder), rises to 0.63 in a code editor, and in Messages the
*addressed* score falls to 0.29 — the model correctly suspects you may be
talking to a person, and the agent stays quiet.

## Speech recognition

Runs on this Mac via whisper.cpp, selectable in Settings. Measured here over
spoken commands naming real installed applications — the case that actually
fails, since nearly every recognition error is a proper noun:

| model | no prompt | with vocabulary prompt | latency |
|---|---|---|---|
| base.en | 38.9% WER | 13.9% | 54 ms |
| **small.en** (default) | 22.2% WER | **5.6%** | 145 ms |
| large-v3-turbo | 22.2% WER | 23.6% | 604 ms |

Two results worth keeping in mind. **The vocabulary prompt matters more than the
model** — it more than halved the error rate for every English model. And
**bigger is not better**: `large-v3-turbo` is multilingual while the `.en` models
are English-specialised, so on English application names the small English model
beats it outright at a quarter of the latency. It stays available because
multilingual training is what helps with a strong accent.

The prompt is built from *your* apps, ranked by how recently you launched each
one (via Spotlight), because whisper's prompt only fits about sixty names and
cutting the list alphabetically would drop Safari, Slack and Terminal while
keeping every utility beginning with "A".

## Things it handles that are easy to get wrong

- **Described, not named.** "open the browser" resolves to your actual browser.
  Jev reads criteria literally, so the slot question says outright that a
  description counts — without that it answered "the user named none of these"
  and refused the command at full confidence.
- **Chained requests.** "open Firefox and open YouTube" runs both. Splitting is
  refused when the conjunction belongs to a payload, so "type hello and goodbye"
  stays one command.
- **Sites vs apps.** "open YouTube" is a website; there is no YouTube.app to
  find. Well-known sites route to the browser instead.

## Commands

70 at the moment: 60 built in, plus every Shortcut you have written — those are
discovered at runtime and become voice-callable with no code change. See
Settings → Commands.

## Development

```bash
npm install
npm run assets      # generate tray icons + earcon tones
npm start           # build and launch
npm test            # hermetic tests
```

Development runs inside Electron's own bundle (`com.github.Electron`), whose
signature is stable between rebuilds — so macOS permission grants stick. A
Developer ID is needed before distributing; see Settings → Permissions.
