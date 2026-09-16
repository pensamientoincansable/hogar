'use strict';
/* ============================================================================
 * Pruebas del motor de detección y del sistema de alarmas (sin navegador).
 * Ejecutar con:  npm test      (o  node --test tests/ )
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');

const {
    MotionDetector,
    AlarmSystem,
    MOTION_DEFAULTS,
    ALARM_TYPES
} = require('../motion.js');

/* --------------------------------------------------------------------------
 * Utilidades de prueba
 * ------------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Canvas falso con fotogramas sintéticos, para no depender de un navegador.
 * mode = 'moving' → un cuadrado blanco se desplaza (hay movimiento)
 * mode = 'static' → la imagen no cambia (no hay movimiento)
 */
function createFakeCanvas() {
    let frame = 0;
    const fake = { mode: 'moving', frames: 0, canvas: null };

    const ctx = {
        drawImage() { /* el "vídeo" ya está en la imagen sintética */ },
        getImageData(x, y, width, height) {
            frame++;
            fake.frames = frame;

            const data = new Uint8ClampedArray(width * height * 4);
            const offset = fake.mode === 'moving' ? (frame % 6) * 8 : 0;

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

    fake.canvas = {
        width: 160,
        height: 120,
        getContext: () => ctx
    };

    return fake;
}

/* ==========================================================================
 * Cálculo puro
 * ======================================================================== */

test('toGray convierte RGBA a luminancia', () => {
    const rgba = new Uint8ClampedArray([
        255, 255, 255, 255,   // blanco
        0, 0, 0, 255,         // negro
        255, 0, 0, 255        // rojo puro
    ]);

    const gray = MotionDetector.toGray(rgba);

    assert.strictEqual(gray.length, 3);
    assert.strictEqual(gray[0], 255);
    assert.strictEqual(gray[1], 0);
    assert.strictEqual(gray[2], 76);
});

test('sensitivityToThreshold es monótona y respeta los límites', () => {
    const values = [];
    for (let s = 1; s <= 10; s++) values.push(MotionDetector.sensitivityToThreshold(s));

    assert.ok(Math.abs(values[0] - 0.06) < 1e-9, 'sensibilidad 1 → 6% de la imagen');

    for (let i = 1; i < values.length; i++) {
        assert.ok(values[i] < values[i - 1], 'a más sensibilidad, menor umbral');
    }

    for (const value of values) {
        assert.ok(value >= 0.001 && value <= 0.12, 'umbral dentro de rango razonable');
    }

    assert.ok(
        MotionDetector.sensitivityToThreshold(6) < MotionDetector.sensitivityToThreshold(3),
        'sensibilidad alta detecta cambios más pequeños'
    );
});

test('analyzeFrames no ve movimiento en fotogramas idénticos', () => {
    const frame = new Uint8Array(160 * 120).fill(80);
    const result = MotionDetector.analyzeFrames(frame, frame.slice(), { pixelThreshold: 26 });

    assert.strictEqual(result.changed, 0);
    assert.strictEqual(result.ratio, 0);
});

test('analyzeFrames detecta un objeto en movimiento', () => {
    const width = 160;
    const height = 120;
    const before = new Uint8Array(width * height).fill(40);
    const after = new Uint8Array(width * height).fill(40);

    // Cuadrado de 20x30 px (600 px = 3.1% de la imagen) en otra posición
    for (let row = 20; row < 50; row++) {
        for (let col = 60; col < 80; col++) {
            after[row * width + col] = 240;
        }
    }

    const result = MotionDetector.analyzeFrames(before, after, { pixelThreshold: 26 });

    assert.strictEqual(result.changed, 600);
    assert.ok(result.ratio > 0.03 && result.ratio < 0.032, 'ratio ≈ 3.1%');
    assert.ok(
        result.ratio > MotionDetector.sensitivityToThreshold(6),
        'el movimiento supera el umbral por defecto'
    );
});

test('analyzeFrames ignora los cambios globales de luz (falsos positivos)', () => {
    const width = 160;
    const height = 120;
    const before = new Uint8Array(width * height).fill(100);
    const after = new Uint8Array(width * height).fill(140); // sube la luz en toda la escena

    const compensated = MotionDetector.analyzeFrames(before, after, {
        pixelThreshold: 26,
        lightCompensation: 0.6
    });
    const uncompensated = MotionDetector.analyzeFrames(before, after, {
        pixelThreshold: 26,
        lightCompensation: 0
    });

    assert.strictEqual(compensated.changed, 0, 'con compensación no hay falsos positivos');
    assert.strictEqual(uncompensated.changed, width * height, 'sin compensación toda la imagen cambia');
});

test('analyzeFrames es defensivo con entradas inválidas', () => {
    const frame = new Uint8Array(100);

    assert.deepStrictEqual(
        MotionDetector.analyzeFrames(null, frame, {}),
        { ratio: 0, changed: 0, energy: 0, meanDelta: 0 }
    );
    assert.deepStrictEqual(
        MotionDetector.analyzeFrames(frame, new Uint8Array(50), {}),
        { ratio: 0, changed: 0, energy: 0, meanDelta: 0 }
    );
});

/* ==========================================================================
 * Máquina de estados del detector
 * ======================================================================== */

test('el detector arranca, analiza y se detiene limpiamente', async () => {
    const fake = createFakeCanvas();
    const started = [];
    const statuses = [];

    const detector = new MotionDetector({
        intervalMs: 80,
        sensitivity: 6,
        consecutiveFrames: 2,
        cooldownMs: 200,
        motionHoldMs: 200,
        canvasFactory: () => fake.canvas
    });

    detector.on({
        onMotionStart: (event) => started.push(event),
        onStatus: (status) => statuses.push(status)
    });

    const video = { readyState: 4, videoWidth: 160, videoHeight: 120 };
    assert.strictEqual(detector.start(video), true);
    assert.strictEqual(detector.isRunning, true);

    await sleep(500);
    detector.stop();

    assert.strictEqual(detector.isRunning, false);
    assert.strictEqual(detector.status, 'idle');
    assert.ok(started.length >= 1, 'debe detectar el movimiento');
    assert.ok(fake.frames >= 4, 'debe haber analizado varios fotogramas');
    assert.ok(statuses.includes('analyzing'), 'debe pasar por el estado "analizando"');
    assert.ok(started[0].percent > 0, 'el evento incluye el porcentaje de imagen cambiada');
    assert.ok(typeof started[0].snapshot === 'function', 'el evento ofrece captura de evidencia');
});

test('el enfriamiento evita ráfagas de alarmas', async () => {
    const fake = createFakeCanvas();
    const events = [];

    const detector = new MotionDetector({
        intervalMs: 80,
        cooldownMs: 5000,   // 5 s de silencio entre alarmas
        consecutiveFrames: 2,
        canvasFactory: () => fake.canvas
    });

    detector.on({ onMotionStart: (event) => events.push(event) });
    detector.start({ readyState: 4, videoWidth: 160, videoHeight: 120 });

    await sleep(600);
    detector.stop();

    assert.strictEqual(events.length, 1, 'con 5 s de silencio sólo puede dispararse una vez');
});

test('no dispara con imagen estática', async () => {
    const fake = createFakeCanvas();
    fake.mode = 'static';

    const events = [];
    const detector = new MotionDetector({
        intervalMs: 80,
        canvasFactory: () => fake.canvas
    });

    detector.on({ onMotionStart: (event) => events.push(event) });
    detector.start({ readyState: 4, videoWidth: 160, videoHeight: 120 });

    await sleep(500);
    detector.stop();

    assert.strictEqual(events.length, 0);
    assert.ok(fake.frames > 3, 'el análisis sí se ejecutó');
});

test('el detector se comporta si no hay vídeo listo', async () => {
    const statuses = [];
    const detector = new MotionDetector({ intervalMs: 80, canvasFactory: () => createFakeCanvas().canvas });

    detector.on({ onStatus: (status) => statuses.push(status) });
    detector.start({ readyState: 0, videoWidth: 0, videoHeight: 0 });

    await sleep(200);
    detector.stop();

    assert.ok(statuses.includes('waiting'), 'queda esperando al vídeo');
});

test('un fallo al leer fotogramas detiene el análisis sin lanzar excepciones', async () => {
    const errors = [];
    let calls = 0;

    const canvas = {
        width: 160,
        height: 120,
        getContext: () => ({
            drawImage() { calls++; },
            getImageData() {
                const error = new Error('canvas bloqueado');
                error.name = 'SecurityError';
                throw error;
            }
        })
    };

    const detector = new MotionDetector({ intervalMs: 80, canvasFactory: () => canvas });
    detector.on({ onError: (error) => errors.push(error) });
    detector.start({ readyState: 4, videoWidth: 160, videoHeight: 120 });

    await sleep(250);

    assert.strictEqual(detector.isRunning, false, 'se detiene solo');
    assert.strictEqual(detector.status, 'error');
    assert.strictEqual(errors.length, 1, 'avisa del problema una sola vez');
    assert.ok(calls > 0);
});

test('update() cambia sensibilidad, ritmo y enfriamiento en caliente', async () => {
    const fake = createFakeCanvas();
    const detector = new MotionDetector({
        intervalMs: 80,
        sensitivity: 2,
        canvasFactory: () => fake.canvas
    });

    const events = [];
    detector.on({ onMotionStart: (event) => events.push(event) });

    const before = detector.threshold;
    detector.update({ sensitivity: 9, intervalMs: 150, cooldownMs: 20000 });

    assert.ok(detector.threshold < before, 'más sensibilidad → umbral menor');
    assert.strictEqual(detector.options.cooldownMs, 20000);

    detector.start({ readyState: 4, videoWidth: 160, videoHeight: 120 });
    await sleep(1100);  // 2 fotogramas de calibración + 2 de confirmación a 150 ms
    detector.stop();

    assert.ok(events.length >= 1, 'con el nuevo umbral sí detecta');
});

/* ==========================================================================
 * Sistema de alarmas
 * ======================================================================== */

test('el sistema de alarmas conoce todos los tipos soportados', () => {
    assert.deepStrictEqual(
        ALARM_TYPES,
        ['siren', 'beep', 'voice', 'vibrate', 'flash', 'notify', 'remote', 'remote-react']
    );

    const system = new AlarmSystem({ types: ['siren', 'inexistente'] });
    assert.strictEqual(system.hasType('siren'), true);
    assert.strictEqual(system.hasType('inexistente'), false);

    system.setType('beep', true);
    system.setType('siren', false);
    assert.strictEqual(system.hasType('beep'), true);
    assert.strictEqual(system.hasType('siren'), false);
});

test('no hay alarma sin tipos activados', () => {
    const system = new AlarmSystem({ types: [] });
    assert.deepStrictEqual(system.trigger({ source: 'local' }), []);
    assert.strictEqual(system.isRinging, false);
});

test('la alarma remota se envía una vez y nunca en bucle', () => {
    const sent = [];
    const system = new AlarmSystem({
        types: ['remote', 'remote-react'],
        onRemoteAlert: (payload) => sent.push(payload)
    });

    // Movimiento local → se avisa al otro dispositivo
    const applied = system.trigger({ source: 'local', percent: 2.5, thresholdPercent: 1.2 });
    assert.deepStrictEqual(applied, ['remote']);
    assert.strictEqual(sent.length, 1);

    // Movimiento remoto → NO se reenvía (evita el bucle entre dispositivos)
    system.trigger({ source: 'remote', percent: 2.5 });
    assert.strictEqual(sent.length, 1, 'un aviso remoto no genera otro aviso');
});

test('la sirena usa WebAudio y se puede detener', () => {
    const created = [];

    class FakeNode {
        constructor(kind) {
            this.kind = kind;
            this.frequency = { value: 0 };
            this.gain = {
                value: 0,
                setValueAtTime: () => {},
                exponentialRampToValueAtTime: () => {}
            };
            this.type = '';
            this.started = false;
            this.stopped = false;
            created.push(this);
        }
        connect() { return this; }
        disconnect() {}
        start() { this.started = true; }
        stop() { this.stopped = true; }
    }

    class FakeAudioContext {
        constructor() {
            this.state = 'running';
            this.currentTime = 0;
            this.destination = new FakeNode('destination');
        }
        createOscillator() { return new FakeNode('oscillator'); }
        createGain() { return new FakeNode('gain'); }
        createBiquadFilter() { return new FakeNode('filter'); }
        resume() { return Promise.resolve(); }
    }

    const previousWindow = global.window;
    global.window = { AudioContext: FakeAudioContext };

    try {
        const system = new AlarmSystem({ types: ['siren'], volume: 0.8 });
        const applied = system.trigger({ source: 'local' });

        assert.deepStrictEqual(applied, ['siren']);
        assert.ok(created.some((node) => node.kind === 'oscillator' && node.started), 'la sirena arranca');
        assert.strictEqual(system.isRinging, true);

        system.stop();

        assert.strictEqual(system.isRinging, false);
        assert.ok(
            created.filter((node) => node.kind === 'oscillator').every((node) => node.stopped),
            'detener la alarma apaga los osciladores'
        );
    } finally {
        if (previousWindow === undefined) delete global.window;
        else global.window = previousWindow;
    }
});

test('la sirena continua sigue activa hasta detenerla y se limita en el tiempo', async () => {
    const system = new AlarmSystem({ types: ['siren'], continuous: true, maxContinuousMs: 900 });
    assert.strictEqual(system.continuous, true);

    system.trigger({ source: 'local' });

    await sleep(400);
    assert.strictEqual(system.isRinging, true, 'sigue sonando pasado el aviso visual (4 s)');

    system.stop();
    assert.strictEqual(system.isRinging, false, 'se detiene al pulsar el botón');

    // Con límite de seguridad: se apaga solo aunque nadie lo detenga
    system.trigger({ source: 'local' });
    await sleep(1100);
    assert.strictEqual(system.isRinging, false, 'el límite de seguridad la apaga');
});

test('sin modo continuo la alarma termina sola', async () => {
    const system = new AlarmSystem({ types: ['siren'], continuous: false });
    system.trigger({ source: 'local' });
    assert.strictEqual(system.isRinging, true);

    await sleep(4300);
    assert.strictEqual(system.isRinging, false, 'termina tras el aviso');
});

test('las alarmas no dependen de APIs inexistentes (sin navegador)', () => {
    // En Node no hay Notification, speechSynthesis ni navigator: no debe fallar.
    const system = new AlarmSystem({ types: ['voice', 'notify', 'vibrate', 'flash'] });
    const applied = system.trigger({ source: 'local', percent: 1 });

    assert.deepStrictEqual(applied.sort(), ['flash', 'notify', 'vibrate', 'voice']);
    assert.strictEqual(AlarmSystem.notificationSupported(), false);
});

test('los ajustes por defecto son razonables', () => {
    assert.ok(MOTION_DEFAULTS.intervalMs >= 100, 'el análisis no es agresivo');
    assert.ok(MOTION_DEFAULTS.width * MOTION_DEFAULTS.height <= 320 * 240, 'el canvas es diminuto');
    assert.ok(MOTION_DEFAULTS.consecutiveFrames >= 2, 'exige confirmación en varios fotogramas');
    assert.ok(MOTION_DEFAULTS.cooldownMs >= 5000, 'evita alarmas en ráfaga');
});
