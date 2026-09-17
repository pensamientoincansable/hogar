/* ============================================================================
 * motion.js — Detección de movimiento + sistema de alarmas para Visión Remota
 * ----------------------------------------------------------------------------
 * Módulo independiente y sin dependencias externas.
 *
 * FILOSOFÍA DE DISEÑO (no romper la transmisión):
 *   - Sólo LEE fotogramas del <video>. Nunca modifica `srcObject`, ni las
 *     pistas (tracks), ni la RTCPeerConnection, ni el MediaStream.
 *   - Analiza en un canvas diminuto (160x120 por defecto) a pocos fps, así el
 *     coste de CPU es despreciable frente a la codificación de vídeo.
 *   - Todos los bucles están protegidos con try/catch: si algo falla, la
 *     detección se detiene y la transmisión sigue funcionando igual.
 *
 * Contenido:
 *   MotionDetector → motor de detección (diferencia de fotogramas en escala de
 *                    grises, con compensación de cambios globales de luz).
 *   AlarmSystem    → reproduce los sonidos MP3 incluidos, timbre, voz,
 *                    vibración, alerta visual, notificación y aviso remoto.
 *   MotionPanel    → une el motor con el panel de interfaz y las preferencias.
 * ========================================================================== */
(function (root, factory) {
    const api = factory();

    if (root) {
        root.MotionDetector = api.MotionDetector;
        root.AlarmSystem = api.AlarmSystem;
        root.MotionPanel = api.MotionPanel;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ======================================================================
     * Constantes
     * ==================================================================== */

    const MOTION_DEFAULTS = {
        width: 160,                 // ancho del canvas de análisis (px)
        height: 120,                // alto del canvas de análisis (px)
        sensitivity: 6,             // 1 (muy baja) .. 10 (muy alta)
        intervalMs: 333,            // ~3 análisis por segundo
        pixelThreshold: 26,         // diferencia mínima por píxel (0-255)
        consecutiveFrames: 2,       // fotogramas seguidos con cambio para disparar
        cooldownMs: 15000,          // silencio mínimo entre alarmas
        motionHoldMs: 1500,         // tiempo que se mantiene el aviso de "hay movimiento"
        lightCompensation: 0.6,     // compensación de cambios globales de luz (0-1)
        analyzeWhenHidden: false,   // analizar con la pestaña en segundo plano
        maxConsecutiveErrors: 5,
        canvasFactory: null         // inyectable para pruebas
    };

    /** Todos los archivos reproducibles que existen en /audio. */
    const SOUND_LIBRARY = {
        'joy-whistle': {
            label: 'Silbido alegre',
            src: 'audio/-joy-whistle.mp3'
        },
        'door-bell-campanello': {
            label: 'Campanilla de puerta',
            src: 'audio/door_bell_campanello-porta.mp3'
        },
        'doorbell-effect': {
            label: 'Timbre de puerta',
            src: 'audio/doorbell-sound-effect-.mp3'
        },
        'electronic-doorbell': {
            label: 'Timbre electrónico',
            src: 'audio/electronic-doorbell-sound.mp3'
        },
        'old-door-bell': {
            label: 'Timbre clásico',
            src: 'audio/old-style-door-bell.mp3'
        },
        'notification-10': {
            label: 'Notificación',
            src: 'audio/soundreality-notification-10-158196.mp3'
        },
        'whistle-project': {
            label: 'Silbido de aviso',
            src: 'audio/whistle-project-5-.mp3'
        },
        'wolf-whistle': {
            label: 'Silbido de lobo',
            src: 'audio/wolf-whistle.mp3'
        }
    };

    const DEFAULT_SOUND = 'electronic-doorbell';

    const ALARM_TYPES = [
        'sound',        // uno de los archivos MP3 de SOUND_LIBRARY
        'beep',         // timbre corto generado con WebAudio
        'voice',        // voz sintetizada ("Movimiento detectado")
        'vibrate',      // vibración del dispositivo
        'flash',        // alerta visual a pantalla completa
        'notify',       // notificación del sistema
        'remote',       // avisar al otro dispositivo conectado
        'remote-react'  // reaccionar con alarma a los avisos remotos
    ];

    const ALARM_LABELS = {
        sound: 'Sonido seleccionado',
        beep: 'Timbre breve',
        voice: 'Voz de alerta',
        vibrate: 'Vibración',
        flash: 'Alerta visual',
        notify: 'Notificación del sistema',
        remote: 'Aviso al otro dispositivo',
        'remote-react': 'Reacción a avisos remotos'
    };

    const MOTION_STORAGE_KEY = 'visionMotionSettings';

    const PANEL_DEFAULTS = {
        viewer: {
            enabled: true,
            sound: DEFAULT_SOUND,
            alarms: {
                sound: true, beep: false, voice: false, vibrate: true,
                flash: true, notify: true, remote: true, 'remote-react': true
            }
        }
    };

    /* ======================================================================
     * Utilidades
     * ==================================================================== */

    function clamp(value, min, max) {
        return value < min ? min : (value > max ? max : value);
    }

    function hasDocument() {
        return typeof document !== 'undefined' && typeof document.createElement === 'function';
    }

    function formatTime(timestamp) {
        const date = new Date(timestamp);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /* ======================================================================
     * MotionDetector — motor de detección
     * ==================================================================== */

    class MotionDetector {
        constructor(options = {}) {
            this.options = Object.assign({}, MOTION_DEFAULTS, options);
            this._callbacks = {};
            this._running = false;
            this._video = null;
            this._timer = null;
            this._canvas = null;
            this._ctx = null;
            this._prev = null;
            this._cur = null;
            this._warmup = 0;
            this._hitFrames = 0;
            this._motionActive = false;
            this._lastHitAt = 0;
            this._nextAllowedAt = 0;
            this._status = 'idle';
            this._metrics = null;
            this._errors = 0;
            this._busy = false;
            this._frames = 0;
        }

        /* ---------- API pública ---------- */

        on(callbacks = {}) {
            this._callbacks = Object.assign(this._callbacks, callbacks);
            return this;
        }

        get isRunning() {
            return this._running;
        }

        get status() {
            return this._status;
        }

        get metrics() {
            return this._metrics;
        }

        get video() {
            return this._video;
        }

        /** Umbral (proporción de píxeles cambiados) según la sensibilidad 1-10. */
        get threshold() {
            return MotionDetector.sensitivityToThreshold(this.options.sensitivity);
        }

        /** Fotogramas analizados desde el arranque. */
        get frames() {
            return this._frames;
        }

        /**
         * Inicia el análisis sobre un elemento <video>.
         * Es idempotente: llamarlo de nuevo con el mismo vídeo no hace nada.
         * @returns {boolean} true si quedó activo
         */
        start(video) {
            if (video) this._video = video;

            if (this._running) return true;

            if (!this._video) {
                this._setStatus('waiting');
                return false;
            }

            if (!this._canAnalyze()) {
                this._setStatus('unsupported');
                this._emit('onError', new Error('El navegador no permite analizar fotogramas con canvas 2D'));
                return false;
            }

            this._running = true;
            this._errors = 0;
            this._hitFrames = 0;
            this._motionActive = false;
            this._prev = null;
            this._warmup = 2;           // descartar los primeros fotogramas (arranque de vídeo)
            this._nextAllowedAt = 0;
            this._setStatus('waiting');

            // setInterval (y no requestVideoFrameCallback) a propósito: es el
            // mecanismo más compatible y funciona aunque el vídeo esté oculto.
            this._timer = setInterval(() => this._tick(), this._safeInterval());
            return true;
        }

        /** Detiene el análisis. No toca el vídeo ni el stream. */
        stop() {
            this._running = false;
            if (this._timer !== null) {
                clearInterval(this._timer);
                this._timer = null;
            }
            this._prev = null;
            this._hitFrames = 0;
            this._busy = false;
            if (this._motionActive) {
                this._motionActive = false;
                this._emit('onMotionEnd', { timestamp: Date.now(), reason: 'stopped' });
            }
            this._setStatus('idle');
            return this;
        }

        /** Cambia opciones en caliente (sensibilidad, ritmo, cooldown...). */
        update(options = {}) {
            const previousInterval = this._safeInterval();
            Object.assign(this.options, options);

            if (this._running && this._safeInterval() !== previousInterval && this._timer !== null) {
                clearInterval(this._timer);
                this._timer = setInterval(() => this._tick(), this._safeInterval());
            }
            return this;
        }

        /** Captura un fotograma del vídeo como imagen (data URL) para evidencia. */
        snapshot(maxWidth = 160, quality = 0.6) {
            const video = this._video;
            if (!hasDocument() || !video || !video.videoWidth || !video.videoHeight) return null;

            try {
                const scale = Math.min(1, maxWidth / video.videoWidth);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                return canvas.toDataURL('image/jpeg', quality);
            } catch (error) {
                // Un canvas "tainted" o un vídeo sin fotogramas no debe romper nada.
                return null;
            }
        }

        destroy() {
            this.stop();
            this._callbacks = {};
            this._video = null;
            this._canvas = null;
            this._ctx = null;
            this._prev = null;
            this._cur = null;
            this._metrics = null;
            return this;
        }

        /* ---------- Cálculo puro (testeable sin navegador) ---------- */

        /** Convierte RGBA en un array de luminancias (0-255). */
        static toGray(rgba, out) {
            const pixels = rgba.length / 4;
            const gray = out && out.length === pixels ? out : new Uint8Array(pixels);

            for (let i = 0, p = 0; i < pixels; i++, p += 4) {
                // Aproximación entera de 0.299R + 0.587G + 0.114B
                gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
            }
            return gray;
        }

        /**
         * Compara dos fotogramas en escala de grises.
         * Descuenta los cambios globales de luminancia (encender una luz,
         * ajuste automático de exposición) para evitar falsos positivos.
         * @returns {{ratio:number, changed:number, energy:number, meanDelta:number}}
         */
        static analyzeFrames(prev, curr, options = {}) {
            const pixelThreshold = options.pixelThreshold === undefined
                ? MOTION_DEFAULTS.pixelThreshold
                : options.pixelThreshold;
            const lightCompensation = options.lightCompensation === undefined
                ? MOTION_DEFAULTS.lightCompensation
                : options.lightCompensation;

            const total = curr.length;
            if (!prev || total === 0 || prev.length !== curr.length) {
                return { ratio: 0, changed: 0, energy: 0, meanDelta: 0 };
            }

            let sumDelta = 0;
            for (let i = 0; i < total; i++) {
                sumDelta += curr[i] - prev[i];
            }
            const meanDelta = sumDelta / total;
            const adjust = meanDelta * clamp(lightCompensation, 0, 1);

            let changed = 0;
            let energy = 0;

            for (let i = 0; i < total; i++) {
                let diff = curr[i] - adjust - prev[i];

                if (diff < 0) {
                    diff = -diff > 255 ? 255 : -diff;
                } else if (diff > 255) {
                    diff = 255;
                }

                if (diff > pixelThreshold) changed++;
                energy += diff;
            }

            return {
                ratio: changed / total,
                changed,
                energy: energy / total,
                meanDelta
            };
        }

        /** Sensibilidad 1-10 → proporción de imagen que debe cambiar (umbral). */
        static sensitivityToThreshold(sensitivity) {
            const s = clamp(Number(sensitivity) || 1, 1, 10);
            // s=1 → 6% de la imagen · s=5 → 1.6% · s=10 → 0.22%
            return clamp(0.06 * Math.pow(0.72, s - 1), 0.001, 0.12);
        }

        /* ---------- Interno ---------- */

        _safeInterval() {
            return clamp(Number(this.options.intervalMs) || 333, 80, 5000);
        }

        _setStatus(status) {
            if (this._status === status) return;
            this._status = status;
            this._emit('onStatus', status);
        }

        _emit(name, payload) {
            const handler = this._callbacks[name];
            if (typeof handler !== 'function') return;
            try {
                handler(payload);
            } catch (error) {
                // Un error en la interfaz nunca debe detener el análisis.
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn(`[MotionDetector] Error en ${name}:`, error);
                }
            }
        }

        _canAnalyze() {
            if (this.options.canvasFactory) return true;
            if (!hasDocument()) return false;
            try {
                const test = document.createElement('canvas');
                return !!(test && test.getContext && test.getContext('2d'));
            } catch (error) {
                return false;
            }
        }

        _ensureCanvas() {
            if (this._ctx) return true;

            const width = clamp(Math.round(this.options.width), 32, 640);
            const height = clamp(Math.round(this.options.height), 32, 480);

            try {
                if (typeof this.options.canvasFactory === 'function') {
                    this._canvas = this.options.canvasFactory(width, height);
                } else {
                    this._canvas = document.createElement('canvas');
                }

                if (!this._canvas) return false;

                this._canvas.width = width;
                this._canvas.height = height;

                this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
                if (!this._ctx) return false;

                this._cur = new Uint8Array(width * height);
                this._prev = null;
                return true;
            } catch (error) {
                this._ctx = null;
                this._canvas = null;
                this._emit('onError', error);
                return false;
            }
        }

        _tick() {
            if (!this._running || this._busy) return;
            this._busy = true;

            try {
                this._analyze();
                this._errors = 0;
            } catch (error) {
                this._errors++;
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('[MotionDetector] Error al analizar fotograma:', error);
                }
                if (error && error.name === 'SecurityError') {
                    this._fail(error);
                } else if (this._errors >= this.options.maxConsecutiveErrors) {
                    this._fail(error);
                } else {
                    this._prev = null; // volver a sincronizar el fotograma de referencia
                }
            } finally {
                this._busy = false;
            }
        }

        _fail(error) {
            const wasRunning = this._running;
            this._running = false;
            if (this._timer !== null) {
                clearInterval(this._timer);
                this._timer = null;
            }
            this._setStatus('error');
            if (wasRunning) this._emit('onError', error);
        }

        _analyze() {
            const video = this._video;

            if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
                this._setStatus('waiting');
                return;
            }

            if (!this.options.analyzeWhenHidden && typeof document !== 'undefined' && document.hidden) {
                this._setStatus('hidden');
                return;
            }

            if (!this._ensureCanvas()) {
                this._fail(new Error('No se pudo preparar el canvas de análisis'));
                return;
            }

            const width = this._canvas.width;
            const height = this._canvas.height;

            // Lectura del fotograma actual (sólo lectura: no altera el stream).
            this._ctx.drawImage(video, 0, 0, width, height);
            const image = this._ctx.getImageData(0, 0, width, height);
            MotionDetector.toGray(image.data, this._cur);
            this._frames++;

            if (this._warmup > 0) {
                // Se descartan los primeros fotogramas: al arrancar el vídeo la
                // imagen cambia mucho (resolución, exposición) y serían falsos positivos.
                this._warmup--;
                this._prev = this._cur.slice();
                this._setStatus('analyzing');
                return;
            }

            if (!this._prev) {
                this._prev = this._cur.slice();
                this._setStatus('analyzing');
                return;
            }

            const result = MotionDetector.analyzeFrames(this._prev, this._cur, {
                pixelThreshold: this.options.pixelThreshold,
                lightCompensation: this.options.lightCompensation
            });

            this._prev.set(this._cur);
            this._evaluate(result);
        }

        _evaluate(result) {
            const now = Date.now();
            const threshold = this.threshold;
            const holdMs = clamp(Number(this.options.motionHoldMs) || 1500, 300, 10000);

            this._metrics = {
                ratio: result.ratio,
                percent: result.ratio * 100,
                changed: result.changed,
                energy: result.energy,
                threshold,
                thresholdPercent: threshold * 100,
                analyzing: true,
                timestamp: now
            };

            this._emit('onMetrics', this._metrics);

            if (result.ratio >= threshold) {
                this._hitFrames++;
                this._lastHitAt = now;

                if (!this._motionActive) {
                    this._motionActive = true;
                    this._emit('onMotionActive', this._metrics);
                }

                if (this._hitFrames >= clamp(this.options.consecutiveFrames, 1, 10)) {
                    if (now >= this._nextAllowedAt) {
                        const cooldownMs = clamp(Number(this.options.cooldownMs) || 15000, 1000, 600000);
                        this._nextAllowedAt = now + cooldownMs;
                        this._hitFrames = 0;
                        this._emit('onMotionStart', Object.assign({}, this._metrics, {
                            source: this.options.source || 'local',
                            cooldownMs,
                            snapshot: () => this.snapshot()
                        }));
                    } else {
                        this._setStatus('cooldown');
                    }
                }
            } else {
                this._hitFrames = 0;
            }

            if (this._motionActive && now - this._lastHitAt > holdMs) {
                this._motionActive = false;
                this._emit('onMotionEnd', { timestamp: now });
            }

            if (!this._motionActive && now < this._nextAllowedAt) {
                this._setStatus('cooldown');
            } else if (this._status !== 'analyzing') {
                this._setStatus('analyzing');
            }
        }
    }

    /* ======================================================================
     * AlarmSystem — los distintos tipos de alarma
     * ==================================================================== */

    class AlarmSystem {
        constructor(options = {}) {
            this.types = new Set(Array.from(options.types || []).filter((type) => ALARM_TYPES.includes(type)));
            this.volume = options.volume === undefined ? 0.8 : clamp(options.volume, 0, 1);
            this.continuous = !!options.continuous;
            this.sound = SOUND_LIBRARY[options.sound] ? options.sound : DEFAULT_SOUND;
            this.voiceText = options.voiceText || 'Movimiento detectado';
            this.maxContinuousMs = options.maxContinuousMs || 30000;
            this.onRemoteAlert = options.onRemoteAlert || null;
            this.onStateChange = options.onStateChange || null;

            this.audioContext = null;
            this._nodes = [];
            this._audioElements = [];
            this._timers = [];
            this._endTimer = null;
            this._ringing = false;
            this._flashEl = null;
        }

        /* ---------- Configuración ---------- */

        setTypes(iterable) {
            this.types = new Set(Array.from(iterable || []).filter((type) => ALARM_TYPES.includes(type)));
            return this;
        }

        setType(type, enabled) {
            if (!ALARM_TYPES.includes(type)) return this;
            if (enabled) this.types.add(type);
            else this.types.delete(type);
            return this;
        }

        hasType(type) {
            return this.types.has(type);
        }

        get isRinging() {
            return this._ringing;
        }

        setVolume(value) {
            this.volume = clamp(Number(value) || 0, 0, 1);
            return this;
        }

        setContinuous(enabled) {
            this.continuous = !!enabled;
            if (!this.continuous && this._ringing) this.stop();
            return this;
        }

        setSound(sound) {
            if (SOUND_LIBRARY[sound]) this.sound = sound;
            return this;
        }

        getSound() {
            return SOUND_LIBRARY[this.sound] || SOUND_LIBRARY[DEFAULT_SOUND];
        }

        /* ---------- Permisos ---------- */

        static notificationSupported() {
            return typeof window !== 'undefined' && 'Notification' in window;
        }

        /** Pide permiso de notificaciones (debe llamarse tras un gesto del usuario). */
        async requestNotifications() {
            if (!AlarmSystem.notificationSupported()) return 'unsupported';
            try {
                if (Notification.permission === 'granted') return 'granted';
                if (Notification.permission === 'denied') return 'denied';
                const result = await Notification.requestPermission();
                return result;
            } catch (error) {
                return 'error';
            }
        }

        /* ---------- Disparo ---------- */

        /**
         * Dispara la alarma.
         * @param {Object} context
         *   - source: 'local' | 'remote'
         *   - percent / thresholdPercent: métricas del evento
         *   - isTest: true para la prueba manual
         */
        trigger(context = {}) {
            const source = context.source || 'local';
            const isRemote = source === 'remote';
            const types = Array.from(this.types).filter((type) => {
                // Un aviso remoto nunca se reenvía (evita bucles entre dispositivos).
                if (isRemote && (type === 'remote' || type === 'remote-react')) return false;
                return true;
            });

            if (types.length === 0) return [];

            const applied = [];

            for (const type of types) {
                try {
                    switch (type) {
                        case 'sound':
                            this._playSound();
                            applied.push(type);
                            break;
                        case 'beep':
                            this._beep();
                            applied.push(type);
                            break;
                        case 'voice':
                            this._speak(this.voiceText);
                            applied.push(type);
                            break;
                        case 'vibrate':
                            this._vibrate();
                            applied.push(type);
                            break;
                        case 'flash':
                            this._flash(context);
                            applied.push(type);
                            break;
                        case 'notify':
                            this._notify(context, isRemote);
                            applied.push(type);
                            break;
                        case 'remote':
                            if (typeof this.onRemoteAlert === 'function') {
                                this.onRemoteAlert({
                                    source: 'local',
                                    percent: context.percent || 0,
                                    thresholdPercent: context.thresholdPercent || 0,
                                    timestamp: Date.now()
                                });
                                applied.push(type);
                            }
                            break;
                        case 'remote-react':
                            // Sólo actúa al recibir un aviso: se gestiona en MotionPanel.
                            break;
                        default:
                            break;
                    }
                } catch (error) {
                    if (typeof console !== 'undefined' && console.warn) {
                        console.warn(`[AlarmSystem] Error al reproducir la alarma "${type}":`, error);
                    }
                }
            }

            if (applied.length > 0) {
                this._ringing = true;
                this._emitState({ active: true, types: applied, source, timestamp: Date.now() });

                // El final de la alarma se cuenta desde el último disparo
                if (this._endTimer !== null) {
                    clearTimeout(this._endTimer);
                    this._endTimer = null;
                }

                const continuousAlarm = this.continuous && (this.types.has('sound') || this.types.has('beep'));

                if (continuousAlarm) {
                    // Sigue sonando hasta pulsar "Detener alarma", con límite de seguridad
                    this._endTimer = setTimeout(() => {
                        this._endTimer = null;
                        this.stop();
                    }, this.maxContinuousMs);
                } else {
                    this._endTimer = setTimeout(() => {
                        this._endTimer = null;
                        this._settle();
                    }, this._flashDuration());
                }
            }

            return applied;
        }

        /** Prueba manual: suena todo lo configurado y siempre muestra la alerta visual. */
        test(context = {}) {
            const types = new Set(this.types);
            if (types.size === 0) {
                types.add('flash');
                types.add('sound');
            }
            const backup = this.types;
            this.types = types;
            const applied = this.trigger(Object.assign({ isTest: true, source: 'local', percent: 0 }, context));
            this.types = backup;
            return applied;
        }

        /** Detiene cualquier alarma en curso. */
        stop() {
            this._ringing = false;

            for (const node of this._nodes) {
                try {
                    if (typeof node.stop === 'function') node.stop(0);
                    if (typeof node.disconnect === 'function') node.disconnect();
                } catch (error) { /* ignorado a propósito */ }
            }
            this._nodes = [];

            for (const audio of this._audioElements) {
                try {
                    audio.pause();
                    audio.currentTime = 0;
                    if (typeof audio.remove === 'function') audio.remove();
                } catch (error) { /* ignorado a propósito */ }
            }
            this._audioElements = [];

            for (const timer of this._timers) clearTimeout(timer);
            this._timers = [];

            if (this._endTimer !== null) {
                clearTimeout(this._endTimer);
                this._endTimer = null;
            }

            if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                try { window.speechSynthesis.cancel(); } catch (error) { /* ignorado */ }
            }

            if (typeof navigator !== 'undefined' && navigator.vibrate) {
                try { navigator.vibrate(0); } catch (error) { /* ignorado */ }
            }

            this._hideFlash();
            this._emitState({ active: false, timestamp: Date.now() });
            return this;
        }

        /* ---------- Reproducción de cada tipo ---------- */

        _flashDuration() {
            return 4000;
        }

        _setTimer(callback, delay) {
            const id = setTimeout(() => {
                this._timers = this._timers.filter((timer) => timer !== id);
                try { callback(); } catch (error) { /* ignorado */ }
            }, delay);
            this._timers.push(id);
            return id;
        }

        _settle() {
            this._ringing = false;
            this._hideFlash();
            this._emitState({ active: false, reason: 'finished', timestamp: Date.now() });
        }

        _emitState(payload) {
            if (typeof this.onStateChange === 'function') {
                try { this.onStateChange(payload); } catch (error) { /* ignorado */ }
            }
        }

        _ensureAudio() {
            const AudioCtor = typeof window !== 'undefined'
                ? (window.AudioContext || window.webkitAudioContext)
                : null;

            if (!AudioCtor) return null;

            try {
                if (!this.audioContext) this.audioContext = new AudioCtor();
                if (this.audioContext.state === 'suspended' && this.audioContext.resume) {
                    // Si el navegador exige gesto del usuario, el resume quedará
                    // pendiente sin lanzar error: no bloquea la alarma visual.
                    this.audioContext.resume().catch(() => {});
                }
                return this.audioContext;
            } catch (error) {
                return null;
            }
        }

        /** Reproduce el MP3 elegido de la biblioteca local de /audio. */
        _playSound() {
            const sound = this.getSound();
            const AudioCtor = typeof Audio !== 'undefined'
                ? Audio
                : (typeof window !== 'undefined' ? window.Audio : null);

            let audio = null;
            try {
                if (AudioCtor) {
                    audio = new AudioCtor(sound.src);
                } else if (hasDocument()) {
                    audio = document.createElement('audio');
                    audio.src = sound.src;
                }

                if (!audio) return;
                audio.preload = 'auto';
                audio.volume = clamp(this.volume, 0, 1);
                audio.loop = !!this.continuous;
                this._audioElements.push(audio);

                const result = audio.play();
                if (result && typeof result.catch === 'function') {
                    result.catch(() => {});
                }
            } catch (error) {
                if (audio) {
                    this._audioElements = this._audioElements.filter((item) => item !== audio);
                }
            }
        }

        /** Timbre: tres pitidos cortos. */
        _beep() {
            const ctx = this._ensureAudio();
            if (!ctx) return;

            const level = clamp(this.volume, 0, 1) * 0.25;
            const start = ctx.currentTime + 0.02;

            for (let i = 0; i < 3; i++) {
                const at = start + i * 0.28;
                const oscillator = ctx.createOscillator();
                const gain = ctx.createGain();

                oscillator.type = 'square';
                oscillator.frequency.value = i === 2 ? 1180 : 880;

                oscillator.connect(gain);
                gain.connect(ctx.destination);

                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);

                oscillator.start(at);
                oscillator.stop(at + 0.2);
                this._nodes.push(oscillator, gain);
            }
        }

        _envelope(gain, now, end, level) {
            const target = Math.max(level, 0.0002);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(target, now + 0.06);
            if (end - now > 0.2) {
                gain.gain.setValueAtTime(target, end - 0.12);
                gain.gain.exponentialRampToValueAtTime(0.0001, end);
            }
        }

        /** Voz: mensaje hablado con la API de síntesis de voz. */
        _speak(text) {
            if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

            try {
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'es-ES';
                utterance.volume = clamp(this.volume, 0, 1);
                utterance.rate = 1.05;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(utterance);
            } catch (error) { /* ignorado */ }
        }

        _vibrate() {
            if (typeof navigator === 'undefined' || !navigator.vibrate) return;
            try {
                navigator.vibrate(this.continuous ? [600, 200, 600, 200, 900] : [400, 150, 400]);
            } catch (error) { /* ignorado */ }
        }

        /** Alerta visual: parpadeo a pantalla completa + banner. */
        _flash(context) {
            if (!hasDocument()) return;

            const overlay = this._flashEl || document.getElementById('alarmOverlay');
            if (!overlay) return;
            this._flashEl = overlay;

            const title = document.getElementById('alarmBannerTitle');
            const text = document.getElementById('alarmBannerText');
            const isRemote = context.source === 'remote';

            if (title) {
                title.textContent = isRemote ? 'MOVIMIENTO (AVISO REMOTO)' : 'MOVIMIENTO DETECTADO';
            }

            if (text) {
                const percent = typeof context.percent === 'number' ? context.percent.toFixed(1) : '0.0';
                const origin = isRemote ? 'El otro dispositivo' : 'Este dispositivo';
                text.textContent = context.isTest
                    ? 'Prueba de alarma'
                    : `${origin} · ${percent}% de la imagen`;
            }

            overlay.classList.remove('hidden');
            // Reinicia la animación si ya estaba visible.
            overlay.classList.remove('active');
            void overlay.offsetWidth;
            overlay.classList.add('active');

            const stopButton = document.getElementById('btnStopAlarm');
            if (stopButton) {
                if (this.continuous && (this.types.has('sound') || this.types.has('beep'))) {
                    stopButton.classList.remove('hidden');
                } else {
                    stopButton.classList.add('hidden');
                }
            }
        }

        _hideFlash() {
            if (!hasDocument()) return;
            const overlay = this._flashEl || document.getElementById('alarmOverlay');
            if (overlay) {
                overlay.classList.remove('active');
                overlay.classList.add('hidden');
            }
            const stopButton = document.getElementById('btnStopAlarm');
            if (stopButton) stopButton.classList.add('hidden');
        }

        /** Notificación del sistema (si hay permiso). */
        _notify(context, isRemote) {
            if (!AlarmSystem.notificationSupported()) return;
            if (Notification.permission !== 'granted') return;

            const body = context.isTest
                ? 'Prueba de alarma correcta'
                : `${isRemote ? 'Aviso del otro dispositivo' : 'Movimiento detectado'} · ${(context.percent || 0).toFixed(1)}% de la imagen`;

            try {
                const notification = new Notification('🚨 Visión Remota', {
                    body,
                    tag: 'vision-remota-movimiento',
                    renotify: true
                });

                this._setTimer(() => {
                    try { notification.close(); } catch (error) { /* ignorado */ }
                }, 8000);
            } catch (error) { /* algunos navegadores lo bloquean en iframes */ }
        }
    }

    /* ======================================================================
     * MotionPanel — motor + alarmas + interfaz
     * ==================================================================== */

    class MotionPanel {
        /**
         * @param {Object} config
         *   - prefix:   'emitter' | 'viewer'  (prefijo de los id del DOM)
         *   - role:     'emitter' | 'viewer'
         *   - getVideo: () => HTMLVideoElement
         *   - notify:   (mensaje, tipo) => void      (avisos de la app)
         *   - sendRemoteAlert: (payload) => void     (aviso al otro dispositivo)
         *   - alarmSystem / detector: inyectables para pruebas
         */
        constructor(config = {}) {
            this.config = config;
            this.prefix = config.prefix || 'viewer';
            this.role = config.role || 'viewer';
            this.getVideo = typeof config.getVideo === 'function' ? config.getVideo : () => null;
            this.notify = typeof config.notify === 'function' ? config.notify : () => {};

            this.settings = this._defaultSettings();
            this.log = [];
            this.count = 0;
            this.lastEventAt = null;
            this._video = null;
            this._logLimit = 20;
            this._elements = {};
            this._bound = false;

            const alarmConfig = {
                types: this._enabledAlarmTypes(),
                volume: this.settings.volume / 100,
                continuous: this.settings.continuous,
                sound: this.settings.sound,
                onRemoteAlert: typeof config.sendRemoteAlert === 'function' ? config.sendRemoteAlert : null,
                onStateChange: (state) => this._onAlarmState(state)
            };

            this.alarms = config.alarmSystem || new AlarmSystem(alarmConfig);

            this.detector = config.detector || new MotionDetector({
                sensitivity: this.settings.sensitivity,
                intervalMs: Math.round(1000 / this.settings.rate),
                cooldownMs: this.settings.cooldown * 1000,
                analyzeWhenHidden: this.settings.background,
                source: this.role
            });

            this.detector.on({
                onMetrics: (metrics) => this._onMetrics(metrics),
                onMotionStart: (event) => this._onMotion(event),
                onMotionActive: () => this._setMotionBadge(true),
                onMotionEnd: () => this._setMotionBadge(false),
                onStatus: (status) => this._onStatus(status),
                onError: (error) => this._onError(error)
            });
        }

        /* ---------- Preferencias ---------- */

        _defaultSettings() {
            const defaults = PANEL_DEFAULTS[this.role] || PANEL_DEFAULTS.viewer;
            const stored = this._loadStored();
            const storedAlarms = stored && stored.alarms ? stored.alarms : {};
            const alarms = {};

            // Migra configuraciones antiguas y descarta tipos que ya no existen.
            for (const type of ALARM_TYPES) {
                alarms[type] = typeof storedAlarms[type] === 'boolean'
                    ? storedAlarms[type]
                    : !!defaults.alarms[type];
            }

            return {
                enabled: stored && typeof stored.enabled === 'boolean' ? stored.enabled : defaults.enabled,
                sensitivity: stored && stored.sensitivity ? stored.sensitivity : 6,
                rate: stored && stored.rate ? stored.rate : 3,
                cooldown: stored && stored.cooldown ? stored.cooldown : 15,
                volume: stored && typeof stored.volume === 'number' ? stored.volume : 75,
                continuous: stored ? !!stored.continuous : false,
                background: stored ? !!stored.background : false,
                sound: stored && SOUND_LIBRARY[stored.sound] ? stored.sound : defaults.sound,
                alarms
            };
        }

        _loadStored() {
            if (typeof localStorage === 'undefined') return null;
            try {
                const raw = localStorage.getItem(MOTION_STORAGE_KEY);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                return parsed && parsed[this.role] ? parsed[this.role] : null;
            } catch (error) {
                return null;
            }
        }

        saveSettings() {
            if (typeof localStorage === 'undefined') return;
            try {
                const raw = localStorage.getItem(MOTION_STORAGE_KEY);
                const all = raw ? JSON.parse(raw) : {};
                all[this.role] = this.settings;
                localStorage.setItem(MOTION_STORAGE_KEY, JSON.stringify(all));
            } catch (error) { /* almacenamiento no disponible */ }
        }

        _enabledAlarmTypes() {
            return Object.keys(this.settings.alarms).filter((type) => this.settings.alarms[type]);
        }

        /* ---------- Interfaz ---------- */

        _el(id) {
            if (!hasDocument()) return null;
            return document.getElementById(this.prefix + id);
        }

        /** Conecta los controles del panel. Idempotente. */
        init() {
            if (this._bound || !hasDocument()) return this;

            const $ = (id) => this._el(id);

            this._elements = {
                section: $('MotionSection'),
                toggle: $('MotionToggle'),
                state: $('MotionState'),
                stateText: $('MotionStateText'),
                stateIcon: $('MotionStateIcon'),
                level: $('MotionLevel'),
                bar: $('MotionBar'),
                threshold: $('MotionThreshold'),
                count: $('MotionCount'),
                last: $('LastMotion'),
                badge: $('MotionBadge'),
                sensitivity: $('MotionSensitivity'),
                sensitivityValue: $('MotionSensitivityValue'),
                rate: $('MotionRate'),
                rateValue: $('MotionRateValue'),
                cooldown: $('MotionCooldown'),
                cooldownValue: $('MotionCooldownValue'),
                volume: $('MotionVolume'),
                volumeValue: $('MotionVolumeValue'),
                sound: $('MotionSound'),
                continuous: $('MotionContinuous'),
                background: $('MotionBackground'),
                testAlarm: $('BtnTestAlarm'),
                clearLog: $('BtnClearLog'),
                log: $('MotionLog'),
                logEmpty: $('MotionLogEmpty')
            };

            if (!this._elements.section) return this;

            this._elements.alarmCheckboxes = Array.from(
                this._elements.section.querySelectorAll('input[data-alarm]')
            );

            this._bindEvents();
            this._renderSettings();
            this._renderLog();
            this._onStatus(this.detector.isRunning ? this.detector.status : (this.settings.enabled ? 'waiting' : 'idle'));
            this._bound = true;
            return this;
        }

        _bindEvents() {
            const elements = this._elements;

            if (elements.toggle) {
                elements.toggle.checked = !!this.settings.enabled;
                elements.toggle.addEventListener('change', () => {
                    this.setEnabled(elements.toggle.checked, { user: true });
                });
            }

            if (elements.sensitivity) {
                elements.sensitivity.addEventListener('input', () => {
                    this.updateSettings({ sensitivity: Number(elements.sensitivity.value) });
                });
            }

            if (elements.rate) {
                elements.rate.addEventListener('input', () => {
                    this.updateSettings({ rate: Number(elements.rate.value) });
                });
            }

            if (elements.cooldown) {
                elements.cooldown.addEventListener('input', () => {
                    this.updateSettings({ cooldown: Number(elements.cooldown.value) });
                });
            }

            if (elements.volume) {
                elements.volume.addEventListener('input', () => {
                    this.updateSettings({ volume: Number(elements.volume.value) });
                });
            }

            if (elements.sound) {
                elements.sound.addEventListener('change', () => {
                    this.updateSettings({ sound: elements.sound.value });
                });
            }

            if (elements.continuous) {
                elements.continuous.addEventListener('change', () => {
                    this.updateSettings({ continuous: elements.continuous.checked });
                });
            }

            if (elements.background) {
                elements.background.addEventListener('change', () => {
                    this.updateSettings({ background: elements.background.checked });
                    if (elements.background.checked && this.settings.enabled) {
                        this.notify('El navegador puede ralentizar el análisis en segundo plano', 'info');
                    }
                });
            }

            for (const checkbox of elements.alarmCheckboxes || []) {
                const type = checkbox.dataset.alarm;
                checkbox.checked = !!this.settings.alarms[type];
                checkbox.addEventListener('change', () => {
                    const alarms = Object.assign({}, this.settings.alarms);
                    alarms[type] = checkbox.checked;
                    this.updateSettings({ alarms });
                    if (checkbox.checked && type === 'notify') {
                        this.alarms.requestNotifications().then((result) => {
                            if (result === 'denied') {
                                this.notify('El navegador bloqueó las notificaciones del sistema', 'warning');
                            } else if (result === 'granted') {
                                this.notify('Notificaciones del sistema activadas', 'success');
                            }
                        });
                    }
                });
            }

            if (elements.testAlarm) {
                elements.testAlarm.addEventListener('click', () => {
                    // Gestos del usuario: buen momento para desbloquear audio y permisos.
                    this.alarms._ensureAudio();
                    if (this.settings.alarms.notify) this.alarms.requestNotifications();
                    const applied = this.alarms.test();
                    if (applied.length === 0) {
                        this.notify('No hay ningún tipo de alarma activado', 'warning');
                    } else {
                        this.notify('Prueba de alarma: ' + applied.map((type) => ALARM_LABELS[type] || type).join(', '), 'info');
                    }
                });
            }

            if (elements.clearLog) {
                elements.clearLog.addEventListener('click', () => {
                    this.log = [];
                    this.count = 0;
                    this.lastEventAt = null;
                    this._renderLog();
                    this._renderCounters();
                    this.notify('Registro de eventos borrado', 'info');
                });
            }

            if (elements.log) {
                elements.log.addEventListener('click', (event) => {
                    const button = event.target.closest('[data-download]');
                    if (button) this._downloadEvent(button.dataset.download);
                });
            }
        }

        _renderSettings() {
            const elements = this._elements;
            const settings = this.settings;
            const show = (el, value) => { if (el) el.textContent = value; };

            if (elements.sensitivity) elements.sensitivity.value = settings.sensitivity;
            show(elements.sensitivityValue, MotionPanel.sensitivityLabel(settings.sensitivity));

            if (elements.rate) elements.rate.value = settings.rate;
            show(elements.rateValue, settings.rate + '/s');

            if (elements.cooldown) elements.cooldown.value = settings.cooldown;
            show(elements.cooldownValue, settings.cooldown + 's');

            if (elements.volume) elements.volume.value = settings.volume;
            show(elements.volumeValue, settings.volume + '%');

            if (elements.sound) elements.sound.value = settings.sound;
            if (elements.continuous) elements.continuous.checked = !!settings.continuous;
            if (elements.background) elements.background.checked = !!settings.background;

            show(elements.threshold, `Umbral de disparo: ${(this.detector.threshold * 100).toFixed(2)}% de la imagen`);
        }

        static sensitivityLabel(value) {
            const labels = [
                'Muy baja', 'Baja', 'Baja-media', 'Media-baja', 'Media',
                'Media-alta', 'Alta', 'Muy alta', 'Muy alta', 'Máxima'
            ];
            return labels[clamp(Math.round(value), 1, 10) - 1] || 'Media';
        }

        /** Aplica y guarda ajustes nuevos. */
        updateSettings(partial = {}) {
            Object.assign(this.settings, partial);

            this.detector.update({
                sensitivity: this.settings.sensitivity,
                intervalMs: Math.round(1000 / clamp(this.settings.rate, 1, 10)),
                cooldownMs: clamp(this.settings.cooldown, 5, 600) * 1000,
                analyzeWhenHidden: this.settings.background
            });

            this.alarms.setTypes(this._enabledAlarmTypes());
            this.alarms.setVolume(this.settings.volume / 100);
            this.alarms.setSound(this.settings.sound);
            this.alarms.setContinuous(this.settings.continuous);

            if (this.detector.isRunning) this.detector.start(this._video);

            this.saveSettings();
            this._renderSettings();

            if (this.settings.enabled) this._onStatus(this.detector.status);
            return this;
        }

        /* ---------- Activación / desactivación ---------- */

        get enabled() {
            return !!this.settings.enabled;
        }

        /** Activa o desactiva la detección (persistente). */
        setEnabled(enabled, options = {}) {
            const value = !!enabled;
            this.settings.enabled = value;
            if (this._elements.toggle) this._elements.toggle.checked = value;

            if (value) {
                // El usuario acaba de pulsar: desbloquear audio/permisos.
                this.alarms._ensureAudio();
                if (this.settings.alarms.notify) this.alarms.requestNotifications();
                this.attach();
                if (options.user) this.notify('Detección de movimiento activada', 'success');
            } else {
                this.detach();
                if (options.user) this.notify('Detección de movimiento desactivada', 'info');
            }

            this.saveSettings();
            return this;
        }

        /**
         * La app avisa de que el vídeo ya está disponible.
         * Si la detección está activada, arranca el análisis.
         */
        attach() {
            const video = this.getVideo();
            if (video) this._video = video;

            if (!this.settings.enabled) {
                this._onStatus('idle');
                return this;
            }

            if (!this._video) {
                this._onStatus('waiting');
                return this;
            }

            if (this.detector.isRunning && this.detector.video === this._video) return this;

            const started = this.detector.start(this._video);
            this._onStatus(started ? 'waiting' : this.detector.status);
            return this;
        }

        /** La app avisa de que el vídeo ha dejado de estar disponible. */
        detach(reason = 'detached') {
            if (this.detector.isRunning) this.detector.stop();
            this.alarms.stop();
            this._setMotionBadge(false);
            this._onStatus('idle');
            if (this._elements.bar) this._elements.bar.style.width = '0%';
            if (this._elements.level) this._elements.level.textContent = '0.0%';
            return this;
        }

        /* ---------- Eventos del motor ---------- */

        _onMetrics(metrics) {
            const elements = this._elements;
            if (!elements.bar) return;

            const threshold = metrics.threshold || this.detector.threshold;
            const ratio = clamp(metrics.ratio / (threshold * 1.25), 0, 1);
            elements.bar.style.width = (ratio * 100).toFixed(1) + '%';
            elements.bar.classList.toggle('over', metrics.ratio >= threshold);

            if (elements.level) {
                elements.level.textContent = metrics.percent.toFixed(1) + '%';
                elements.level.classList.toggle('over', metrics.ratio >= threshold);
            }
        }

        _onMotion(event) {
            this.count++;
            this.lastEventAt = event.timestamp;

            const thumbnail = typeof event.snapshot === 'function' ? event.snapshot() : null;

            this._addLogEntry({
                at: event.timestamp,
                source: 'local',
                percent: event.percent,
                thresholdPercent: event.thresholdPercent,
                thumbnail
            });

            this.alarms.trigger({
                source: 'local',
                percent: event.percent,
                thresholdPercent: event.thresholdPercent
            });

            this.notify(`¡Movimiento detectado! (${event.percent.toFixed(1)}% de la imagen)`, 'warning');
            this._renderCounters();
        }

        _onStatus(status) {
            const elements = this._elements;
            if (!elements.state) return;

            const states = {
                idle: { icon: 'fa-power-off', text: 'Inactiva', className: 'idle' },
                waiting: { icon: 'fa-circle-notch', text: 'Esperando vídeo…', className: 'waiting' },
                analyzing: { icon: 'fa-eye', text: 'Analizando…', className: 'analyzing' },
                cooldown: { icon: 'fa-hourglass-half', text: 'Movimiento reciente (en espera)', className: 'cooldown' },
                hidden: { icon: 'fa-moon', text: 'Pausada (pestaña en segundo plano)', className: 'hidden-tab' },
                unsupported: { icon: 'fa-triangle-exclamation', text: 'No compatible', className: 'error' },
                error: { icon: 'fa-triangle-exclamation', text: 'Error: análisis detenido', className: 'error' }
            };

            const info = states[status] || states.idle;
            elements.state.className = 'motion-state ' + info.className;
            if (elements.stateText) elements.stateText.textContent = info.text;
            if (elements.stateIcon) elements.stateIcon.className = 'fas ' + info.icon;

            if (elements.section) elements.section.classList.toggle('is-active', !!this.settings.enabled);
            if (elements.badge) {
                elements.badge.classList.toggle('hidden', !this.settings.enabled || status === 'idle');
            }
        }

        _onError(error) {
            const message = error && error.name === 'SecurityError'
                ? 'La transmisión no permite el análisis de fotogramas en este navegador'
                : 'Detección de movimiento detenida por un error: ' + (error && error.message ? error.message : 'desconocido');
            this.notify(message, 'error');
            this.settings.enabled = false;
            if (this._elements.toggle) this._elements.toggle.checked = false;
            this.saveSettings();
            this._onStatus('error');
        }

        _setMotionBadge(active) {
            const badge = this._elements.badge;
            if (!badge) return;
            badge.classList.toggle('motion', !!active);
            const text = badge.querySelector('span');
            if (text) text.textContent = active ? 'MOVIMIENTO' : 'Sin movimiento';
        }

        _onAlarmState(state) {
            if (!this._elements.section) return;
            this._elements.section.classList.toggle('ringing', !!state.active);
        }

        /* ---------- Avisos remotos ---------- */

        /**
         * El otro dispositivo ha detectado movimiento.
         * Sólo se reacciona si la opción "Reaccionar a avisos remotos" está activa.
         */
        handleRemoteAlert(payload = {}) {
            const percent = typeof payload.percent === 'number' ? payload.percent : 0;
            const origin = this.role === 'emitter' ? 'Supervisor' : 'Emisor';

            this.count++;
            this.lastEventAt = payload.timestamp || Date.now();

            this._addLogEntry({
                at: this.lastEventAt,
                source: 'remote',
                percent,
                thresholdPercent: payload.thresholdPercent || 0,
                thumbnail: null,
                origin
            });
            this._renderCounters();

            if (!this.settings.alarms['remote-react']) return this;

            this.alarms.trigger({
                source: 'remote',
                percent,
                thresholdPercent: payload.thresholdPercent || 0
            });

            this.notify(`Movimiento detectado por el ${origin.toLowerCase()} (${percent.toFixed(1)}%)`, 'warning');
            return this;
        }

        /* ---------- Registro de eventos ---------- */

        _addLogEntry(entry) {
            this.log.unshift(entry);
            if (this.log.length > this._logLimit) this.log.length = this._logLimit;
            this._renderLog();
        }

        _renderLog() {
            const container = this._elements.log;
            if (!container) return;

            const empty = this._elements.logEmpty;
            const scrollTop = container.scrollTop;

            // Se vacía el contenedor y se repinta el registro completo: así al
            // borrar los eventos desaparecen también las filas ya dibujadas.
            container.innerHTML = '';

            if (this.log.length === 0) {
                if (empty) {
                    empty.classList.remove('hidden');
                    container.appendChild(empty);
                }
                return;
            }

            if (empty) empty.classList.add('hidden');

            this.log.forEach((entry, index) => {
                const item = document.createElement('div');
                item.className = 'motion-log-item ' + (entry.source === 'remote' ? 'remote' : 'local');

                const thumb = entry.thumbnail
                    ? `<img class="motion-thumb" src="${entry.thumbnail}" alt="Evidencia" data-download="${index}">`
                    : `<div class="motion-thumb placeholder"><i class="fas fa-${entry.source === 'remote' ? 'satellite-dish' : 'video-slash'}"></i></div>`;

                item.innerHTML = `
                    ${thumb}
                    <div class="motion-log-info">
                        <span class="motion-log-time">${formatTime(entry.at)}</span>
                        <span class="motion-log-detail">${(entry.percent || 0).toFixed(1)}% de la imagen</span>
                    </div>
                    <span class="motion-log-tag">${entry.source === 'remote' ? (entry.origin || 'Remoto') : 'Local'}</span>
                `;

                container.appendChild(item);
            });

            container.scrollTop = scrollTop;
        }

        _renderCounters() {
            if (this._elements.count) this._elements.count.textContent = String(this.count);
            if (this._elements.last) {
                this._elements.last.textContent = this.lastEventAt ? formatTime(this.lastEventAt) : '--:--:--';
            }
        }

        _downloadEvent(index) {
            const entry = this.log[Number(index)];
            if (!entry || !entry.thumbnail || !hasDocument()) return;

            const stamp = new Date(entry.at).toISOString().replace(/[:.]/g, '-');
            const link = document.createElement('a');
            link.href = entry.thumbnail;
            link.download = `movimiento-${stamp}.jpg`;
            link.click();
        }

        /** Libera todo (al salir del modo o cerrar la página). */
        destroy() {
            this.detector.destroy();
            this.alarms.stop();
            this._setMotionBadge(false);
            return this;
        }
    }

    return {
        MotionDetector,
        AlarmSystem,
        MotionPanel,
        MOTION_DEFAULTS,
        ALARM_TYPES,
        ALARM_LABELS,
        SOUND_LIBRARY,
        DEFAULT_SOUND,
        MOTION_STORAGE_KEY
    };
});
