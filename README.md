# Código creativo: creación de imagen y sonido en tiempo real con Hydra y Strudel

Por **irisS** para **Kalabi Lab**.

Aplicación de código creativo en el navegador para componer sonido con Strudel y visuales con Hydra en tiempo real. La visual de Hydra funciona como fondo de toda la interfaz y responde al análisis de frecuencia del audio.

La interacción del editor está inspirada en [Flok](https://github.com/munshkr/flok): buffers persistentes, evaluación inmediata mediante teclado, estados de ejecución y errores visibles en cada editor. El proyecto usa CodeMirror 6, Strudel y Hydra instalados localmente.

## Requisitos

- Node.js 18 o superior.
- Un navegador moderno con WebGL y Web Audio API.

## Instalación y desarrollo

```bash
npm install
npm run dev
```

Para generar la versión de producción:

```bash
npm run build
```

## Uso

1. Abrí la aplicación y hacé clic en la pantalla inicial para habilitar audio y video.
2. Escribí patrones de Strudel en el panel izquierdo y código de Hydra en el derecho.
3. En escritorio ejecutá ambos programas con `⌘ + Enter` en macOS o `Ctrl + Enter` en otros sistemas.
4. En móvil usá el botón **Ejecutar**.

La botonera permite:

- **Subir samples:** carga archivos de audio locales. Se registran con un identificador basado en el nombre del archivo y pueden usarse con `s("nombre-del-sample")`.
- **Subir imagen:** carga una imagen en la fuente Hydra `s0`.
- **Subir video:** carga un video en `s0`, en bucle y sin audio.
- **Copiar código:** copia los programas actuales de Strudel y Hydra al portapapeles, identificados como `strudel.js` y `hydra.js`, para pegarlos manualmente en un Gist de GitHub u otro editor.
- **Ocultar editores:** deja visible la visual de Hydra como fondo.
- **Pantalla completa:** activa el modo de pantalla completa del navegador.

## Ejemplo

Strudel:

```js
s("808bd 808sd")
  .sometimesBy(0.2, rev)
```

Hydra reactivo al audio:

```js
osc(20, 0.1, () => 0.3 + a.fft[0] * 3)
  .kaleid(4)
  .out()
```

Después de subir una imagen o video, se puede utilizar `s0`:

```js
osc(20, 0.1)
  .modulate(src(s0))
  .kaleid(4)
  .out()
```

### Control de video

Al subir un video, `s0` se reproduce en bucle. Estas funciones controlan el video cargado sin interferir con las funciones propias de Hydra:

```js
videoLoop(0.2, 0.75) // reproduce repetidamente del 20 % al 75 % del video
videoSpeed(0.5)      // media velocidad, con frame blending automático
videoSpeed(-1)       // reproducción inversa
videoSpeed(-2)       // reproducción inversa al doble de velocidad
videoSpeed(0)        // pausa
videoSpeed([-1, 1])  // alterna entre reversa y avance cada segundo
videoSpeed(() => [-1, 1]) // lo mismo, calculado en tiempo de ejecución
videoChop(4, 2)      // alterna 4 segmentos del video, 2 veces por segundo
videoChop(() => [4, 16], 2) // alterna dinámicamente entre 4 y 16 segmentos
videoChop([4, 16], () => [1, 8]) // segmentos y velocidad variables
chop(4, 2)           // alias encadenable de videoChop() para fuentes de video
videoChop(0)         // desactiva el corte temporal
```

Los límites de `videoLoop(inicio, final)` se expresan de `0` a `1`. Las funciones se aplican al último video subido en `s0`.

Cuando un video avanza a una velocidad positiva menor que `1`, Kalabi mezcla temporalmente el fotograma actual con el anterior. Esto suaviza los fotogramas repetidos que producen los decodificadores a velocidades lentas. El efecto se reinicia al hacer `chop()`, cambiar el bucle o reproducir en reversa, para no dejar rastros entre cortes.
También pueden encadenarse en una fuente Hydra:

```js
src(s0)
  .videoLoop(0.2, 0.75)
  .videoSpeed(-1)
  .chop(8, 4)
  .out()
```

## Puente Strudel → Hydra

- `a.fft`: 32 bandas FFT normalizadas, actualizadas en cada cuadro de animación.
- `a.vol`: energía media normalizada, de 0 a 1.
- `a.orbit(n)`: análisis de un bus/orbit de Strudel. Devuelve su propia energía (`vol`) y bandas (`fft`) después de sus efectos. El análisis se actualiza 20 veces por segundo. El orbit por defecto de Strudel es `1`.
- `a.orbits`: los orbits que ya se usaron, indexados por número.
- `strudel.last`: último evento disparado por Strudel (`value`, `time`, `cps` y `duration` opcional).
- `strudel.events`: los 32 eventos más recientes.
- `strudel.cps`: ciclos por segundo del último evento.
- `strudel.onEvent(listener)`: se suscribe a eventos; devuelve una función para cancelar la suscripción.
- También están disponibles las variables globales habituales de Hydra: `osc`, `shape`, `noise`, `src`, `solid`, `render`, `a`, `a0`–`a31` y `o0`–`o3`.

El puente usa las APIs `initStrudel`, `evaluate`, `getAudioContext`, `getSuperdoughAudioController` y `onTrigger` de Strudel. El análisis toma la señal de salida de Strudel y no solicita permiso de micrófono.

### Reactividad por orbit

Asigná cada patrón a un orbit de Strudel y leé ese canal en Hydra. Así un bombo puede afectar una escala y los hats otro parámetro, sin reaccionar a la mezcla completa:

```js
// Strudel
stack(
  s("bd*4").orbit(0),
  s("hh*8").orbit(1),
  note("<c2 eb2 g2 bb2>").s("sawtooth").orbit(2)
)
```

```js
// Hydra
const kick = a.orbit(0)
const hats = a.orbit(1)
const synth = a.orbit(2)

osc(8, 0.05, () => 0.15 + hats.fft[3] * 2)
  .rotate(() => kick.vol * 0.25)
  .scale(() => 0.9 + synth.vol * 0.2)
  .out()
```

Llamá a `a.orbit(n)` después de ejecutar un patrón que use `.orbit(n)`. Si el patrón se evalúa de nuevo, las referencias `kick`, `hats` y `synth` continúan actualizándose.
