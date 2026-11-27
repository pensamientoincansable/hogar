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
const iceSource = fs.readFileSync(path.join(ROOT, 'ice-servers.js'), 'utf8');
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
    /* --- Audio: registra WebAudio y los MP3 reproducidos --- */
    const audio = { contexts: 0, oscillators: 0, filePlays: [] };
    window.HTMLMediaElement.prototype.play = function () {
        if (this.tagName === 'AUDIO' && /\/audio\//.test(this.src || '')) {
            audio.filePlays.push(new window.URL(this.src).pathname);
        }
        return Promise.resolve();
    };
    window.HTMLMediaElement.prototype.pause = function () {};

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
    window.eval(iceSource);
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
 * 1. Arranque e interfaz por modos
 * ======================================================================== */

test('la detección sólo existe en el supervisor y ofrece los ocho MP3', (t) => {
    const { document, app, errors } = boot(t);

    assert.ok(app, 'window.app debe existir');
    assert.ok(app.motionPanels && app.motionPanels.viewer, 'existe el detector del supervisor');
    assert.strictEqual(app.motionPanels.emitter, undefined, 'no se crea detector en el emisor');
    assert.strictEqual(document.getElementById('emitterMotionSection'), null);
    assert.strictEqual(document.getElementById('emitterMotionBadge'), null);
    assert.ok(document.getElementById('viewerMotionSection'));
    assert.strictEqual(document.getElementById('viewerMotionToggle').checked, true);

    const alarmOptions = document.querySelectorAll('#viewerMotionSection input[data-alarm]');
    assert.strictEqual(alarmOptions.length, 8, 'ocho tipos de aviso configurables');
    assert.strictEqual(
        document.querySelector('#viewerMotionSection input[data-alarm="siren"]'),
        null,
        'la opción de sirena se eliminó'
    );

    const sounds = document.querySelectorAll('#viewerMotionSound option');
    assert.strictEqual(sounds.length, 8, 'aparecen todos los archivos MP3 de /audio');
    assert.deepStrictEqual(
        Array.from(sounds, option => option.value),
        [
            'joy-whistle', 'door-bell-campanello', 'doorbell-effect',
            'electronic-doorbell', 'old-door-bell', 'notification-10',
            'whistle-project', 'wolf-whistle'
        ]
    );

    const suffixes = [
        'MotionSection', 'MotionToggle', 'MotionState', 'MotionStateIcon', 'MotionStateText',
        'MotionLevel', 'MotionBar', 'MotionThreshold', 'MotionCount', 'LastMotion',
        'MotionBadge', 'MotionSensitivity', 'MotionSensitivityValue', 'MotionRate',
        'MotionRateValue', 'MotionCooldown', 'MotionCooldownValue', 'MotionVolume',
        'MotionVolumeValue', 'MotionSound', 'MotionContinuous', 'MotionBackground',
        'BtnTestAlarm', 'BtnClearLog', 'MotionLog', 'MotionLogEmpty'
    ];
    for (const suffix of suffixes) {
        assert.ok(document.getElementById('viewer' + suffix), `falta #viewer${suffix}`);
    }

    assert.strictEqual(app.motionPanels.viewer.detector.isRunning, false);
    assert.ok(document.getElementById('alarmOverlay').classList.contains('hidden'));
    assert.deepStrictEqual(errors, []);
});

test('el emisor ordena cámara, código y ajustes, y transmite sin analizar movimiento', async (t) => {
    const { app, document, errors, state } = boot(t);

    await app.setEmitterMode();
    assert.strictEqual(app.state.isEmitter, true);
    assert.strictEqual(app.state.currentCode, app.state.displayCode);
    assert.match(app.state.currentCode, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.ok(document.getElementById('emitterCodeStatus').classList.contains('ready'));

    const content = document.querySelector('#emitterPanel .panel-content');
    const children = Array.from(content.children);
    assert.ok(children[0].classList.contains('video-section'));
    assert.ok(children[1].classList.contains('code-section'));
    assert.ok(children[2].classList.contains('controls-section'));

    await app.startEmitter();
    assert.strictEqual(app.state.isStreaming, true);
    assert.ok(app.localStream);
    assert.strictEqual(app.elements.localVideo.srcObject, app.localStream);
    assert.strictEqual(app.elements.localVideo.muted, true);
    assert.ok(app.localStream.__tracks.every(track => !track.stopped));
    assert.strictEqual(state.drawings, 0, 'el emisor nunca lee fotogramas para detectar movimiento');
    assert.strictEqual(app.elements.btnRefreshCode.disabled, true);

    const stream = app.localStream;
    app.stopEmitter();
    assert.strictEqual(app.state.isStreaming, false);
    assert.strictEqual(app.localStream, null);
    assert.ok(stream.__tracks.every(track => track.stopped));
    assert.strictEqual(app.elements.btnRefreshCode.disabled, false);
    assert.deepStrictEqual(errors, []);
});

/* ==========================================================================
 * 2. Código de acceso y orden de conexión
 * ======================================================================== */

test('el código ignora mayúsculas, espacios y separadores, y el código visible siempre está activo', async (t) => {
    const { app, document, window, errors } = boot(t);

    assert.strictEqual(app.normalizeAccessCode(' a1-b 2_c3 '), 'A1B2C3');
    const input = document.getElementById('peerCodeInput');
    input.value = 'ab-12 cd';
    input.dispatchEvent(new window.Event('input'));
    assert.strictEqual(input.value, 'AB12CD');

    let connectedCode = null;
    app.attemptConnection = async code => { connectedCode = code; return true; };
    input.value = 'xy9z8q';
    await app.connectToEmitter();
    assert.strictEqual(connectedCode, 'XY9Z8Q', 'la conexión recibe siempre el código normalizado');

    await app.setEmitterMode();
    const previous = app.state.currentCode;
    await app.refreshEmitterCode();

    assert.notStrictEqual(app.state.currentCode, previous);
    assert.strictEqual(app.state.currentCode, app.state.displayCode);
    assert.strictEqual(app.peer.id, app.state.currentCode, 'PeerJS usa exactamente el código mostrado');
    assert.strictEqual(document.getElementById('emitterCode').textContent, app.state.currentCode);
    assert.ok(document.getElementById('emitterCodeStatus').classList.contains('ready'));
    assert.deepStrictEqual(errors, []);
});

test('un supervisor que llega antes de iniciar la cámara queda esperando y se atiende al arrancar', async (t) => {
    const { app, errors } = boot(t);
    await app.setEmitterMode();

    const handlers = {};
    const call = {
        peer: 'supervisor-temprano',
        answeredWith: null,
        closed: false,
        on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); return this; },
        answer(stream) { this.answeredWith = stream; },
        close() { this.closed = true; (handlers.close || []).forEach(handler => handler()); }
    };

    app.handleIncomingCall(call);
    assert.strictEqual(call.closed, false, 'no se rechaza la llamada temprana');
    assert.strictEqual(app.pendingIncomingCalls.get(call.peer), call);

    await app.startEmitter();
    assert.strictEqual(call.answeredWith, app.localStream, 'se responde con la cámara al estar lista');
    assert.strictEqual(app.pendingIncomingCalls.size, 0);
    assert.ok(app.state.connectedViewers.has(call.peer));
    assert.deepStrictEqual(errors, []);
});

/* ==========================================================================
 * 3. Detección y alarmas en el supervisor
 * ======================================================================== */

test('el supervisor detecta movimiento, registra evidencia y reproduce el MP3 elegido', async (t) => {
    const { app, document, window, audio, state, errors } = boot(t);
    await app.setViewerMode();

    const sound = document.getElementById('viewerMotionSound');
    sound.value = 'wolf-whistle';
    sound.dispatchEvent(new window.Event('change'));
    assert.strictEqual(app.motionPanels.viewer.settings.sound, 'wolf-whistle');

    const remoteVideo = app.elements.remoteVideo;
    app.motionPanels.viewer.attach();
    const detected = await waitFor(() => document.getElementById('viewerMotionCount').textContent === '1');

    assert.ok(detected, 'se detecta el movimiento del vídeo remoto');
    assert.ok(state.frame > 3);
    assert.strictEqual(remoteVideo.srcObject, null, 'el detector sólo lee el elemento de vídeo');
    assert.ok(document.querySelector('#viewerMotionLog img.motion-thumb'));
    assert.ok(audio.filePlays.some(pathname => pathname.endsWith('/audio/wolf-whistle.mp3')));
    assert.strictEqual(document.getElementById('alarmOverlay').classList.contains('hidden'), false);
    assert.deepStrictEqual(errors, []);
});

test('el supervisor reacciona a un aviso remoto sin reenviarlo', async (t) => {
    const { app, document, sent, errors } = boot(t);
    await app.setViewerMode();
    const connection = attachFakeDataConnection(app, sent, 'emisor');

    app.handleMotionAlert({ percent: 4.25, thresholdPercent: 1.2, source: 'remote' });

    assert.ok(document.querySelector('#viewerMotionLog .motion-log-item.remote'));
    assert.strictEqual(document.getElementById('viewerMotionCount').textContent, '1');
    assert.strictEqual(document.getElementById('alarmOverlay').classList.contains('hidden'), false);
    const forwarded = connection.sent
        .map(message => JSON.parse(message))
        .filter(message => message.type === 'motion-alert');
    assert.strictEqual(forwarded.length, 0, 'no se crean bucles de avisos');
    assert.deepStrictEqual(errors, []);
});

test('los controles del supervisor aplican y guardan sensibilidad, ritmo, volumen y sonido', (t) => {
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
    setRange('viewerMotionVolume', 60);
    const sound = document.getElementById('viewerMotionSound');
    sound.value = 'old-door-bell';
    sound.dispatchEvent(new window.Event('change'));

    assert.strictEqual(panel.detector.options.sensitivity, 9);
    assert.strictEqual(panel.detector.options.intervalMs, 200);
    assert.strictEqual(panel.detector.options.cooldownMs, 45000);
    assert.strictEqual(panel.alarms.volume, 0.6);
    assert.strictEqual(panel.alarms.sound, 'old-door-bell');
    assert.strictEqual(document.getElementById('viewerMotionSensitivityValue').textContent, 'Muy alta');

    const stored = JSON.parse(window.localStorage.getItem('visionMotionSettings'));
    assert.strictEqual(stored.viewer.sound, 'old-door-bell');
    assert.strictEqual(stored.viewer.cooldown, 45);
    assert.strictEqual(stored.viewer.alarms.siren, undefined, 'no persiste el tipo eliminado');
    assert.deepStrictEqual(errors, []);
});

test('probar alarma usa el sonido seleccionado y limpiar registro reinicia los contadores', async (t) => {
    const { app, document, window, audio, errors } = boot(t);
    await app.setViewerMode();

    const sound = document.getElementById('viewerMotionSound');
    sound.value = 'notification-10';
    sound.dispatchEvent(new window.Event('change'));
    document.getElementById('viewerBtnTestAlarm').click();

    assert.strictEqual(app.motionPanels.viewer.alarms.isRinging, true);
    assert.ok(audio.filePlays.some(pathname => pathname.endsWith('/audio/soundreality-notification-10-158196.mp3')));
    app.stopAllAlarms();
    assert.strictEqual(app.motionPanels.viewer.alarms.isRinging, false);

    app.handleMotionAlert({ percent: 2.5, thresholdPercent: 1.2 });
    assert.strictEqual(document.querySelectorAll('#viewerMotionLog .motion-log-item').length, 1);
    document.getElementById('viewerBtnClearLog').click();
    assert.strictEqual(document.querySelectorAll('#viewerMotionLog .motion-log-item').length, 0);
    assert.strictEqual(document.getElementById('viewerMotionCount').textContent, '0');
    assert.deepStrictEqual(errors, []);
});

test('el supervisor solicita vídeo con la opción constraints de PeerJS aunque no exista captureStream', async (t) => {
    const { app, window } = boot(t);
    const audio = { kind: 'audio', enabled: true, stop() {} };
    const stream = {
        getAudioTracks: () => [audio], getVideoTracks: () => [],
        getTracks: () => [audio], addTrack() {}
    };
    window.navigator.mediaDevices.getUserMedia = async () => stream;
    let options;
    let handlers = {};
    app.peer = { call(code, local, opts) {
        options = opts;
        return { peer: code, on(name, fn) { handlers[name] = fn; return this; }, close() {} };
    } };
    const pending = app.attemptVideoCall('ABCDEF');
    await waitFor(() => handlers.stream);
    assert.equal(options.constraints.offerToReceiveVideo, true);
    assert.equal(options.constraints.offerToReceiveAudio, true);
    assert.equal(options.offerOptions, undefined);
    handlers.stream(makeStream());
    await pending;
    app.disconnectFromEmitter();
});

test('los eventos repetidos de pistas no reinician el vídeo remoto y no lo silencian', (t) => {
    const { app } = boot(t);
    const stream = makeStream();
    let starts = 0;
    app.startUptimeTimer = () => { starts++; };
    app.startConnectionStatsMonitoring = () => {};
    app.handleRemoteStream(stream);
    assert.equal(app.elements.remoteVideo.hasAttribute('muted'), false);
    assert.equal(app.elements.remoteVideo.muted, false);
    assert.equal(typeof app.elements.remoteVideo.onloadedmetadata, 'function');
    app.handleRemoteStream(stream);
    assert.equal(starts, 1);
    app.disconnectFromEmitter();
});

/* ==========================================================================
 * 4. Conexión a distancia y varios supervisores
 * ======================================================================== */

test('por defecto la conexión es directa: STUN sin ningún relé de terceros', (t) => {
    const { app, document } = boot(t);

    const ice = app.config.peerServer.config.iceServers;
    assert.ok(Array.isArray(ice) && ice.length > 0, 'faltan servidores ICE');
    assert.strictEqual(app.iceServers, ice);

    const urls = ice.flatMap(server => (Array.isArray(server.urls) ? server.urls : [server.urls]));
    assert.ok(urls.some(url => url.startsWith('stun:')), 'hace falta STUN para la ruta directa');
    assert.ok(urls.every(url => url.startsWith('stun:')), 'no debe haber TURN activado por defecto');
    assert.strictEqual(app.config.peerServer.config.iceTransportPolicy, 'all');
    assert.strictEqual(document.getElementById('iceSummary').textContent, 'Conexión directa');
});

test('la configuración de PeerJS se aplica también a la instancia creada al conectar', async (t) => {
    const { app, window } = boot(t);
    const original = window.Peer;
    let received = null;

    window.Peer = function (id, options) {
        received = options;
        return new original(id, options);
    };

    await app.setViewerMode();
    assert.ok(received, 'no se creó Peer con opciones');
    assert.strictEqual(received.config, app.config.peerServer.config);
    assert.ok(Array.isArray(received.config.iceServers) && received.config.iceServers.length > 0);
});

test('el formulario de conexión a distancia guarda y aplica un TURN propio', async (t) => {
    const { app, window, document, errors } = boot(t);

    document.getElementById('btnIceSettings').click();
    assert.strictEqual(document.getElementById('iceModal').classList.contains('hidden'), false);

    document.getElementById('iceTurnUrls').value = 'turn:mi-relay.com:3478';
    document.getElementById('iceTurnUsername').value = 'usuario';
    document.getElementById('iceTurnCredential').value = 'secreto';
    await app.saveIceSettings();

    assert.strictEqual(document.getElementById('iceModal').classList.contains('hidden'), true);
    assert.strictEqual(app.config.peerServer.config.iceServers, app.iceServers);
    assert.ok(app.iceServers.some(server =>
        server.urls === 'turn:mi-relay.com:3478' &&
        server.username === 'usuario' &&
        server.credential === 'secreto'
    ), 'el TURN propio no llegó a la configuración ICE');

    const stored = JSON.parse(window.localStorage.getItem('visionIceServers'));
    assert.strictEqual(stored.customTurn.urls, 'turn:mi-relay.com:3478');
    assert.deepStrictEqual(errors, []);
});

test('una configuración de TURN incompleta se rechaza sin tocar la conexión', (t) => {
    const { app, document } = boot(t);
    const before = app.config.peerServer.config.iceServers;

    document.getElementById('iceTurnUrls').value = 'turn:mi-relay.com:3478';
    document.getElementById('iceTurnUsername').value = '';
    document.getElementById('iceTurnCredential').value = '';
    app.saveIceSettings();

    assert.strictEqual(app.config.peerServer.config.iceServers, before, 'no debe cambiar la configuración');
    assert.ok(document.querySelector('#notificationContainer .notification.warning'),
        'debe avisar del error');
});

test('restablecer devuelve la configuración al relé público', (t) => {
    const { app, document } = boot(t);

    document.getElementById('iceTurnUrls').value = 'turn:mi-relay.com:3478';
    document.getElementById('iceTurnUsername').value = 'usuario';
    document.getElementById('iceTurnCredential').value = 'secreto';
    app.saveIceSettings();

    app.resetIceSettings();

    assert.ok(app.iceServers.some(server => String(server.urls).includes('openrelay')));
    assert.ok(!app.iceServers.some(server => String(server.urls).includes('mi-relay.com')));
});

test('el emisor atiende a varios supervisores y el cambio de cámara llega a todos', async (t) => {
    const { app, errors } = boot(t);
    await app.setEmitterMode();
    await app.startEmitter();

    const makeCall = (peer) => {
        const handlers = {};
        const sender = {
            track: { kind: 'video' },
            replaced: null,
            replaceTrack(track) { this.replaced = track; }
        };
        return {
            peer,
            answeredWith: null,
            closed: false,
            sender,
            // Devuelve siempre la misma instancia, como un RTCRtpSender real.
            peerConnection: { getSenders: () => [sender] },
            on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); return this; },
            answer(stream) { this.answeredWith = stream; },
            close() { this.closed = true; (handlers.close || []).forEach(handler => handler()); }
        };
    };

    const first = makeCall('supervisor-A');
    const second = makeCall('supervisor-B');

    app.handleIncomingCall(first);
    app.handleIncomingCall(second);

    assert.strictEqual(first.answeredWith, app.localStream);
    assert.strictEqual(second.answeredWith, app.localStream);
    assert.strictEqual(app.viewerCalls.size, 2, 'deben quedar registradas las dos llamadas');
    assert.ok(app.state.connectedViewers.has('supervisor-A'));
    assert.ok(app.state.connectedViewers.has('supervisor-B'));

    app.applyVideoTrackToCalls({ kind: 'video', label: 'nueva cámara' });
    assert.strictEqual(first.sender.replaced && first.sender.replaced.label, 'nueva cámara');
    assert.strictEqual(second.sender.replaced && second.sender.replaced.label, 'nueva cámara');

    app.stopEmitter();
    assert.strictEqual(first.closed, true, 'al detener se cierra la llamada de A');
    assert.strictEqual(second.closed, true, 'al detener se cierra la llamada de B');
    assert.strictEqual(app.viewerCalls.size, 0);
    assert.deepStrictEqual(errors, []);
});

test('la ruta se muestra como relé cuando ICE elige un candidato TURN', async (t) => {
    const { app } = boot(t);

    const peerConnection = {
        getStats: async () => new Map([
            ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' }],
            ['l', { id: 'l', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' }],
            ['r', { id: 'r', type: 'remote-candidate', candidateType: 'host' }]
        ])
    };

    const route = await app.detectConnectionRoute(peerConnection);
    // `deepEqual` (no `deepStrictEqual`): el objeto nace en el realm de jsdom.
    assert.deepEqual({ ...route }, { type: 'relay', relay: true, protocol: 'udp' });
    assert.strictEqual(app.applyConnectionRoute(route), 'Relé (TURN)');
    assert.strictEqual(app.elements.connectionRouteValue.textContent, 'Relé (TURN)');
});

test('una conexión directa se identifica como tal y no rompe si getStats falla', async (t) => {
    const { app } = boot(t);

    const direct = {
        getStats: async () => new Map([
            ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' }],
            ['l', { id: 'l', type: 'local-candidate', candidateType: 'srflx' }],
            ['r', { id: 'r', type: 'remote-candidate', candidateType: 'srflx' }]
        ])
    };
    assert.strictEqual((await app.detectConnectionRoute(direct)).relay, false);

    const broken = { getStats: async () => { throw new Error('sin permiso'); } };
    assert.strictEqual(await app.detectConnectionRoute(broken), null);
    assert.strictEqual(await app.detectConnectionRoute(null), null);
});

test('«Probar relé» informa de éxito cuando llega un candidato TURN y de fallo si no', async (t) => {
    const { app, window, document } = boot(t);

    let behavior = 'relay';
    window.RTCPeerConnection = function () {
        const pc = {
            iceGatheringState: 'gathering',
            onicecandidate: null,
            onicegatheringstatechange: null,
            createDataChannel() {},
            createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
            setLocalDescription: async () => {
                setTimeout(() => {
                    if (behavior === 'relay' && pc.onicecandidate) {
                        pc.onicecandidate({ candidate: { type: 'relay', candidate: 'candidate:relay' } });
                    }
                    pc.iceGatheringState = 'complete';
                    if (pc.onicegatheringstatechange) pc.onicegatheringstatechange();
                }, 0);
            },
            close() { this.closed = true; }
        };
        return pc;
    };

    const ok = await app.checkTurnAvailability(app.iceServers);
    assert.strictEqual(ok.ok, true);

    behavior = 'none';
    const failed = await app.checkTurnAvailability(app.iceServers);
    assert.strictEqual(failed.ok, false);
    assert.ok(failed.error, 'debe explicar el fallo');

    // Sin RTCPeerConnection disponible no debe lanzar.
    window.RTCPeerConnection = undefined;
    window.webkitRTCPeerConnection = undefined;
    const unsupported = await app.checkTurnAvailability(app.iceServers);
    assert.strictEqual(unsupported.ok, false);
    assert.ok(document.getElementById('iceStatus'));
});
