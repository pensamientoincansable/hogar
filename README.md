## 🔧 Uso

### Como Emisor (Cámara):
1. Abre la aplicación en tu dispositivo
2. Haz clic en "Activar como Emisor"
3. Comparte el código que aparece
4. Haz clic en "Iniciar Transmisión"
5. Mantén la página abierta

### Como Supervisor (Visor):
1. Abre la aplicación en otro dispositivo
2. Haz clic en "Conectar como Supervisor"
3. Introduce el código del emisor
4. Haz clic en "Conectar"
5. Usa los controles para comunicarte

## 🎯 Detección de Movimiento

La aplicación analiza **localmente** los fotogramas del vídeo (tanto en el emisor como en
el supervisor) y dispara **alarmas configurables** al detectar movimiento.

El análisis es de **sólo lectura**: nunca modifica la cámara, el micrófono, el MediaStream
ni la conexión WebRTC. Usa un lienzo diminuto (160×120 px) y pocos análisis por segundo,
por lo que no afecta a la calidad ni a la estabilidad de la transmisión. Si algo falla,
la detección se detiene sola y la transmisión continúa con normalidad.

### Cómo usarla

1. Abre el panel del emisor o del supervisor y activa el interruptor **Detección de Movimiento**
2. Ajusta **sensibilidad**, **velocidad de análisis** (1-10 por segundo), **silencio entre
   alarmas** (5-120 s) y **volumen**
3. Marca los **tipos de alarma** que quieras usar
4. Pulsa **Probar alarma** para escuchar cómo suena antes de dejarla activa

El medidor muestra cuánto cambia la imagen en tiempo real y dónde está el umbral de disparo;
cuando lo supera durante varios fotogramas seguidos, se dispara la alarma (con enfriamiento
para no repetirla en ráfaga).

### Tipos de alarma

| Alarma | Qué hace |
| --- | --- |
| 🚨 **Sirena** | Barrido sonoro continuo generado con WebAudio (no necesita archivos) |
| 🔔 **Timbre** | Tres pitidos cortos |
| 🗣️ **Voz** | Mensaje hablado: "Movimiento detectado" |
| 📳 **Vibración** | Vibra el dispositivo (móviles) |
| ⚡ **Alerta visual** | Banner rojo y parpadeo a pantalla completa + distintivo sobre el vídeo |
| 📧 **Notificación** | Notificación del sistema (pide permiso la primera vez) |
| 📡 **Avisar al otro dispositivo** | Envía el aviso por el canal de datos (emisor ↔ supervisor) |
| ↩️ **Reaccionar a avisos remotos** | Dispara tus alarmas cuando avisa el otro dispositivo |

### Otras opciones

- **Sirena continua**: mantiene la sirena hasta pulsar "Detener alarma" (máximo 30 s)
- **Registro de eventos**: guarda hora, nivel de movimiento y captura de cada evento;
  pulsa la miniatura para descargar la evidencia
- **Analizar con la pestaña oculta**: sigue analizando en segundo plano (consume más batería;
  el navegador puede ralentizarlo)
- **Sin bucles**: un aviso remoto nunca se reenvía, así que dos dispositivos avisándose
  no se alarman mutuamente en cadena

Cada dispositivo guarda sus propias preferencias (activación, sensibilidad, alarmas…) de
forma independiente, por lo que emisor y supervisor pueden tener configuraciones distintas.

## ⚙️ Solución de Problemas

### Error "No se pudo conectar":
1. **Verifica el código**: Asegúrate de que el código sea correcto
2. **Reinicia la transmisión**: Pide al emisor que genere un nuevo código
3. **Verifica conexión**: Ambos dispositivos deben tener internet
4. **Recarga la página**: A veces soluciona problemas temporales

### Error de cámara/micrófono:
1. **Acepta los permisos**: El navegador debe pedir acceso
2. **Verifica otros programas**: Cierra otras apps que usen la cámara
3. **Prueba en otro navegador**: Chrome suele tener mejor soporte

### Calidad de video baja:
1. **Mejora la conexión**: Conéctate a WiFi o usa datos 4G/5G
2. **Reduce la calidad**: En el emisor, selecciona calidad "Media"
3. **Cierra otras apps**: Libera ancho de banda

## 📱 Compatibilidad

- ✅ Chrome 60+ (recomendado)
- ✅ Firefox 55+
- ✅ Edge 79+
- ✅ Safari 11+ (iOS/macOS)
- ✅ Opera 47+

**Móviles compatibles**: Android 8+, iOS 11+

## 🔒 Privacidad y Seguridad

- **Conexión P2P**: Los datos no pasan por servidores intermedios
- **Códigos temporales**: Cada código es único y temporal
- **Permisos necesarios**: Solo se accede a cámara/micrófono con tu permiso
- **Sin grabación**: No se almacenan las transmisiones
- **Análisis local**: La detección de movimiento se ejecuta en tu dispositivo; las capturas
  de evidencia viven sólo en la memoria de la pestaña (no se suben a ningún servidor)

## 🆘 Soporte

Si encuentras problemas:
1. **Recarga la página**
2. **Genera un nuevo código** (emisor)
3. **Verifica permisos** del navegador
4. **Prueba en modo incógnito** (sin extensiones)

## 🧪 Pruebas

```bash
npm install   # sólo para desarrollo (jsdom)
npm test
```

La suite incluye 26 pruebas: el motor de detección (diferencia de fotogramas, sensibilidad,
enfriamiento, fallos de lectura) y pruebas de integración que cargan la aplicación completa
en jsdom y verifican que

- la transmisión (getUserMedia → `<video>` → pistas) sigue intacta al activar la detección,
- el emisor detecta movimiento, guarda evidencia, alarma y avisa al supervisor,
- el supervisor analiza el vídeo recibido sin tocar el elemento `<video>`,
- los avisos remotos no se reenvían (sin bucles entre dispositivos).

## 🚀 Mejoras Futuras

Posibles mejoras a implementar:
- [ ] Grabación local de transmisiones
- [ ] Chat de texto integrado
- [ ] Modo noche (infrarrojo simulado)
- [x] Detección de movimiento (con alarmas configurables y aviso entre dispositivos)
- [ ] Notificaciones push

---

✨ **Desarrollado con WebRTC** - Conecta dispositivos de forma directa y segura.
