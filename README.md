# Jev Voice Agent

Voice control for macOS, routed by **Jev** — TypeSafe AI's System One model.

Say *"Hey Jeff"*, speak a command, and it runs. Feedback is short indicator
tones and a menu-bar indicator; there is no talking assistant.

## How it works

```
mic → wake word → VAD endpoint → local STT
    → local pre-parser (candidate generation)
    → ONE Jev systemOne call  → confidence gate → typed executor
```

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
