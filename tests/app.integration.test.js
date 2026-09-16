'use strict';
/* ============================================================================
 * Prueba de integración: carga index.html + motion.js + script.js en jsdom y
 * comprueba que
 *   1) la aplicación arranca sin errores,
 *   2) la transmisión (getUserMedia → <video> → pistas) sigue intacta,
 *   3) la detección de movimiento y las alarmas funcionan de verdad,
 *   4) el aviso remoto por el canal de datos no genera bucles.
 *
 * No usa navegador real: canvas, WebRTC y PeerJS se sustituyen por dobles de
 * prueba. Ejecutar con:  npm test
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const motionSource = fs.readFileSync(path.join(ROOT, 'motion.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        let value = false;
        try {
            value = predicate();
        } catch (error) {
            value = false;
        }
        if (value) return true;
        await sleep(25);
    }
    return false;
}

/* --------------------------------------------------------------------------
 * Dobles de prueba
 * ------------------------------------------------------------------------ */

/** Canvas falso: genera fotogramas con un cuadrado que se mueve. */
function makeFrameState() {
    return { frame: 0, drawings: 0, mode: 'moving' };
}

function makeContext(state) {
    return {
        drawImage() { state.drawings++; },
        getImageData(x, y, width, height) {
            state.frame++;
            const data = new Uint8ClampedArray(width * height * 4);
            const offset = state.mode === 'moving' ? (state.frame % 6) * 8 : 0;

            for (let row = 0; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    const index = (row * width + col) * 4;
                    const insideSquare =
                        col >= 30 + offset && col < 60 + offset &&
                        row >= 30 && row < 70;
                    const value = insideSquare ? 240 : 40;

                    data[index] = value;
                    data[index + 1] = value;
                    data[index + 2] = value;
                    data[index + 3] = 255;
                }
            }

            return { data, width, height };
        }
    };
}

/** Stream falso con pistas que detectan si alguien las detiene. */
function makeStream() {
    const videoTrack = {
        kind: 'video', label: 'cámara falsa', enabled: true, stopped: false,
        stop() { this.stopped = true; },
        applyConstraints() { return Promise.resolve(); },
        getSettings() { return { width: 1280, height: 720, frameRate: 30 }; }
    };
    const audioTrack = {
        kind: 'audio', label: 'micrófono falso', enabled: true, stopped: false,
        stop() { this.stopped = true; }
    };

    return {
        getTracks: () => [videoTrack, audioTrack],
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [audioTrack],
        addTrack() {},
        removeTrack() {},
        __tracks: [videoTrack, audioTrack]
    };
}

/**
 * Arranca la aplicación en jsdom con todos los dobles listos.
 * @returns {Object} { dom, window, document, app, state, sent, errors }
 */
function boot(t) {
    const state = makeFrameState();
    const sent = [];
    const errors = [];

    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => errors.push('jsdomError: ' + error.message));
    virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        url: 'https://vision-remota.test/',
        virtualConsole
    });

    const { window } = dom;
    const { document } = window;

    // Cerrar el DOM al terminar la prueba (libera temporizadores de jsdom)
    if (t && typeof t.after === 'function') {
        t.after(() => {
            try { window.close(); } catch (error) { /* ignorado */ }
        });
    }

    /* --- Canvas: el detector crea su propio canvas diminuto --- */
    window.HTMLCanvasElement.prototype.getContext = function () {
        if (!this.__testContext) this.__testContext = makeContext(state);
        return this.__testContext;
    };
    window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AAAA';

    /* --- Vídeo: siempre "listo", con fotogramas disponibles --- */
    const define = (proto, property, descriptor) => {
        try {
            Object.defineProperty(proto, property, descriptor);
        } catch (error) {
            errors.push(`No se pudo definir ${property}: ${error.message}`);
        }
    };

    define(window.HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null });
    define(window.HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
    define(window.HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 160 });
    define(window.HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 120 });
    window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    window.HTMLMediaElement.prototype.pause = function () {};

    /* --- Audio: cuenta los osciladores creados (sirena/timbre) --- */
    const audio = { contexts: 0, oscillators: 0 };

    class FakeNode {
        constructor() {
            this.frequency = { value: 0 };
            this.gain = {
                value: 0,
                setValueAtTime() {},
                exponentialRampToValueAtTime() {}
            };
            this.type = '';
        }
        connect() { return this; }
        disconnect() {}
        start() {}
        stop() {}
    }

    class FakeAudioContext {
        constructor() {
            audio.contexts++;
            this.state = 'running';
            this.currentTime = 0;
            this.destination = new FakeNode();
        }
        createOscillator() { audio.oscillators++; return new FakeNode(); }
        createGain() { return new FakeNode(); }
        createBiquadFilter() { return new FakeNode(); }
        resume() { return Promise.resolve(); }
    }

    window.AudioContext = FakeAudioContext;

    /* --- Permisos de cámara/micrófono --- */
    window.navigator.mediaDevices = {
        getUserMedia: async () => makeStream(),
        enumerateDevices: async () => ([
            { kind: 'videoinput', deviceId: 'cam-front', label: 'Front camera' },
            { kind: 'videoinput', deviceId: 'cam-back', label: 'Back camera' },
            { kind: 'audioinput', deviceId: 'mic-1', label: 'Micrófono' }
        ])
    };

    /* --- PeerJS falso (nunca sale a la red) --- */
    class FakePeer {
        constructor(id) {
            this.id = id;
            this.disconnected = false;
            this.destroyed = false;
            this._handlers = {};
            setTimeout(() => this._emit('open', id), 0);
        }
        on(event, handler) {
            (this._handlers[event] = this._handlers[event] || []).push(handler);
            return this;
        }
        _emit(event, ...args) {
            (this._handlers[event] || []).forEach((handler) => handler(...args));
        }
        connect(peer) {
            return {
                peer, open: false,
                on() { return this; },
                send() {},
                close() { this.open = false; }
            };
        }
        call() {
            const peerConnection = { getSenders: () => [], addTrack() {} };
            return { peer: 'emisor', peerConnection, on() { return this; }, close() {} };
        }
        destroy() { this.destroyed = true; this.disconnected = true; }
    }

    window.Peer = FakePeer;

    /* --- Cargar la aplicación --- */
    window.eval(motionSource);
    window.eval(appSource);
    document.dispatchEvent(new window.Event('DOMContentLoaded'));

    return { dom, window, document, app: window.app, state, sent, errors, audio };
}

/** Conexión de datos falsa que registra lo que se envía. */
function attachFakeDataConnection(app, sent, peer = 'supervisor-1') {
    const connection = {
        peer,
        open: true,
        sent: [],
        send(message) { sent.push(message); this.sent.push(message); },
        close() { this.open = false; }
    };
    app.dataConnections.set(peer, connection);
    return connection;
}

/* ==========================================================================
 * 1. Arranque
 * ======================================================================== */

test('la aplicación arranca sin errores y con los dos paneles de detección', (t) => {
    const { document, app, errors } = boot(t);

    assert.ok(app, 'window.app debe existir');
    assert.ok(app.motionPanels, 'los paneles de detección deben crearse');
    assert.ok(app.motionPanels.emitter && app.motionPanels.viewer, 'emisor y supervisor');

    const sections = document.querySelectorAll('#emitterMotionSection, #viewerMotionSection');
    assert.strictEqual(sections.length, 2, 'una sección de detección por panel');

    // Valores por defecto: el supervisor analiza, el emisor espera a que lo activen
    assert.strictEqual(document.getElementById('viewerMotionToggle').checked, true);
    assert.strictEqual(document.getElementById('emitterMotionToggle').checked, false);

    // Tipos de alarma presentes en la interfaz
    const alarmOptions = document.querySelectorAll('#viewerMotionSection input[data-alarm]');
    assert.strictEqual(alarmOptions.length, 8, 'ocho tipos de alarma configurable');

    // Alerta visual disponible pero oculta hasta que haya movimiento
    assert.ok(document.getElementById('alarmOverlay').classList.contains('hidden'));
    assert.ok(document.getElementById('btnStopAlarm').classList.contains('hidden'));

    // Sin vídeo todavía, la detección no debe estar analizando nada
    assert.strictEqual(app.motionPanels.viewer.detector.isRunning, false);
    assert.strictEqual(app.motionPanels.emitter.detector.isRunning, false);

    // Todos los id que motion.js espera deben existir para cada panel: si se
    // renombra algo en el HTML, esta prueba lo detecta al instante.
    const suffixes = [
        'MotionSection', 'MotionToggle', 'MotionState', 'MotionStateIcon', 'MotionStateText',
        'MotionLevel', 'MotionBar', 'MotionThreshold', 'MotionCount', 'LastMotion',
        'MotionBadge', 'MotionSensitivity', 'MotionSensitivityValue', 'MotionRate',
        'MotionRateValue', 'MotionCooldown', 'MotionCooldownValue', 'MotionVolume',
        'MotionVolumeValue', 'MotionContinuous', 'MotionBackground', 'BtnTestAlarm',
        'BtnClearLog', 'MotionLog', 'MotionLogEmpty'
    ];

    for (const prefix of ['emitter', 'viewer']) {
        for (const suffix of suffixes) {
            assert.ok(
                document.getElementById(prefix + suffix),
                `falta el elemento #${prefix}${suffix}`
            );
        }
    }

    // Y el módulo debe encontrarlos todos (una errata en un id se detecta aquí)
    for (const key of ['emitter', 'viewer']) {
        const found = app.motionPanels[key]._elements;
        for (const [name, element] of Object.entries(found)) {
            if (name === 'alarmCheckboxes') continue;
            assert.ok(element, `motion.js no encuentra el control "${name}" del panel ${key}`);
        }
        assert.strictEqual(found.alarmCheckboxes.length, 8, 'ocho casillas de tipo de alarma');
    }

    assert.ok(document.getElementById('alarmOverlay'), 'existe la capa de alerta visual');
    assert.ok(document.getElementById('alarmBannerTitle'), 'existe el texto del banner');
    assert.ok(document.getElementById('btnStopAlarm'), 'existe el botón de detener alarma');

    assert.deepStrictEqual(errors, []);
});

/* ==========================================================================
 * 2. La transmisión sigue funcionando exactamente igual
 * ======================================================================== */

test('la transmisión del emisor no se altera al activar la detección', async (t) => {
    const { app, document, errors, state } = boot(t);

    await app.setEmitterMode();
    assert.strictEqual(app.state.isEmitter, true);

    await app.startEmitter();

    // La cámara y el vídeo local funcionan como antes
    assert.strictEqual(app.state.isStreaming, true);
    assert.ok(app.localStream, 'el stream local existe');
    assert.strictEqual(app.elements.localVideo.srcObject, app.localStream);
    assert.strictEqual(app.elements.localVideo.muted, true);
    assert.ok(app.localStream.__tracks.every((track) => !track.stopped), 'ninguna pista detenida');

    // Ahora el usuario activa la detección
    const toggle = document.getElementById('emitterMotionToggle');
    toggle.checked = true;
    toggle.dispatchEvent(new app.elements.localVideo.ownerDocument.defaultView.Event('change'));

    assert.strictEqual(app.motionPanels.emitter.enabled, true);
    assert.strictEqual(app.motionPanels.emitter.detector.isRunning, true);

    // El primer análisis tarda un poco (333 ms por defecto)
    assert.ok(await waitFor(() => state.drawings > 0, 2000), 'el detector lee fotogramas');

    // El análisis no puede tocar el stream ni el vídeo
    assert.strictEqual(app.elements.localVideo.srcObject, app.localStream);
    assert.ok(app.localStream.__tracks.every((track) => !track.stopped), 'las pistas siguen vivas');
    assert.strictEqual(app.state.isStreaming, true);

    // ...y al detener la transmisión, la detección se para sola
    app.stopEmitter();

    assert.strictEqual(app.motionPanels.emitter.detector.isRunning, false);
    assert.strictEqual(app.state.isStreaming, false);
    assert.ok(app.localStream === null, 'el stream se libera al detener');

    assert.deepStrictEqual(errors, []);
});

/* ==========================================================================
 * 3. Detección real en el emisor: registro, alarma y aviso remoto
 * ======================================================================== */

test('el emisor detecta movimiento, guarda evidencia, alarma y avisa al supervisor', async (t) => {
    const { app, document, errors, sent, audio, state } = boot(t);

    await app.setEmitterMode();
    await app.startEmitter();

    // Hay un supervisor conectado por el canal de datos
    const connection = attachFakeDataConnection(app, sent);

    // El usuario activa la detección en el emisor
    const toggle = document.getElementById('emitterMotionToggle');
    toggle.checked = true;
    toggle.dispatchEvent(new (app.elements.localVideo.ownerDocument.defaultView.Event)('change'));

    const detected = await waitFor(() => document.getElementById('emitterMotionCount').textContent === '1');

    assert.ok(detected, 'debe registrarse un evento de movimiento');
    assert.ok(state.frame > 3, 'el motor analizó varios fotogramas');

    // Registro de eventos con evidencia
    const entries = document.querySelectorAll('#emitterMotionLog .motion-log-item');
    assert.strictEqual(entries.length, 1);
    assert.ok(document.querySelector('#emitterMotionLog img.motion-thumb'), 'guardó la captura de evidencia');

    // Se disparó la alarma (el emisor tiene sirena + alerta visual activadas por defecto)
    assert.ok(audio.oscillators > 0, 'la sirena usa WebAudio');
    assert.strictEqual(document.getElementById('alarmOverlay').classList.contains('hidden'), false);
    assert.ok(document.getElementById('emitterMotionBadge').classList.contains('motion') ||
        document.getElementById('emitterMotionBadge').classList.contains('hidden') === false);

    // Se avisó al supervisor por el canal de datos
    const alerts = connection.sent.map((message) => JSON.parse(message));
    const motionAlert = alerts.find((message) => message.type === 'motion-alert');
    assert.ok(motionAlert, 'debe enviarse un aviso de movimiento');
    assert.strictEqual(motionAlert.source, 'emitter');
    assert.ok(motionAlert.percent > 0);

    // Y la transmisión sigue intacta
    assert.strictEqual(app.elements.localVideo.srcObject, app.localStream);
    assert.ok(app.localStream.__tracks.every((track) => !track.stopped));
    assert.strictEqual(app.motionPanels.emitter.detector.isRunning, true);

    // El botón de detener alarma funciona
    app.stopAllAlarms();
    assert.ok(document.getElementById('btnStopAlarm').classList.contains('hidden'));

    assert.deepStrictEqual(errors, []);
});

/* ==========================================================================
 * 4. Avisos remotos: reacción sin bucle
 * ======================================================================== */

test('el supervisor reacciona a un aviso remoto sin reenviarlo (sin bucles)', async (t) => {
    const { app, document, sent, errors } = boot(t);

    await app.setViewerMode();
    const connection = attachFakeDataConnection(app, sent, 'emisor');

    app.handleMotionAlert({ percent: 4.25, thresholdPercent: 1.2, source: 'emitter' });

    const entry = document.querySelector('#viewerMotionLog .motion-log-item.remote');
    assert.ok(entry, 'el evento remoto aparece en el registro');
    assert.strictEqual(document.getElementById('viewerMotionCount').textContent, '1');
    assert.ok(
        document.getElementById('alarmOverlay').classList.contains('hidden') === false,
        'la alerta visual se muestra'
    );

    // No se reenvía el aviso: nada de bucles entre dispositivos
    const forwarded = connection.sent
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === 'motion-alert');
    assert.strictEqual(forwarded.length, 0, 'un aviso remoto nunca se reenvía');

    assert.deepStrictEqual(errors, []);
});

/* ==========================================================================
 * 5. El supervisor analiza el vídeo remoto sin tocar el <video>
 * ======================================================================== */

test('el supervisor detecta movimiento en el vídeo recibido sin modificar el elemento', async (t) => {
    const { app, document, errors } = boot(t);

    await app.setViewerMode();

    const remoteVideo = app.elements.remoteVideo;
    assert.strictEqual(remoteVideo.srcObject, null, 'sin conexión todavía');

    // El panel del supervisor está activado por defecto
    app.motionPanels.viewer.attach();
    assert.strictEqual(app.motionPanels.viewer.detector.isRunning, true);

    const detected = await waitFor(() => document.getElementById('viewerMotionCount').textContent === '1');

    assert.ok(detected, 'el supervisor detecta el movimiento del vídeo remoto');

    // El detector sólo lee: nunca asigna srcObject ni pistas
    assert.strictEqual(remoteVideo.srcObject, null);
    assert.ok(document.querySelector('#viewerMotionLog .motion-log-item.local'));

    const detector = app.motionPanels.viewer.detector;
    assert.strictEqual(detector.video, remoteVideo, 'analiza el vídeo remoto');
    assert.ok(detector.frames > 3, 'analizó fotogramas de verdad');

    assert.deepStrictEqual(errors, []);
});

/* ==========================================================================
 * 6. Sensibilidad y ajustes desde la interfaz
 * ======================================================================== */

test('los controles de sensibilidad, ritmo y enfriamiento se aplican y se guardan', async (t) => {
    const { app, document, window, errors } = boot(t);

    const panel = app.motionPanels.viewer;
    const setRange = (id, value) => {
        const input = document.getElementById(id);
        input.value = String(value);
        input.dispatchEvent(new window.Event('input'));
    };

    setRange('viewerMotionSensitivity', 9);
    setRange('viewerMotionRate', 5);
    setRange('viewerMotionCooldown', 45);

    assert.strictEqual(panel.settings.sensitivity, 9);
    assert.strictEqual(panel.detector.options.sensitivity, 9);
    assert.strictEqual(panel.detector.threshold, app.motionPanels.viewer.detector.threshold);
    assert.strictEqual(panel.detector.options.intervalMs, 200, '5 análisis por segundo');
    assert.strictEqual(panel.detector.options.cooldownMs, 45000, '45 s de silencio');
    assert.strictEqual(document.getElementById('viewerMotionSensitivityValue').textContent, 'Muy alta');
    assert.ok(panel.detector.threshold < 0.01, 'sensibilidad 9 → umbral muy bajo');

    // Las preferencias se guardan por rol
    const stored = JSON.parse(window.localStorage.getItem('visionMotionSettings'));
    assert.strictEqual(stored.viewer.sensitivity, 9);
    assert.strictEqual(stored.viewer.cooldown, 45);

    // Cambiar los tipos de alarma afecta al sistema de alarmas
    const siren = document.querySelector('#viewerMotionSection input[data-alarm="siren"]');
    siren.checked = true;
    siren.dispatchEvent(new window.Event('change'));
    assert.strictEqual(panel.alarms.hasType('siren'), true);

    assert.deepStrictEqual(errors, []);
});

/* ==========================================================================
 * 7. Botones de prueba de alarma y de limpieza del registro
 * ======================================================================== */

test('los botones de probar alarma y limpiar registro funcionan', async (t) => {
    const { app, document, errors } = boot(t);
    const panel = app.motionPanels.viewer;

    // Probar alarma → se muestra la alerta visual configurada por defecto
    document.getElementById('viewerBtnTestAlarm').click();
    assert.strictEqual(panel.alarms.isRinging, true, 'la alarma está sonando');
    assert.strictEqual(
        document.getElementById('alarmOverlay').classList.contains('hidden'), false,
        'la alerta visual aparece en pantalla'
    );

    app.stopAllAlarms();
    assert.strictEqual(panel.alarms.isRinging, false);
    assert.ok(document.getElementById('alarmOverlay').classList.contains('hidden'));

    // Registro: se llena con un aviso remoto y se vacía con el botón
    app.handleMotionAlert({ percent: 2.5, thresholdPercent: 1.2 });
    assert.strictEqual(document.querySelectorAll('#viewerMotionLog .motion-log-item').length, 1);
    assert.strictEqual(document.getElementById('viewerMotionCount').textContent, '1');
    assert.notStrictEqual(document.getElementById('viewerLastMotion').textContent, '--:--:--');

    document.getElementById('viewerBtnClearLog').click();
    assert.strictEqual(document.querySelectorAll('#viewerMotionLog .motion-log-item').length, 0);
    assert.strictEqual(document.getElementById('viewerMotionCount').textContent, '0');

    assert.deepStrictEqual(errors, []);
});
