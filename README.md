# KA LABI

Brutalist, client-only live coding: Strudel audio on the left, Hydra visuals on the right. The Strudel output is tapped by a Web Audio `AnalyserNode` and copied into Hydra's `a` object every animation frame.
 
 The editor interaction is intentionally informed by [Flok](https://github.com/munshkr/flok): persistent live-coding buffers, immediate keyboard evaluation, visible runtime status, inline errors, and a canvas output layered behind the code. Flok is archived upstream, so this project keeps the useful browser-editor pattern while using current CodeMirror 6, Strudel, and Hydra packages locally.
npm run dev
```

- **Share** stores both programs in the URL hash and copies the URL.
- Programs autosave to `localStorage`.

## Hydra bridge globals

- `a.fft`: 32 normalized FFT bins, updated each animation frame.
- `a.vol`: average FFT energy, normalized from 0 to 1.
- `strudel.last`: latest Strudel trigger event (`value`, `time`, `cps`, and optional `duration`).
- `strudel.events`: the latest 32 trigger events.
- `strudel.cps`: cycles per second from the latest event.
- `strudel.onEvent(listener)`: subscribe to trigger events; returns an unsubscribe function.
- All normal Hydra globals are available, including `osc`, `shape`, `noise`, `src`, `solid`, `render`, `a`, `a0`–`a31`, and `o0`–`o3`.

The bridge uses Strudel's exported `initStrudel`, `evaluate`, `getAudioContext`, `getSuperdoughAudioController`, and pattern `onTrigger` APIs. The analyser taps the controller's output gain, which already feeds the destination. Hydra microphone detection is disabled, so no microphone permission is requested.
# kalabilab_livecoding
