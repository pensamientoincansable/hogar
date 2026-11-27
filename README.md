# 🔭 Visión Remota

Sistema de vigilancia con vídeo y audio WebRTC. Un dispositivo actúa como **emisor** y uno o varios como **supervisor**, en la misma red o **desde cualquier otra red** gracias al relé TURN.

## 🌍 Supervisar desde otra red

WebRTC intenta primero una conexión **directa** entre los dispositivos. Eso basta en la misma Wi-Fi o con un router doméstico sencillo, pero falla cuando alguno de los dos equipos está detrás de un **NAT estricto, CGNAT (móvil 4G/5G) o un cortafuegos**: no existe una ruta directa posible y la llamada se queda "conectando" aunque el código sea correcto.

La solución es un servidor **TURN**, que reenvía el vídeo cuando el P2P no es viable. La aplicación ya incluye:

- **STUN** público para la ruta directa (la opción más rápida y con menos latencia).
- **TURN público** (Open Relay de Metered, puertos 80 y 443) con una cuota compartida, suficiente para pruebas y supervisión ocasional.
- La posibilidad de **añadir tu propio servidor TURN** (coturn, Cloudflare Calls, Metered…) desde el botón **Conexión a distancia** de la cabecera.

### Configurar tu propio relé (recomendado para uso continuo)

1. Pulsa **Conexión a distancia** en la cabecera.
2. Escribe la URL de tu TURN, por ejemplo `turn:tu-servidor.com:3478` (o `turns:tu-servidor.com:443`).
3. Indica usuario y contraseña (los que hayas definido en el servidor).
4. Pulsa **Guardar**. La configuración se guarda en ese navegador.

Con tu propio TURN no dependes de cuotas compartidas y el vídeo llega a cualquier red. Si guardas mientras hay una transmisión activa, la nueva configuración se aplica en la siguiente conexión para no cortar la actual.

El panel del supervisor muestra en **Estado de Conexión → Ruta** si el vídeo va **directo** o **por relé**, lo que ayuda a diagnosticar problemas de red.

### Varios supervisores

El emisor atiende **varias conexiones a la vez**: varios supervisores pueden ver la misma cámara, y el cambio de cámara o el audio bidireccional se aplican a todos.

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

### Se oye audio pero no se ve la imagen

1. Comprueba que la imagen se ve en el propio emisor y que la cámara no está tapada o bloqueada por el sistema.
2. Actualiza la página en ambos dispositivos, inicia la transmisión y vuelve a conectar. Si el navegador bloquea la reproducción, toca la pantalla.
3. Revisa los permisos de cámara del sitio en el navegador y en el sistema operativo. Si se denegaron anteriormente, habilítalos en ajustes y recarga.
4. Prueba ambos dispositivos con navegadores actualizados y otra red. Algunas redes bloquean WebRTC: si el supervisor está en otra red, comprueba en **Conexión a distancia** que hay un relé TURN activo (y que la cuota pública no está agotada). Revisa también el valor de **Ruta** en Estado de Conexión.

### Calidad de vídeo baja

1. Usa Wi-Fi estable o una buena conexión 4G/5G.
2. Selecciona calidad **Media (720p)** o **Baja (480p)**.
3. Cierra otras aplicaciones que consuman ancho de banda.

## 📱 Compatibilidad y diseño adaptable

La interfaz se adapta a móvil y escritorio. Los vídeos usan reproducción integrada (`playsinline`), los botones y formularios se apilan en pantallas estrechas y los controles mantienen áreas táctiles amplias.

Se recomiendan versiones actuales de Chrome, Firefox, Edge, Opera y Safari en escritorio y móviles; no se garantiza el funcionamiento de todas las versiones o dispositivos. Internet Explorer y navegadores antiguos o integrados en otras aplicaciones pueden ser incompatibles. En iOS/iPadOS, Safari admite WebRTC desde iOS 11; la captura en otros navegadores basados en WKWebView requiere iOS 14.3 o posterior y depende de la aplicación. La reproducción automática con sonido puede requerir tocar la pantalla.

La cámara y el micrófono exigen **HTTPS o localhost** y autorización del usuario tanto en el navegador como, cuando corresponda, en el sistema operativo. Una dirección HTTP de red local no es localhost. El navegador puede recordar una autorización y no volver a preguntar; la web no puede saltarse el permiso. El supervisor también puede solicitar micrófono para comunicación bidireccional. PeerJS se carga desde un CDN y necesita acceso a su servidor de señalización y a Internet.

## 🔒 Privacidad y seguridad

- La conexión multimedia es WebRTC: directa (P2P) cuando la red lo permite y cifrada de extremo a extremo también al pasar por el relé TURN (el relé reenvía paquetes cifrados sin poder ver el vídeo).
- Los códigos son temporales y sólo existen mientras el emisor está activo.
- La cámara y el micrófono requieren permiso explícito.
- La aplicación no graba ni sube las transmisiones.
- El análisis y las capturas de movimiento permanecen en el supervisor.
- Los servidores de conexión (STUN/TURN) sólo se guardan en el navegador del usuario; no se envían a ningún servidor propio.

## 🧪 Pruebas

```bash
npm ci
npm test
```

La suite prueba el motor, los sonidos, la interfaz y la integración con dobles; no sustituye una prueba WebRTC entre navegadores reales. Entre otras cosas verifica que:

- no existe detección de movimiento en el emisor;
- el supervisor puede elegir y reproducir los ocho MP3;
- la transmisión del emisor no analiza fotogramas;
- un supervisor que conecta antes de iniciar la cámara queda en espera;
- el código visible es el mismo que se registra y se normaliza sin distinguir mayúsculas;
- los avisos remotos no crean bucles;
- la configuración ICE que recibe PeerJS siempre incluye un relé TURN, también al crear conexiones nuevas;
- un TURN propio se valida, se guarda y sustituye al público;
- el emisor atiende a varios supervisores y el cambio de cámara llega a todos;
- el diagnóstico distingue la ruta directa de la que pasa por el relé.

---

✨ **Desarrollado con WebRTC** — conexión directa cuando es posible y por relé cuando hace falta.
