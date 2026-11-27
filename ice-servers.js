/* ============================================================================
 * ice-servers.js — Servidores ICE (STUN + TURN opcional) para Visión Remota
 * ----------------------------------------------------------------------------
 * Módulo independiente y sin dependencias externas.
 *
 * CÓMO VIAJA EL VÍDEO
 *   Por defecto la aplicación es 100 % DIRECTA (P2P): la cámara del emisor va
 *   al supervisor sin pasar por ningún servidor de medios y sin cuotas. Para
 *   descubrir la dirección pública de cada dispositivo se usa STUN, que es un
 *   servicio ligero y gratuito (sólo responde "tu IP y puerto son estos"): no
 *   transporta ni almacena el vídeo.
 *
 *   Con STUN, la inmensa mayoría de las redes domésticas y móviles permiten
 *   esa conexión directa desde otra red. Falla cuando alguno de los dos equipos
 *   está detrás de un NAT simétrico / CGNAT muy restrictivo o de un
 *   cortafuegos que bloquea todo tráfico entrante: en ese caso no existe ruta
 *   directa posible y el vídeo sólo puede pasar por un relé TURN.
 *
 * EL RELÉ (TURN) ES OPCIONAL
 *   Por eso aquí NO se activa ningún TURN de terceros por defecto: nada de
 *   cuotas ajenas. Si una red concreta no conecta, el usuario puede:
 *   - activar el relé público gratuito (cuota compartida, para salir del paso), o
 *   - indicar su propio servidor TURN (coturn en un equipo propio, sin límites
 *     ni pagos, o un proveedor con plan gratuito si prefiere no administrarlo).
 *
 * QUÉ HACE ESTE MÓDULO
 *   1. Ofrece la lista por defecto de STUN públicos (ruta directa).
 *   2. Permite añadir un TURN propio o activar el público, siempre a mano.
 *   3. Nunca lanza excepciones: si localStorage falla o los datos son basura,
 *      siempre devuelve una configuración válida.
 *
 * FILOSOFÍA: sólo construye datos. No toca la cámara, ni el MediaStream, ni la
 * RTCPeerConnection. `script.js` es quien pasa el resultado a PeerJS.
 * ========================================================================== */
(function (root, factory) {
    const api = factory();

    if (root) {
        root.IceServers = api.IceServers;
        root.ICE_SERVERS_API = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STORAGE_KEY = 'visionIceServers';

    /* ======================================================================
     * Servidores públicos por defecto
     * ==================================================================== */

    /**
     * STUN: sólo descubren la dirección pública. Son gratuitos y ligeros, así
     * que se incluyen varios para tener redundancia.
     */
    const DEFAULT_STUN_URLS = [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun.cloudflare.com:3478'
    ];

    /**
     * TURN público: SÓLO se usa si el usuario lo activa expresamente, porque
     * es un servicio de terceros con cuota (Open Relay de Metered, pensado
     * para prototipos). La conexión por defecto no depende de él.
     *
     * Se usan los puertos 80 y 443 (y también TCP) porque son los que casi
     * ningún cortafuegos bloquea.
     */
    const DEFAULT_TURN_SERVERS = [
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            // TURN sobre TCP: atraviesa cortafuegos que bloquean UDP.
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ];

    const DEFAULT_ICE_SERVERS = [
        ...DEFAULT_STUN_URLS.map(urls => ({ urls })),
        ...DEFAULT_TURN_SERVERS
    ];

    /* ======================================================================
     * Utilidades de validación
     * ==================================================================== */

    const TURN_PROTOCOL = /^turns?:/i;

    /** Convierte cualquier cosa en texto recortado. */
    const clean = (value) => (typeof value === 'string' ? value.trim() : '');

    /**
     * Un TURN necesita host y usuario/contraseña. Se aceptan varias URL en el
     * mismo campo separadas por comas o espacios.
     */
    function parseTurnUrls(value) {
        const urls = String(value || '')
            .split(/[\s,]+/)
            .map(clean)
            .filter(Boolean);

        const invalids = urls.filter(url => !TURN_PROTOCOL.test(url) || !/^turns?:[^:]/i.test(url));
        if (urls.length === 0) {
            return { urls: [], error: 'Indica al menos una URL de TURN, por ejemplo turn:turn.ejemplo.com:3478' };
        }
        if (invalids.length > 0) {
            return {
                urls: [],
                error: 'URL no válida: ' + invalids[0] + '. Debe empezar por turn: o turns:'
            };
        }

        return { urls, error: null };
    }

    /** Acepta un objeto `{urls, username, credential}` o lo descarta. */
    function normalizeServer(server) {
        if (!server || typeof server !== 'object') return null;

        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        const validUrls = urls.map(clean).filter(Boolean);
        if (validUrls.length === 0) return null;

        const entry = { urls: validUrls.length === 1 ? validUrls[0] : validUrls };

        const username = clean(server.username);
        const credential = clean(server.credential || server.password);
        if (username) entry.username = username;
        if (credential) entry.credential = credential;

        return entry;
    }

    /* ======================================================================
     * API
     * ==================================================================== */

    const IceServers = {
        STORAGE_KEY,
        DEFAULT_ICE_SERVERS,
        DEFAULT_STUN_URLS,
        DEFAULT_TURN_SERVERS,
        parseTurnUrls,
        normalizeServer,

        /** Configuración vacía (STUN + TURN públicos por defecto). */
        emptyCustomTurn() {
            return { urls: '', username: '', credential: '' };
        },

        /**
         * Preferencias guardadas. Sin nada guardado, la conexión es directa:
         * `includeDefaultTurn` empieza en false para no depender de terceros.
         */
        load(storage) {
            const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
            const base = {
                customTurn: IceServers.emptyCustomTurn(),
                includeDefaultTurn: false
            };

            if (!store) return base;

            let raw = null;
            try {
                raw = store.getItem(STORAGE_KEY);
            } catch (error) {
                return base;
            }

            if (!raw) return base;

            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object') return base;

                const turn = parsed.customTurn && typeof parsed.customTurn === 'object'
                    ? parsed.customTurn
                    : {};

                return {
                    customTurn: {
                        urls: clean(turn.urls),
                        username: clean(turn.username),
                        credential: clean(turn.credential)
                    },
                    includeDefaultTurn: parsed.includeDefaultTurn === true
                };
            } catch (error) {
                return base;
            }
        },

        /** Guarda la configuración sin lanzar nunca una excepción. */
        save(settings, storage) {
            const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
            const value = {
                customTurn: {
                    urls: clean(settings && settings.customTurn && settings.customTurn.urls),
                    username: clean(settings && settings.customTurn && settings.customTurn.username),
                    credential: clean(settings && settings.customTurn && settings.customTurn.credential)
                },
                includeDefaultTurn: Boolean(settings && settings.includeDefaultTurn)
            };

            if (!store) return value;

            try {
                store.setItem(STORAGE_KEY, JSON.stringify(value));
            } catch (error) {
                /* almacenamiento lleno o bloqueado: la app sigue funcionando */
            }

            return value;
        },

        /**
         * Construye la lista definitiva de servidores ICE.
         * @param {Object} [settings] resultado de load() o equivalente
         * @returns {Array<Object>} lista lista para `iceServers`
         */
        build(settings) {
            const config = settings && typeof settings === 'object' ? settings : {};
            const customTurn = config.customTurn && typeof config.customTurn === 'object'
                ? config.customTurn
                : {};

            const servers = DEFAULT_STUN_URLS.map(urls => ({ urls }));

            if (config.includeDefaultTurn === true) {
                servers.push(...DEFAULT_TURN_SERVERS);
            }

            const parsed = parseTurnUrls(customTurn.urls);
            if (parsed.error === null && parsed.urls.length > 0) {
                const username = clean(customTurn.username);
                const credential = clean(customTurn.credential);
                const entry = { urls: parsed.urls.length === 1 ? parsed.urls[0] : parsed.urls };
                if (username) entry.username = username;
                if (credential) entry.credential = credential;
                servers.push(entry);
            }

            return servers;
        },

        /** true si la lista contiene al menos un TURN (relé) utilizable. */
        hasTurn(servers) {
            const list = Array.isArray(servers) ? servers : DEFAULT_ICE_SERVERS;
            return list.some(server => {
                const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
                return urls.some(url => TURN_PROTOCOL.test(String(url || ''))) &&
                    Boolean(server.username) && Boolean(server.credential || server.password);
            });
        },

        /**
         * Valida lo escrito en el formulario.
         * @returns {{ok: boolean, error: string|null}}
         */
        validateCustomTurn(customTurn) {
            const turn = customTurn || {};
            const urls = clean(turn.urls);

            if (!urls) return { ok: true, error: null }; // vacío = usar sólo los públicos

            const parsed = parseTurnUrls(urls);
            if (parsed.error) return { ok: false, error: parsed.error };

            if (!clean(turn.username)) {
                return { ok: false, error: 'El servidor TURN necesita un usuario' };
            }
            if (!clean(turn.credential)) {
                return { ok: false, error: 'El servidor TURN necesita una contraseña o credencial' };
            }

            return { ok: true, error: null };
        }
    };

    return { IceServers };
});
