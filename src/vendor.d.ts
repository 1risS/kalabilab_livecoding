declare module 'hydra-synth' {
  export default class Hydra {
    synth: { a: { fft: number[]; vol: number; setBins: (n: number) => void; setSmooth: (n: number) => void; setScale: (n: number) => void; setCutoff: (n: number) => void }; o?: Array<unknown>; render: (output?: unknown) => void; tick: (dt: number) => void }
    constructor(options: Record<string, unknown>)
    eval(code: string): void
    o: Array<unknown>
  }
}

declare module '@strudel/web' {
  export function evaluate(code: string): Promise<any>
  export function getAudioContext(): AudioContext
  export function getSuperdoughAudioController(): { output?: { destinationGain?: AudioNode } }
  export function hush(): void
  export function initStrudel(options?: Record<string, unknown>): Promise<unknown>
  export function samples(source: string | Record<string, string>): Promise<void>
}
