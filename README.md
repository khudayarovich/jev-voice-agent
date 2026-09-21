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
- [ ] **Phase 2** — audio capture → transcript
- [ ] **Phase 3** — wake word
- [ ] **Phase 4** — Jev routing + executor
- [ ] **Phase 5** — full registry, native helper
- [ ] **Phase 6** — Apple SpeechAnalyzer engine, notarization

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
