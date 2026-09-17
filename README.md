# 🔭 Visión Remota

Sistema de vigilancia P2P con vídeo y audio WebRTC. Un dispositivo actúa como **emisor** y otro como **supervisor**.

## 🔧 Uso

### Como Emisor (Cámara)

1. Abre la aplicación y pulsa **Activar como Emisor**.
2. La cámara aparece primero y, justo debajo, se muestra el **código de acceso**.
3. Pulsa **Iniciar transmisión** y acepta los permisos de cámara y micrófono.
4. Comparte el código de seis caracteres y mantén la página abierta.

El código mostrado coincide siempre con el identificador activo. Si se solicita un código nuevo, la aplicación también lo vuelve a registrar en PeerJS. Para evitar errores al dictarlo no se usan los caracteres ambiguos `0/O` y `1/I`.

### Como Supervisor (Visor)

1. Abre la aplicación en otro dispositivo y pulsa **Conectar como Supervisor**.
2. Introduce el código del emisor y pulsa **Conectar**.
3. Visualiza la transmisión y usa los controles de comunicación.

Los códigos se normalizan automáticamente: se aceptan mayúsculas, minúsculas, espacios y separadores. El supervisor puede conectarse **antes o después** de que el emisor inicie la cámara. Si llega antes, queda esperando y la llamada se atiende automáticamente cuando comienza la transmisión.

## 🎯 Detección de movimiento

La detección se ejecuta **únicamente en el modo Supervisor**. El modo Emisor no muestra controles, no crea un detector y no analiza fotogramas de la cámara local.

El supervisor analiza localmente el vídeo recibido con un lienzo pequeño de 160×120 px y pocos análisis por segundo. Es un proceso de sólo lectura: nunca modifica el vídeo, el micrófono, el `MediaStream` ni la conexión WebRTC. Si el análisis falla, se detiene sin cortar la transmisión.

### Cómo usarla

1. En el panel del supervisor, activa **Detección de Movimiento**.
2. Ajusta la sensibilidad, el ritmo de análisis, el silencio entre alarmas y el volumen.
3. Selecciona un sonido de la biblioteca y los tipos de aviso deseados.
4. Pulsa **Probar alarma** para comprobar la configuración.

El medidor indica cuánto cambia la imagen y dónde se encuentra el umbral. Se exigen varios fotogramas consecutivos por encima del umbral y se aplica un tiempo de enfriamiento para evitar avisos en ráfaga.

### Sonidos incluidos

El selector contiene todos los MP3 de la carpeta [`/audio`](audio/):

- Silbido alegre (`-joy-whistle.mp3`)
- Campanilla de puerta (`door_bell_campanello-porta.mp3`)
- Timbre de puerta (`doorbell-sound-effect-.mp3`)
- Timbre electrónico (`electronic-doorbell-sound.mp3`)
- Timbre clásico (`old-style-door-bell.mp3`)
- Notificación (`soundreality-notification-10-158196.mp3`)
- Silbido de aviso (`whistle-project-5-.mp3`)
- Silbido de lobo (`wolf-whistle.mp3`)

El sonido puede repetirse hasta pulsar **Detener alarma**, con un límite de seguridad de 30 segundos.

### Otros tipos de aviso

| Aviso | Acción |
| --- | --- |
| 🔔 **Timbre breve** | Reproduce tres pitidos cortos |
| 🗣️ **Voz** | Pronuncia “Movimiento detectado” |
| 📳 **Vibración** | Vibra en dispositivos compatibles |
| ⚡ **Alerta visual** | Muestra un banner y un destello en pantalla |
| 📧 **Notificación** | Usa las notificaciones del sistema con permiso |
| 📡 **Avisar al emisor** | Envía el evento por el canal de datos |
| ↩️ **Reaccionar a avisos remotos** | Procesa avisos recibidos sin reenviarlos |

El registro de eventos conserva la hora, el nivel y una captura local. Las preferencias del supervisor se guardan en el navegador.

## ⚙️ Solución de problemas

### No se puede conectar

1. Comprueba que el emisor muestre **Código activo y listo para conectar**.
2. Verifica los seis caracteres; no importa si se escriben en mayúsculas o minúsculas.
3. Puedes abrir primero cualquiera de los dos dispositivos. Si el supervisor espera, inicia la transmisión en el emisor.
4. Comprueba que ambos dispositivos tienen conexión a Internet.
5. Si se generó un código nuevo, utiliza el último que aparece en pantalla.

### No se inicia la cámara o el micrófono

1. Acepta los permisos del navegador.
2. Cierra otras aplicaciones que estén usando la cámara o el micrófono.
3. La aplicación reintenta con restricciones más compatibles y, si sólo falla el micrófono, mantiene la cámara activa sin audio.
4. Prueba con Chrome, Firefox, Edge o Safari actualizado.

### Calidad de vídeo baja

1. Usa Wi-Fi estable o una buena conexión 4G/5G.
2. Selecciona calidad **Media (720p)** o **Baja (480p)**.
3. Cierra otras aplicaciones que consuman ancho de banda.

## 📱 Compatibilidad y diseño adaptable

La interfaz se adapta a móvil y escritorio. Los vídeos usan reproducción integrada (`playsinline`), los botones y formularios se apilan en pantallas estrechas y los controles mantienen áreas táctiles amplias.

- Chrome 60+
- Firefox 55+
- Edge 79+
- Safari 11+ (iOS/macOS)
- Opera 47+

## 🔒 Privacidad y seguridad

- La conexión multimedia es P2P mediante WebRTC.
- Los códigos son temporales y sólo existen mientras el emisor está activo.
- La cámara y el micrófono requieren permiso explícito.
- La aplicación no graba ni sube las transmisiones.
- El análisis y las capturas de movimiento permanecen en el supervisor.

## 🧪 Pruebas

```bash
npm ci
npm test
```

La suite incluye 28 pruebas del motor, los sonidos, la interfaz y la integración. Entre otras cosas verifica que:

- no existe detección de movimiento en el emisor;
- el supervisor puede elegir y reproducir los ocho MP3;
- la transmisión del emisor no analiza fotogramas;
- un supervisor que conecta antes de iniciar la cámara queda en espera;
- el código visible es el mismo que se registra y se normaliza sin distinguir mayúsculas;
- los avisos remotos no crean bucles.

---

✨ **Desarrollado con WebRTC** — conecta dispositivos de forma directa y segura.
