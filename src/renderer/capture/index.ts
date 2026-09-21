/**
 * Microphone capture host.
 *
 * Capture lives in a renderer rather than a spawned helper on purpose: macOS
 * attributes the TCC prompt to the signed app bundle that asks, and helper
 * binaries spawned by Electron do not reliably get their own prompts.
 *
 * Phase 2 fills this in: getUserMedia with all of Chromium's processing
 * disabled, an AudioWorklet that resamples once to 16 kHz mono int16, and a
 * ring buffer holding 1.5 s of pre-roll so the start of a command is never
 * clipped.
 */
export {};
