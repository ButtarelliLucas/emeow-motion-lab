# e-Meow Motion Lab

Micrositio interactivo de e-Meow pensado para subdominio propio en Hostinger. La experiencia es mobile first, corre enteramente en cliente y mezcla `MediaPipe Hand Landmarker` con `Three.js` para deformar un campo de particulas sobre la imagen de camara.

## Stack

- Vite + React 19 + TypeScript
- Tailwind CSS v4
- Three.js
- `@mediapipe/tasks-vision`
- Vitest

## Flujo de la experiencia

- Intro con branding, permiso de camara e instruccion de entrada.
- Modo live con video espejado full-screen y particulas renderizadas encima.
- Hand tracking con estados `intro`, `requestingCamera`, `calibrating`, `live`, `handMissing`, `denied`, `unsupported` y `fallback`.
- HUD minimo con ayuda, recalibracion y CTA de vuelta a `e-meow.com.ar`.
- Fallback visual guiado cuando la camara no puede usarse.

## Controles gestuales

- `Pinch`: atrae y comprime particulas.
- `Palma abierta`: expande el campo alrededor de la mano.
- `Sweep`: mover la mano rapido empuja corrientes y deja estelas.
- `Campo dual`: con dos manos activas aparece una orbita mas intensa entre ambas.

## Desarrollo local

```bash
npm install
npm run dev
```

Abre `http://localhost:5173`.

## Scripts

```bash
npm run dev
npm run build
npm run preview
npm run lint
npm run test
npm run typecheck
```

## Assets locales

- `public/models/hand_landmarker.task`: modelo local para no depender de fetch externo al deploy.
- `public/mediapipe/wasm/*`: runtime WASM local del paquete.
- `public/brand/emeow-logo-white.png`: logo actual de e-Meow.
- `public/brand/emeow-m-mark.svg`: monograma temporal inspirado en la marca para esta experiencia.

## Deploy en Hostinger

La app genera salida estatica en `dist`, ideal para subdominio dedicado.

### Build

```bash
npm run build
```

### Subida

Opcion 1:

- Publicar el repo en GitHub.
- Generar `dist`.
- Subir el contenido de `dist` al website o subdominio estatico de Hostinger.

Opcion 2:

- Mantener el repo en GitHub.
- Empaquetar `dist` como zip y usar el deploy estatico correspondiente.

### Requisitos de produccion

- HTTPS obligatorio para `getUserMedia`.
- Navegadores objetivo: Safari iOS reciente, Chrome Android reciente, Chrome/Edge/Safari desktop recientes.
- Si el dispositivo es debil, la calidad baja automaticamente antes de romper la experiencia.

## Checklist post deploy

- Abrir el subdominio por HTTPS.
- Verificar que la intro pide camara solo al tocar el boton.
- Confirmar que el video queda espejado y full-screen.
- Confirmar que no aparecen landmarks clasicos.
- Probar `pinch`, `palma abierta`, `sweep` y `campo dual`.
- Probar fallback guiado al bloquear permisos.

## GitHub

El nombre tecnico del repo queda como `emeow-motion-lab` hasta definir el naming comercial final despues de revisar la animacion.
