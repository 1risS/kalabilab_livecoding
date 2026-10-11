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
- **Gists:** publica los programas actuales como un Gist privado de GitHub. Solicita un token clásico de GitHub con permiso `gist` y no lo guarda.
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

## Puente Strudel → Hydra

- `a.fft`: 32 bandas FFT normalizadas, actualizadas en cada cuadro de animación.
- `a.vol`: energía media normalizada, de 0 a 1.
- `strudel.last`: último evento disparado por Strudel (`value`, `time`, `cps` y `duration` opcional).
- `strudel.events`: los 32 eventos más recientes.
- `strudel.cps`: ciclos por segundo del último evento.
- `strudel.onEvent(listener)`: se suscribe a eventos; devuelve una función para cancelar la suscripción.
- También están disponibles las variables globales habituales de Hydra: `osc`, `shape`, `noise`, `src`, `solid`, `render`, `a`, `a0`–`a31` y `o0`–`o3`.

El puente usa las APIs `initStrudel`, `evaluate`, `getAudioContext`, `getSuperdoughAudioController` y `onTrigger` de Strudel. El análisis toma la señal de salida de Strudel y no solicita permiso de micrófono.
