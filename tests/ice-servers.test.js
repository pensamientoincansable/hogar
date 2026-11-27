'use strict';
/* ============================================================================
 * Pruebas del módulo de servidores ICE (STUN + TURN).
 *
 * Objetivo: garantizar que la aplicación SIEMPRE ofrezca un relé TURN (la
 * pieza que permite supervisar desde otra red) y que la configuración del
 * usuario se valide, se guarde y no rompa nada si localStorage falla.
 *
 * Ejecutar con:  npm test
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');

const { IceServers } = require('../ice-servers.js');

/** localStorage en memoria para no depender de jsdom aquí. */
function makeStorage(initial) {
    const data = new Map(Object.entries(initial || {}));
    return {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: (key) => { data.delete(key); },
        __data: data
    };
}

/** localStorage roto: simula modo privado o cuota llena. */
const brokenStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); }
};

const urlsOf = (servers) => servers.flatMap(server =>
    Array.isArray(server.urls) ? server.urls : [server.urls]
);

/* ==========================================================================
 * 1. Relé por defecto
 * ======================================================================== */

test('la configuración por defecto incluye STUN y al menos un TURN con credenciales', () => {
    const servers = IceServers.build();

    assert.ok(Array.isArray(servers) && servers.length > 0);
    const urls = urlsOf(servers);

    assert.ok(urls.some(url => url.startsWith('stun:')), 'faltan servidores STUN');
    assert.ok(urls.some(url => url.startsWith('turn:') || url.startsWith('turns:')), 'falta un relé TURN');

    assert.strictEqual(IceServers.hasTurn(servers), true, 'hasTurn reconoce el relé por defecto');

    const turnServers = servers.filter(server =>
        urlsOf([server]).some(url => /^turns?:/i.test(url))
    );
    assert.ok(turnServers.length > 0);
    for (const server of turnServers) {
        assert.ok(server.username, 'cada TURN necesita usuario');
        assert.ok(server.credential, 'cada TURN necesita credencial');
    }
});

test('el relé por defecto usa el puerto 443 (además del 80) para atravesar cortafuegos', () => {
    const urls = urlsOf(IceServers.build({ includeDefaultTurn: true }));
    assert.ok(urls.some(url => /:443$/.test(url)), 'falta TURN en el 443');
    assert.ok(urls.some(url => /:80$/.test(url)), 'falta TURN en el 80');
});

test('sin TURN se informa claramente de que no hay relé', () => {
    const servers = IceServers.build({ includeDefaultTurn: false, customTurn: {} });
    assert.strictEqual(IceServers.hasTurn(servers), false);
    assert.ok(urlsOf(servers).every(url => url.startsWith('stun:')));
});

/* ==========================================================================
 * 2. Configuración de un TURN propio
 * ======================================================================== */

test('un TURN propio se añade con usuario y contraseña', () => {
    const servers = IceServers.build({
        includeDefaultTurn: false,
        customTurn: {
            urls: 'turn:relay.midominio.com:3478',
            username: 'usuario',
            credential: 'clave'
        }
    });

    assert.strictEqual(IceServers.hasTurn(servers), true);
    const custom = servers.find(server => urlsOf([server]).includes('turn:relay.midominio.com:3478'));
    assert.ok(custom, 'no se añadió el TURN propio');
    assert.strictEqual(custom.username, 'usuario');
    assert.strictEqual(custom.credential, 'clave');
});

test('se aceptan varias URL de TURN en el mismo campo (comas o espacios)', () => {
    const parsed = IceServers.parseTurnUrls('turn:a.com:3478, turns:b.com:443 turns:c.com:5349');
    assert.deepStrictEqual(parsed.urls, ['turn:a.com:3478', 'turns:b.com:443', 'turns:c.com:5349']);
    assert.strictEqual(parsed.error, null);
});

test('una URL que no es TURN se rechaza con un mensaje útil', () => {
    const parsed = IceServers.parseTurnUrls('http://midominio.com');
    assert.strictEqual(parsed.error !== null, true);
    assert.ok(parsed.error.includes('turn:'));
});

test('el formulario exige usuario y contraseña cuando hay URL de TURN', () => {
    assert.deepStrictEqual(
        IceServers.validateCustomTurn({ urls: '', username: '', credential: '' }),
        { ok: true, error: null },
        'sin URL no hay nada que validar'
    );

    assert.strictEqual(
        IceServers.validateCustomTurn({ urls: 'turn:a.com:3478', username: '', credential: '' }).ok,
        false
    );
    assert.strictEqual(
        IceServers.validateCustomTurn({ urls: 'turn:a.com:3478', username: 'u', credential: '' }).ok,
        false
    );
    assert.strictEqual(
        IceServers.validateCustomTurn({ urls: 'turn:a.com:3478', username: 'u', credential: 'c' }).ok,
        true
    );
});

/* ==========================================================================
 * 3. Persistencia tolerante a fallos
 * ======================================================================== */

test('la configuración se guarda y se recupera del almacenamiento', () => {
    const storage = makeStorage();
    IceServers.save({
        includeDefaultTurn: false,
        customTurn: { urls: 'turn:x.com:3478', username: 'u', credential: 'c' }
    }, storage);

    const loaded = IceServers.load(storage);
    assert.strictEqual(loaded.includeDefaultTurn, false);
    assert.deepStrictEqual(loaded.customTurn, {
        urls: 'turn:x.com:3478',
        username: 'u',
        credential: 'c'
    });
});

test('si localStorage falla, la aplicación sigue con la configuración por defecto', () => {
    assert.doesNotThrow(() => IceServers.save({ customTurn: { urls: 'turn:a:1' } }, brokenStorage));

    const loaded = IceServers.load(brokenStorage);
    assert.deepStrictEqual(loaded.customTurn, { urls: '', username: '', credential: '' });
    assert.strictEqual(loaded.includeDefaultTurn, true);
});

test('datos corruptos en localStorage no rompen la carga', () => {
    const storage = makeStorage({ visionIceServers: '{esto no es json' });
    const loaded = IceServers.load(storage);
    assert.strictEqual(loaded.includeDefaultTurn, true);
    assert.strictEqual(IceServers.hasTurn(IceServers.build(loaded)), true);
});

test('una URL de TURN inválida guardada no se inyecta en la configuración ICE', () => {
    const storage = makeStorage();
    IceServers.save({ customTurn: { urls: 'upd:roto', username: 'u', credential: 'c' } }, storage);

    const servers = IceServers.build(IceServers.load(storage));
    assert.ok(urlsOf(servers).every(url => !url.startsWith('upd:')), 'se coló una URL inválida');
});
