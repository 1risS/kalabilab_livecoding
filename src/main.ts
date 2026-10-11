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
type Pane = 'strudel' | 'hydra'
type StrudelEvent = { value: Record<string, unknown>; time: number; cps: number; duration?: number }

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
<div class="start-screen" id="start-screen"><div><img src="/logo-kalabi.webp" alt="Símbolo Kalabi Lab"><strong>HAZ CLIC PARA INICIAR AUDIO + VIDEO</strong><small>EL NAVEGADOR REQUIERE UNA ACCIÓN DEL USUARIO</small></div></div>
<canvas id="hydra-canvas" aria-label="Visual de Hydra"></canvas>
<header class="topbar"><div class="brand"><img src="/logo-kalabi.webp" alt="Kalabi Lab"><div><b>kalabi lab</b><em>FORMACIÓN EN ARTE, TECNOLOGÍA Y MATERIA</em></div></div><nav class="toolbar"><button id="run-all" class="accent run-all">EJECUTAR</button><button id="upload-samples">SUBIR SAMPLES</button><button id="upload-image">SUBIR IMAGEN</button><button id="upload-video">SUBIR VIDEO</button><button id="gist">GISTS</button><button id="toggle-editors">OCULTAR EDITORES</button><button id="fullscreen">PANTALLA COMPLETA</button></nav></header>
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
let strudelReady = false
let latestEvent: StrudelEvent | null = null
const events: StrudelEvent[] = []
const listeners = new Set<(event: StrudelEvent) => void>()

function makeEditor(parent: string, value: string, onEvaluate: () => void) {
  const liveCodingKeys = keymap.of([
    { key: 'Mod-Enter', run: () => { onEvaluate(); return true } },
    { key: 'Ctrl-Enter', run: () => { onEvaluate(); return true } },
    { key: 'Mod-.', run: () => { hush(); return true } },
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
  const audio = {
    fft: Array(32).fill(0),
    vol: 0,
    scale: 1,
    cutoff: 0,
    smooth: 0.75,
    setBins(numBins: number) { this.fft = Array(numBins).fill(0) },
    setSmooth(value: number) { this.smooth = value },
    setScale(value: number) { this.scale = value },
    setCutoff(value: number) { this.cutoff = value },
  }
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
    node.connect(context.destination)
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
  installBridge()
  hydraInitialized = true
  runHydra(hydraView)
}
function updateAudioBridge() {
  if (analyser && hydraInitialized) {
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(data)
    const audio = (hydra as unknown as { synth: { a: { fft: number[]; vol: number } } }).synth.a
    audio.fft = audio.fft.map((_, index) => (data[Math.floor(index * data.length / audio.fft.length)] ?? 0) / 255)
    audio.vol = audio.fft.reduce((sum, value) => sum + value, 0) / audio.fft.length
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
      video.loop = true
      video.muted = true
      video.playsInline = true
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true })
        video.addEventListener('error', () => reject(new Error(`No se pudo cargar el video “${file.name}”`)), { once: true })
        video.src = url
      })
      await video.play()
      source.init({ src: video, dynamic: true })
    }
    document.querySelector('#visual-status')!.textContent = `${kind.toUpperCase()} EN s0`
  } catch (error) { showError('hydra', error) }
}
async function createGist() {
  const token = window.prompt('Pegá un token clásico de GitHub con permiso “gist”. No se guardará.')
  if (!token) return
  try {
    const response = await fetch('https://api.github.com/gists', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Kalabi live coding session', public: false, files: { 'strudel.js': { content: strudelView.state.doc.toString() }, 'hydra.js': { content: hydraView.state.doc.toString() } } }) })
    if (!response.ok) throw new Error(`GitHub respondió ${response.status}: ${await response.text()}`)
    const gist = await response.json() as { html_url: string }
    window.open(gist.html_url, '_blank', 'noopener')
  } catch (error) { console.error('[Gists]', error); window.alert(`No se pudo crear el Gist: ${error instanceof Error ? error.message : String(error)}`) }
}
document.querySelector('#run-all')!.addEventListener('click', () => runAll())
document.querySelector('#upload-samples')!.addEventListener('click', () => document.querySelector<HTMLInputElement>('#samples-input')!.click())
document.querySelector('#upload-image')!.addEventListener('click', () => document.querySelector<HTMLInputElement>('#image-input')!.click())
document.querySelector('#upload-video')!.addEventListener('click', () => document.querySelector<HTMLInputElement>('#video-input')!.click())
document.querySelector('#samples-input')!.addEventListener('change', (event) => uploadSamples((event.currentTarget as HTMLInputElement).files))
document.querySelector('#image-input')!.addEventListener('change', (event) => uploadVisual((event.currentTarget as HTMLInputElement).files?.[0], 'imagen'))
document.querySelector('#video-input')!.addEventListener('change', (event) => uploadVisual((event.currentTarget as HTMLInputElement).files?.[0], 'video'))
document.querySelector('#gist')!.addEventListener('click', () => createGist())
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
