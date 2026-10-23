import './style.css'
import { basicSetup } from 'codemirror'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import Hydra from 'hydra-synth'
import { evaluate, getAudioContext, getSuperdoughAudioController, hush, initStrudel, samples } from '@strudel/web'

const STRUDEL_DEMO = `s("808bd 808sd")\n  .sometimesBy(0.2, rev)`
const HYDRA_DEMO = `osc(20, 0.1, () => 0.3 + a.fft[0] * 3)\n  .kaleid(4)\n  .out()`
const assetBase = import.meta.env.BASE_URL
type Pane = 'strudel' | 'hydra'
type StrudelEvent = { value: Record<string, unknown>; time: number; cps: number; duration?: number }
type AudioAnalysis = {
  fft: number[]
  vol: number
  scale: number
  cutoff: number
  smooth: number
  setBins: (numBins: number) => void
  setSmooth: (value: number) => void
  setScale: (value: number) => void
  setCutoff: (value: number) => void
}
type OrbitAnalysis = AudioAnalysis & { orbit: number }
type OrbitTap = { analyser: AnalyserNode; sink: GainNode; analysis: OrbitAnalysis }

let uploadedVideo: HTMLVideoElement | undefined
let videoLoopStart = 0
let videoLoopEnd = 1
let videoPlaybackSpeed = 1
let videoSpeedControl: unknown = 1
let videoChopSlices = 0
let videoChopRate = 1
let videoChopSlicesControl: unknown = 0
let videoChopRateControl: unknown = 1
let activeVideoChop = -1
let reverseVideoFrame: number | undefined
let previousVideoFrame = 0
let videoSeekPending = false
const videoFrameCanvas = document.createElement('canvas')
const previousVideoFrameCanvas = document.createElement('canvas')
let hasPreviousVideoFrame = false
function strudelOutputGain() {
  return (getSuperdoughAudioController() as any).output?.destinationGain as GainNode | undefined
}
function restoreStrudelOutput() {
  const output = strudelOutputGain()
  if (!output) return
  const now = output.context.currentTime
  output.gain.cancelScheduledValues(now)
  output.gain.setValueAtTime(1, now)
}
function stopStrudel() {
  hush()
  // `hush()` stops future scheduler events, but a long AudioBufferSourceNode
  // already triggered by a sample is allowed to finish. Mute the master bus as
  // a short panic fade so Cmd+. has SuperCollider-like immediate behaviour.
  const output = strudelOutputGain()
  if (!output) return
  const now = output.context.currentTime
  output.gain.cancelScheduledValues(now)
  output.gain.setTargetAtTime(0, now, 0.005)
  document.querySelector('#audio-status')!.textContent = 'SILENCIADO'
}
function clampUnit(value: number) { return Math.max(0, Math.min(1, value)) }
function resetVideoFrameBlend() {
  hasPreviousVideoFrame = false
  videoFrameCanvas.getContext('2d')?.clearRect(0, 0, videoFrameCanvas.width, videoFrameCanvas.height)
  previousVideoFrameCanvas.getContext('2d')?.clearRect(0, 0, previousVideoFrameCanvas.width, previousVideoFrameCanvas.height)
}
function updateVideoFrameBlend() {
  const video = uploadedVideo
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height) return
  if (videoFrameCanvas.width !== width || videoFrameCanvas.height !== height) {
    videoFrameCanvas.width = previousVideoFrameCanvas.width = width
    videoFrameCanvas.height = previousVideoFrameCanvas.height = height
    hasPreviousVideoFrame = false
  }
  const output = videoFrameCanvas.getContext('2d')
  const previous = previousVideoFrameCanvas.getContext('2d')
  if (!output || !previous) return
  output.globalAlpha = 1
  output.clearRect(0, 0, width, height)
  // Native video decoders repeat source frames at slow speeds. Blend the last
  // rendered frame with the current decoded frame so forward playback below 1x
  // has a continuous temporal trail rather than a sequence of hard holds.
  const shouldBlend = videoPlaybackSpeed > 0 && videoPlaybackSpeed < 1
  if (shouldBlend && hasPreviousVideoFrame) {
    output.globalAlpha = 1 - videoPlaybackSpeed
    output.drawImage(previousVideoFrameCanvas, 0, 0, width, height)
    output.globalAlpha = videoPlaybackSpeed
  }
  output.drawImage(video, 0, 0, width, height)
  output.globalAlpha = 1
  previous.clearRect(0, 0, width, height)
  previous.drawImage(videoFrameCanvas, 0, 0, width, height)
  hasPreviousVideoFrame = shouldBlend
}
function stopReverseVideo() {
  if (reverseVideoFrame !== undefined) cancelAnimationFrame(reverseVideoFrame)
  reverseVideoFrame = undefined
}
function videoBounds(video: HTMLVideoElement) {
  const duration = video.duration
  if (!Number.isFinite(duration) || duration <= 0) return null
  return { start: duration * videoLoopStart, end: duration * videoLoopEnd }
}
function seekVideo(video: HTMLVideoElement, time: number) {
  if (videoSeekPending || Math.abs(video.currentTime - time) < 0.012) return false
  videoSeekPending = true
  resetVideoFrameBlend()
  if (typeof video.fastSeek === 'function') video.fastSeek(time)
  else video.currentTime = time
  // Some browser/video combinations omit `seeked` for a seek to a nearby keyframe.
  window.setTimeout(() => { videoSeekPending = false }, 250)
  return true
}
function keepVideoWithinLoop() {
  const video = uploadedVideo
  const bounds = video && videoBounds(video)
  if (!video || !bounds) return
  const sliceLength = videoChopSlices > 0 ? (bounds.end - bounds.start) / videoChopSlices : 0
  const chopStart = videoChopSlices > 0 ? bounds.start + activeVideoChop * sliceLength : bounds.start
  const chopEnd = videoChopSlices > 0 ? chopStart + sliceLength : bounds.end
  if (videoPlaybackSpeed >= 0 && video.currentTime >= chopEnd - 0.008) seekVideo(video, chopStart)
  if (videoPlaybackSpeed < 0 && video.currentTime <= chopStart + 0.008) seekVideo(video, chopEnd)
}
function playVideoInReverse(now: number) {
  const video = uploadedVideo
  const bounds = video && videoBounds(video)
  if (!video || !bounds || videoPlaybackSpeed >= 0) return
  const elapsed = previousVideoFrame ? (now - previousVideoFrame) / 1000 : 0
  previousVideoFrame = now
  const nextTime = video.currentTime - elapsed * Math.abs(videoPlaybackSpeed)
  seekVideo(video, nextTime <= bounds.start ? bounds.end : nextTime)
  reverseVideoFrame = requestAnimationFrame(playVideoInReverse)
}
function setVideoLoop(start = 0, end = 1) {
  if (!uploadedVideo) throw new Error('Primero subí un video para usar videoLoop().')
  const normalizedStart = clampUnit(start)
  const normalizedEnd = clampUnit(end)
  if (normalizedStart >= normalizedEnd) throw new Error('videoLoop(inicio, final) requiere que inicio sea menor que final.')
  videoLoopStart = normalizedStart
  videoLoopEnd = normalizedEnd
  const bounds = videoBounds(uploadedVideo)
  if (bounds) seekVideo(uploadedVideo, videoPlaybackSpeed < 0 ? bounds.end : bounds.start)
}
function resolveVideoSpeed(control: unknown) {
  let value = typeof control === 'function' ? control() : control
  // Hydra-style arrays cycle once per second. This allows `[-1, 1]` and
  // functions returning arrays to drive forward/reverse motion.
  if (Array.isArray(value)) value = value[Math.floor(performance.now() / 1000) % value.length]
  if (value && typeof value === 'object' && 'value' in value) value = (value as { value: unknown }).value
  const speed = Number(value)
  if (!Number.isFinite(speed)) throw new Error('videoSpeed() requiere un número, un arreglo de números o una función que los devuelva.')
  return speed
}
function applyVideoSpeed(speed: number) {
  // Browsers reject very small positive `playbackRate` values (Chrome's lower
  // bound is commonly 0.0625). Audio-reactive expressions often cross that
  // range while changing direction, so reserve 0 for an explicit pause and
  // clamp every nonzero speed to a safe magnitude.
  const minimumSpeed = 0.1
  const maximumSpeed = 4
  if (speed !== 0 && Math.abs(speed) < minimumSpeed) speed = Math.sign(speed || 1) * minimumSpeed
  speed = Math.max(-maximumSpeed, Math.min(maximumSpeed, speed))
  if (!uploadedVideo || speed === videoPlaybackSpeed) return
  if (!uploadedVideo) throw new Error('Primero subí un video para usar videoSpeed().')
  videoPlaybackSpeed = speed
  stopReverseVideo()
  if (speed === 0) {
    uploadedVideo.pause()
    return
  }
  if (speed > 0) {
    uploadedVideo.playbackRate = speed
    void uploadedVideo.play()
    return
  }
  uploadedVideo.pause()
  previousVideoFrame = 0
  reverseVideoFrame = requestAnimationFrame(playVideoInReverse)
}
function setVideoSpeed(control: unknown = 1) {
  if (!uploadedVideo) throw new Error('Primero subí un video para usar videoSpeed().')
  videoSpeedControl = control
  applyVideoSpeed(resolveVideoSpeed(control))
}
function resolveVideoChopValue(control: unknown, label: 'segmentos' | 'velocidad') {
  let value = typeof control === 'function' ? control() : control
  if (Array.isArray(value)) value = value[Math.floor(performance.now() / 1000) % value.length]
  if (value && typeof value === 'object' && 'value' in value) value = (value as { value: unknown }).value
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`videoChop(${label}) requiere un número, un arreglo de números o una función que los devuelva.`)
  return number
}
function setVideoChop(slices: unknown = 4, rate: unknown = 2) {
  if (!uploadedVideo) throw new Error('Primero subí un video para usar videoChop().')
  videoChopSlicesControl = slices
  videoChopRateControl = rate
  updateVideoChop()
}
function updateVideoChop() {
  const slices = Math.floor(resolveVideoChopValue(videoChopSlicesControl, 'segmentos'))
  const rate = resolveVideoChopValue(videoChopRateControl, 'velocidad')
  if (slices < 0) throw new Error('videoChop(segmentos) requiere una cantidad mayor o igual a 0.')
  if (rate <= 0) throw new Error('videoChop(velocidad) requiere una velocidad mayor que 0.')
  if (slices !== videoChopSlices) activeVideoChop = -1
  videoChopSlices = slices
  videoChopRate = rate
  if (!uploadedVideo || videoChopSlices === 0) return
  const bounds = videoBounds(uploadedVideo)
  if (!bounds) return
  const slice = Math.floor(performance.now() / 1000 * videoChopRate) % videoChopSlices
  if (slice === activeVideoChop) return
  activeVideoChop = slice
  const sliceLength = (bounds.end - bounds.start) / videoChopSlices
  seekVideo(uploadedVideo, videoPlaybackSpeed < 0
    ? bounds.start + (slice + 1) * sliceLength
    : bounds.start + slice * sliceLength)
}
function installVideoControls() {
  const source = (globalThis as Record<string, any>).src?.((globalThis as Record<string, any>).s0)
  const prototype = source && Object.getPrototypeOf(source)
  if (!prototype || prototype.__kalabiVideoControls) return
  prototype.videoLoop = function (start = 0, end = 1) { setVideoLoop(start, end); return this }
  prototype.videoSpeed = function (speed = 1) { setVideoSpeed(speed); return this }
  prototype.videoChop = function (slices = 4, rate = 2) { setVideoChop(slices, rate); return this }
  prototype.chop = function (slices = 4, rate = 2) { setVideoChop(slices, rate); return this }
  prototype.__kalabiVideoControls = true
}
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
<div class="start-screen" id="start-screen"><div><img src="${assetBase}logo-kalabi.webp" alt="Símbolo Kalabi Lab"><strong>HAZ CLIC PARA INICIAR AUDIO + VIDEO</strong><small>EL NAVEGADOR REQUIERE UNA ACCIÓN DEL USUARIO</small></div></div>
<canvas id="hydra-canvas" aria-label="Visual de Hydra"></canvas>
<header class="topbar"><div class="brand"><img src="${assetBase}logo-kalabi.webp" alt="Kalabi Lab"><div><b>kalabi lab</b><em>FORMACIÓN EN ARTE, TECNOLOGÍA Y MATERIA</em></div></div><nav class="toolbar"><button id="run-all" class="accent run-all">EJECUTAR</button><button id="upload-samples">SUBIR SAMPLES</button><button id="upload-image">SUBIR IMAGEN</button><button id="upload-video">SUBIR VIDEO</button><button id="record">GRABAR MP4</button><button id="copy-code">COPIAR CÓDIGO</button><button id="toggle-editors">OCULTAR EDITORES</button><button id="fullscreen">PANTALLA COMPLETA</button></nav></header>
<input id="samples-input" type="file" accept="audio/*" multiple hidden><input id="image-input" type="file" accept="image/*" hidden><input id="video-input" type="file" accept="video/*" hidden>
<main id="workbench"><section class="pane" id="strudel-pane"><div class="pane-head"><b>01 / STRUDEL</b><span id="audio-status">LISTO</span></div><div class="editor" id="strudel-editor"></div><pre class="errors" id="strudel-errors"></pre></section><div class="divider" id="divider" role="separator" aria-label="Cambiar el tamaño de los editores"></div><section class="pane hydra-pane" id="hydra-pane"><div class="pane-head"><b>02 / HYDRA</b><span id="visual-status">LISTO</span></div><div class="editor" id="hydra-editor"></div><pre class="errors" id="hydra-errors"></pre></section></main>`

function sharedCode(key: 's' | 'h') {
  if (!location.hash) return null
  try { return JSON.parse(decodeURIComponent(atob(location.hash.slice(1))))[key] as string } catch { return null }
}
const saved = (key: string, fallback: string, shareKey: 's' | 'h') => sharedCode(shareKey) ?? localStorage.getItem(key) ?? fallback
let hydra: Hydra
let hydraInitialized = false
let analyser: AnalyserNode | undefined
let analyserSink: GainNode | undefined
let orbitAnalysisTime = 0
let strudelReady = false
let recorder: MediaRecorder | undefined
let recordingStream: MediaStream | undefined
let latestEvent: StrudelEvent | null = null
const events: StrudelEvent[] = []
const listeners = new Set<(event: StrudelEvent) => void>()
const orbitTaps = new Map<number, OrbitTap>()
const orbitAnalyses = new Map<number, OrbitAnalysis>()

function createAudioAnalysis(): AudioAnalysis {
  return {
    fft: Array(32).fill(0),
    vol: 0,
    scale: 1,
    cutoff: 0,
    smooth: 0.75,
    setBins(numBins: number) { this.fft = Array(Math.max(1, Math.floor(numBins))).fill(0) },
    setSmooth(value: number) { this.smooth = clampUnit(value) },
    setScale(value: number) { this.scale = Math.max(0, value) },
    setCutoff(value: number) { this.cutoff = Math.max(0, value) },
  }
}
function updateAnalysis(analysis: AudioAnalysis, node: AnalyserNode) {
  const spectrum = new Uint8Array(node.frequencyBinCount)
  const waveform = new Float32Array(node.fftSize)
  node.getByteFrequencyData(spectrum)
  node.getFloatTimeDomainData(waveform)
  analysis.fft = analysis.fft.map((previous, index) => {
    const raw = (spectrum[Math.floor(index * spectrum.length / analysis.fft.length)] ?? 0) / 255
    const scaled = Math.max(0, raw * analysis.scale - analysis.cutoff)
    return previous * analysis.smooth + scaled * (1 - analysis.smooth)
  })
  const rms = Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length)
  const level = Math.min(1, rms * analysis.scale)
  analysis.vol = analysis.vol * analysis.smooth + level * (1 - analysis.smooth)
}
function ensureOrbitTap(orbit: number): OrbitAnalysis {
  const existing = orbitTaps.get(orbit)
  if (existing) return existing.analysis
  let analysis = orbitAnalyses.get(orbit)
  if (!analysis) {
    analysis = Object.assign(createAudioAnalysis(), { orbit })
    orbitAnalyses.set(orbit, analysis)
  }
  const controller = getSuperdoughAudioController() as any
  const output = controller.nodes?.[orbit]?.output as AudioNode | undefined
  if (!output) return analysis
  const context = getAudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  // Keep the analyser in an active audio path without adding a second audible
  // copy of the orbit. The orbit remains routed normally by SuperDough.
  const sink = context.createGain()
  sink.gain.value = 0
  output.connect(analyser)
  analyser.connect(sink)
  sink.connect(context.destination)
  orbitTaps.set(orbit, { analyser, sink, analysis })
  return analysis
}

function makeEditor(parent: string, value: string, onEvaluate: () => void) {
  const liveCodingKeys = keymap.of([
    { key: 'Mod-Enter', run: () => { onEvaluate(); return true } },
    { key: 'Ctrl-Enter', run: () => { onEvaluate(); return true } },
    { key: 'Mod-.', run: () => { stopStrudel(); return true } },
  ])
  return new EditorView({ state: EditorState.create({ doc: value, extensions: [basicSetup, javascript(), Prec.highest(liveCodingKeys), keymap.of([...defaultKeymap, indentWithTab]), EditorView.updateListener.of((update) => { if (update.docChanged) localStorage.setItem(`kalabi-${parent}`, update.state.doc.toString()) })] }), parent: document.querySelector(`#${parent}-editor`)! })
}
function showError(pane: Pane, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[${pane === 'hydra' ? 'Hydra' : 'Strudel'}]`, error)
  document.querySelector<HTMLElement>(`#${pane}-errors`)!.textContent = `[${pane.toUpperCase()}] ${message}`
}
function clearError(pane: Pane) { document.querySelector<HTMLElement>(`#${pane}-errors`)!.textContent = '' }
function emit(event: StrudelEvent) { latestEvent = event; events.push(event); if (events.length > 32) events.shift(); listeners.forEach((listener) => listener(event)) }

async function evaluateStrudel(view: EditorView) {
  try {
    clearError('strudel'); await initAudioBridge(); await getAudioContext().resume()
    restoreStrudelOutput()
    initializeHydra()
    const result = await evaluate(view.state.doc.toString())
    // Strudel patterns expose onTrigger; this forwards each scheduled hit to Hydra.
    if (result && typeof (result as { onTrigger?: Function }).onTrigger === 'function') (result as { onTrigger: Function }).onTrigger((hap: StrudelEvent, time: number, cps: number) => emit({ ...hap, time, cps }))
    // `evaluate()` is Strudel's REPL pathway: it schedules the returned
    // pattern itself. Calling `play()` a second time starts a separate player
    // from the beginning, which made each evaluation sound like a restart.
    document.querySelector('#audio-status')!.textContent = 'REPRODUCIENDO'
  } catch (error) { showError('strudel', error); document.querySelector('#audio-status')!.textContent = 'ERROR' }
}
function installBridge() {
  // Hydra normally creates `a` only when microphone detection is enabled. We
  // disable that permission prompt and provide the same public shape ourselves.
  const audio = Object.assign(createAudioAnalysis(), {
    // Strudel's `orbit(n)` is a real SuperDough bus. Its analyser is attached
    // after that orbit's post-effects, so it represents that pattern/channel
    // rather than the master mix. It is updated at 20 Hz.
    orbit(number = 1) {
      const orbit = Math.floor(Number(number))
      if (!Number.isFinite(orbit) || orbit < 0) throw new Error('a.orbit(n) requiere un número entero mayor o igual a 0.')
      return ensureOrbitTap(orbit)
    },
    get orbits() {
      return Object.fromEntries([...orbitAnalyses])
    },
  })
  const synth = (hydra as unknown as { synth: Record<string, unknown> }).synth
  synth.a = audio
  ;(globalThis as Record<string, unknown>).a = audio
  audio.fft.forEach((_, index) => { (globalThis as Record<string, unknown>)[`a${index}`] = (scale = 1, offset = 0) => () => audio.fft[index] * scale + offset })
  ;(globalThis as Record<string, unknown>).strudel = { get last() { return latestEvent }, events, get cps() { return latestEvent?.cps ?? 0 }, onEvent: (listener: (event: StrudelEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
}
async function initAudioBridge() {
  if (!strudelReady) {
    await initStrudel({ prebake: async () => { await samples('github:tidalcycles/dirt-samples') } })
    const context = getAudioContext(); const node = context.createAnalyser(); node.fftSize = 256; analyser = node
    // Tap Strudel's destination gain without replacing its own speaker route.
    // Replacing that route can leave newly evaluated patterns silent.
    const output = (getSuperdoughAudioController() as any).output?.destinationGain
    if (!output) throw new Error('Strudel audio output is unavailable')
    output.connect(node)
    // Keep this analysis branch alive but silent. Connecting it directly to
    // `destination` creates a second, differently-routed copy of the mix and
    // can collapse/duplicate the stereo signal in headphones.
    analyserSink = context.createGain()
    analyserSink.gain.value = 0
    node.connect(analyserSink)
    analyserSink.connect(context.destination)
    strudelReady = true
  }
}
function runHydra(view: EditorView) {
  try {
    initializeHydra()
    clearError('hydra')
    // Match Hydra's browser workflow: it installs its live-coding functions on
    // `window`, then evaluates the sketch in that global scope.  Evaluating in
    // Hydra's sandbox while manually choosing an output left the last frame
    // pinned to the canvas instead of allowing a new `.out()` to take over.
    const evaluation = globalThis.eval(`(async () => {\n${view.state.doc.toString()}\n})()`)
    Promise.resolve(evaluation).catch((error) => { showError('hydra', error); document.querySelector('#visual-status')!.textContent = 'ERROR' })
    document.querySelector('#visual-status')!.textContent = 'EJECUTANDO'
  } catch (error) { showError('hydra', error); document.querySelector('#visual-status')!.textContent = 'ERROR' }
}

const initialStrudel = saved('kalabi-strudel', STRUDEL_DEMO, 's').replace('s("bd sd").bank("RolandTR909")', 's("808bd 808sd")')
const strudelView = makeEditor('strudel', initialStrudel, () => runAll())
const initialHydra = saved('kalabi-hydra', HYDRA_DEMO, 'h').replace('osc(20, 0.1, () => a.fft[0] * 3)', 'osc(20, 0.1, () => 0.3 + a.fft[0] * 3)')
const hydraView = makeEditor('hydra', initialHydra, () => runAll())
const canvas = document.querySelector<HTMLCanvasElement>('#hydra-canvas')!
canvas.width = 1280
canvas.height = 720
function initializeHydra() {
  if (hydraInitialized) return
  // Flok loads Strudel's live-coding scope before Hydra. Both libraries expose
  // names such as `shape`; initializing Hydra last gives visual functions
  // precedence in the Hydra editor instead of accidentally calling Strudel's
  // pattern transform.
  ;(globalThis as Record<string, unknown>).global = globalThis
  hydra = new Hydra({ canvas, detectAudio: false, makeGlobal: true })
  ;(globalThis as Record<string, unknown>).H = hydra
  ;(globalThis as Record<string, unknown>).videoLoop = setVideoLoop
  ;(globalThis as Record<string, unknown>).videoSpeed = setVideoSpeed
  ;(globalThis as Record<string, unknown>).videoChop = setVideoChop
  installVideoControls()
  installBridge()
  hydraInitialized = true
  runHydra(hydraView)
}
function updateAudioBridge() {
  updateVideoChop()
  keepVideoWithinLoop()
  if (uploadedVideo) {
    try { applyVideoSpeed(resolveVideoSpeed(videoSpeedControl)) } catch (error) { console.error('[Hydra]', error) }
    updateVideoFrameBlend()
  }
  if (analyser && hydraInitialized && performance.now() - orbitAnalysisTime >= 50) {
    orbitAnalysisTime = performance.now()
    const audio = (hydra as unknown as { synth: { a: AudioAnalysis } }).synth.a
    updateAnalysis(audio, analyser)
    const controller = getSuperdoughAudioController() as any
    Object.keys(controller.nodes ?? {}).forEach((number) => ensureOrbitTap(Number(number)))
    orbitTaps.forEach((tap) => updateAnalysis(tap.analysis, tap.analyser))
  }
  requestAnimationFrame(updateAudioBridge)
}
requestAnimationFrame(updateAudioBridge)

async function runAll() {
  await Promise.all([evaluateStrudel(strudelView), Promise.resolve(runHydra(hydraView))])
}
function sampleName(file: File) { return file.name.replace(/\.[^.]+$/, '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'sample' }
async function uploadSamples(files: FileList | null) {
  if (!files?.length) return
  try {
    await initAudioBridge()
    const sampleMap: Record<string, string> = {}
    for (const file of files) sampleMap[sampleName(file)] = URL.createObjectURL(file)
    await samples(sampleMap)
    document.querySelector('#audio-status')!.textContent = `${files.length} SAMPLE${files.length === 1 ? '' : 'S'} LISTO${files.length === 1 ? '' : 'S'}`
  } catch (error) { showError('strudel', error) }
}
async function uploadVisual(file: File | undefined, kind: 'imagen' | 'video') {
  if (!file) return
  try {
    initializeHydra()
    const source = (globalThis as Record<string, any>).s0
    if (!source) throw new Error('La fuente visual s0 no está disponible')
    const url = URL.createObjectURL(file)
    if (kind === 'imagen') {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error(`No se pudo cargar la imagen “${file.name}”`))
        image.src = url
      })
      source.init({ src: image, dynamic: false })
    } else {
      const video = document.createElement('video')
      video.autoplay = true
      video.loop = false
      video.muted = true
      video.playsInline = true
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true })
        video.addEventListener('error', () => reject(new Error(`No se pudo cargar el video “${file.name}”`)), { once: true })
        video.src = url
      })
      await video.play()
      stopReverseVideo()
      uploadedVideo = video
      videoLoopStart = 0
      videoLoopEnd = 1
      videoPlaybackSpeed = 1
      videoSpeedControl = 1
      videoChopSlices = 0
      videoChopSlicesControl = 0
      videoChopRateControl = 1
      activeVideoChop = -1
      videoSeekPending = false
      resetVideoFrameBlend()
      video.addEventListener('timeupdate', keepVideoWithinLoop)
      video.addEventListener('seeked', () => { videoSeekPending = false })
      video.addEventListener('ended', () => {
        const bounds = videoBounds(video)
        if (!bounds) return
        video.currentTime = bounds.start
        void video.play()
      })
      // Feed Hydra a canvas that blends adjacent decoded frames below 1x.
      // The canvas is redrawn every animation frame by `updateAudioBridge()`.
      source.init({ src: videoFrameCanvas, dynamic: true })
    }
    document.querySelector('#visual-status')!.textContent = `${kind.toUpperCase()} EN s0`
  } catch (error) { showError('hydra', error) }
}
async function copyCode() {
  const code = `// strudel.js\n\n${strudelView.state.doc.toString()}\n\n\n// hydra.js\n\n${hydraView.state.doc.toString()}\n`
  const button = document.querySelector<HTMLButtonElement>('#copy-code')!
  try {
    await navigator.clipboard.writeText(code)
    button.textContent = 'CÓDIGO COPIADO'
    window.setTimeout(() => { button.textContent = 'COPIAR CÓDIGO' }, 1800)
  } catch (error) {
    console.error('[Portapapeles]', error)
    window.alert('No se pudo acceder al portapapeles. Revisá que el sitio use HTTPS y permití el acceso al portapapeles en el navegador.')
  }
}
function supportedRecordingMimeType() {
  return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type))
}
async function toggleRecording() {
  const button = document.querySelector<HTMLButtonElement>('#record')!
  if (recorder?.state === 'recording') {
    recorder.stop()
    return
  }
  try {
    initializeHydra()
    await getAudioContext().resume()
    const videoStream = canvas.captureStream(60)
    const destination = getAudioContext().createMediaStreamDestination()
    const output = (getSuperdoughAudioController() as any).output?.destinationGain
    if (output) output.connect(destination)
    recordingStream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()])
    const mimeType = supportedRecordingMimeType()
    if (!mimeType) throw new Error('Este navegador no puede codificar una grabación de video.')
    const chunks: BlobPart[] = []
    recorder = new MediaRecorder(recordingStream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 })
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data) })
    recorder.addEventListener('stop', () => {
      const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
      const blob = new Blob(chunks, { type: mimeType })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `kalabi-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
      link.click()
      URL.revokeObjectURL(link.href)
      recordingStream?.getTracks().forEach((track) => track.stop())
      recordingStream = undefined
      recorder = undefined
      button.textContent = 'GRABAR MP4'
      button.classList.remove('recording')
    })
    recorder.start(1000)
    button.textContent = 'DETENER GRABACIÓN'
    button.classList.add('recording')
  } catch (error) {
    showError('hydra', error)
  }
}
document.querySelector('#run-all')!.addEventListener('click', () => runAll())
document.querySelector('#upload-samples')!.addEventListener('click', () => document.querySelector<HTMLInputElement>('#samples-input')!.click())
document.querySelector('#upload-image')!.addEventListener('click', () => document.querySelector<HTMLInputElement>('#image-input')!.click())
document.querySelector('#upload-video')!.addEventListener('click', () => document.querySelector<HTMLInputElement>('#video-input')!.click())
document.querySelector('#samples-input')!.addEventListener('change', (event) => uploadSamples((event.currentTarget as HTMLInputElement).files))
document.querySelector('#image-input')!.addEventListener('change', (event) => uploadVisual((event.currentTarget as HTMLInputElement).files?.[0], 'imagen'))
document.querySelector('#video-input')!.addEventListener('change', (event) => uploadVisual((event.currentTarget as HTMLInputElement).files?.[0], 'video'))
document.querySelector('#copy-code')!.addEventListener('click', () => void copyCode())
document.querySelector('#record')!.addEventListener('click', () => void toggleRecording())
document.querySelector('#toggle-editors')!.addEventListener('click', (event) => {
  document.body.classList.toggle('editors-hidden')
  ;(event.currentTarget as HTMLButtonElement).textContent = document.body.classList.contains('editors-hidden') ? 'MOSTRAR EDITORES' : 'OCULTAR EDITORES'
})
document.querySelector('#fullscreen')!.addEventListener('click', () => document.documentElement.requestFullscreen?.())
document.querySelector('#start-screen')!.addEventListener('click', async (event) => {
  const startScreen = event.currentTarget as HTMLElement
  try {
    await initAudioBridge()
    await getAudioContext().resume()
    initializeHydra()
    startScreen.remove()
  } catch (error) {
    showError('strudel', error)
  }
})
let dragging = false
document.querySelector('#divider')!.addEventListener('pointerdown', () => { dragging = true }); window.addEventListener('pointerup', () => { dragging = false }); window.addEventListener('pointermove', (event) => { if (dragging && innerWidth > 800) document.documentElement.style.setProperty('--left-width', `${Math.max(20, Math.min(80, event.clientX / innerWidth * 100))}%`) })
window.addEventListener('keydown', (event) => {
  if (innerWidth <= 800 || event.repeat) return
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void runAll()
  }
})
