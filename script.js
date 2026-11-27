class RemoteVisionApp {
    constructor() {
        // Servidores ICE: STUN para la ruta directa y TURN (relé) para cuando el
        // supervisor está en otra red y el NAT de alguno de los dos impide el
        // P2P. Sin TURN, fuera de la red local la conexión se queda esperando.
        const iceApi = typeof IceServers !== 'undefined' ? IceServers : null;
        this.iceSettings = iceApi
            ? iceApi.load()
            : { customTurn: { urls: '', username: '', credential: '' }, includeDefaultTurn: true };
        this.iceServers = iceApi ? iceApi.build(this.iceSettings) : [];

        // Configuración mejorada con servidores STUN + TURN
        this.config = {
            peerServer: {
                host: '0.peerjs.com',
                port: 443,
                path: '/',
                secure: true,
                debug: 2,
                config: {
                    iceServers: this.iceServers,
                    iceTransportPolicy: 'all',
                    // Recoge candidatos de antemano (STUN y TURN) para no
                    // dejar la negociación a medias en redes lentas.
                    iceCandidatePoolSize: 4
                }
            },
            videoQuality: {
                low: { width: 640, height: 480, frameRate: 15 },
                medium: { width: 1280, height: 720, frameRate: 30 },
                high: { width: 1920, height: 1080, frameRate: 30 }
            }
        };

        // Estado de la aplicación
        this.state = {
            isEmitter: false,
            isViewer: false,
            isConnected: false,
            isStreaming: false,
            isStartingStream: false,
            isConnecting: false,
            isAudioEnabled: false,
            isFrontCamera: true,
            isFlipped: false,
            currentCode: null,
            displayCode: null,
            peerId: null,
            hostPeerId: null,
            connectedViewers: new Set(),
            recentCodes: JSON.parse(localStorage.getItem('recentCodes')) || [],
            settings: JSON.parse(localStorage.getItem('visionSettings')) || {
                videoQuality: 'medium',
                autoReconnect: true
            },
            connectionAttempts: 0
        };

        // Instancias
        this.peer = null;
        this.localStream = null;
        this.remoteStream = null;
        this.currentCall = null;
        this.dataConnection = null;
        this.mediaDevices = [];
        this.currentDeviceId = null;
        this.connectionTimer = null;
        this.uptimeInterval = null;
        this.connectionStartTime = null;
        this.statsInterval = null;
        this.localAudioStream = null;
        this.connectionTimeouts = [];
        this.supervisorAudioElement = null;
        this.supervisorAudioElements = new Map();
        this.pendingIncomingCalls = new Map();
        // Llamadas de vídeo activas por supervisor (soporta varios a la vez).
        this.viewerCalls = new Map();
        // Último diagnóstico ICE de la conexión del supervisor.
        this.connectionRoute = null;
        this.routeCheckTimeout = null;

        // La detección de movimiento se ejecuta únicamente en el supervisor.
        this.motionPanels = null;
        this.dataConnections = new Map();

        // Elementos del DOM
        this.elements = {
            modeSelection: document.getElementById('modeSelection'),
            emitterPanel: document.getElementById('emitterPanel'),
            viewerPanel: document.getElementById('viewerPanel'),
            
            btnEmitter: document.getElementById('btnEmitter'),
            btnViewer: document.getElementById('btnViewer'),
            
            backFromEmitter: document.getElementById('backFromEmitter'),
            localVideo: document.getElementById('localVideo'),
            emitterCode: document.getElementById('emitterCode'),
            emitterCodeStatus: document.getElementById('emitterCodeStatus'),
            btnStartEmitter: document.getElementById('btnStartEmitter'),
            btnStopEmitter: document.getElementById('btnStopEmitter'),
            btnCopyCode: document.getElementById('btnCopyCode'),
            btnRefreshCode: document.getElementById('btnRefreshCode'),
            btnSwitchCamera: document.getElementById('btnSwitchCamera'),
            btnFlipCamera: document.getElementById('btnFlipCamera'),
            btnAudioToggle: document.getElementById('btnAudioToggle'),
            videoQuality: document.getElementById('videoQuality'),
            emitterStatusBadge: document.getElementById('emitterStatusBadge'),
            connectedClients: document.getElementById('connectedClients'),
            qualityTag: document.getElementById('qualityTag'),
            
            backFromViewer: document.getElementById('backFromViewer'),
            peerCodeInput: document.getElementById('peerCodeInput'),
            btnConnect: document.getElementById('btnConnect'),
            remoteVideo: document.getElementById('remoteVideo'),
            connectionOverlay: document.getElementById('connectionOverlay'),
            connectionPromptTitle: document.getElementById('connectionPromptTitle'),
            connectionPromptText: document.getElementById('connectionPromptText'),
            btnFullscreen: document.getElementById('btnFullscreen'),
            btnTakeSnapshot: document.getElementById('btnTakeSnapshot'),
            btnMuteAudio: document.getElementById('btnMuteAudio'),
            btnStartAudio: document.getElementById('btnStartAudio'),
            btnStopAudio: document.getElementById('btnStopAudio'),
            btnTestAudio: document.getElementById('btnTestAudio'),
            remoteVolume: document.getElementById('remoteVolume'),
            viewerStatusBadge: document.getElementById('viewerStatusBadge'),
            connectionStats: document.getElementById('connectionStats'),
            uptime: document.getElementById('uptime'),
            connectionState: document.getElementById('connectionState'),
            latencyValue: document.getElementById('latencyValue'),
            recentCodes: document.getElementById('recentCodes'),
            connectionDetails: document.getElementById('connectionDetails'),
            connectionRouteValue: document.getElementById('connectionRouteValue'),

            // Conexión a distancia (servidor TURN / relé)
            btnIceSettings: document.getElementById('btnIceSettings'),
            iceModal: document.getElementById('iceModal'),
            iceModalBody: document.getElementById('iceModalBody'),
            iceClose: document.getElementById('iceClose'),
            iceSummary: document.getElementById('iceSummary'),
            iceStatus: document.getElementById('iceStatus'),
            iceTurnUrls: document.getElementById('iceTurnUrls'),
            iceTurnUsername: document.getElementById('iceTurnUsername'),
            iceTurnCredential: document.getElementById('iceTurnCredential'),
            iceUsePublicRelay: document.getElementById('iceUsePublicRelay'),
            btnIceSave: document.getElementById('btnIceSave'),
            btnIceReset: document.getElementById('btnIceReset'),
            btnIceTest: document.getElementById('btnIceTest'),
            
            connectionStatus: document.getElementById('connectionStatus'),
            
            notificationContainer: document.getElementById('notificationContainer'),
            alarmOverlay: document.getElementById('alarmOverlay'),
            btnStopAlarm: document.getElementById('btnStopAlarm'),
            errorModal: document.getElementById('errorModal'),
            errorMessage: document.getElementById('errorMessage'),
            btnRetry: document.getElementById('btnRetry'),
            modalClose: document.querySelector('.modal-close'),
            closeModal: document.querySelector('.close-modal')
        };

        this.init();
    }

    async init() {
        console.log('🚀 Inicializando Visión Remota...');
        
        this.updateConnectionStatus('🟢 Selecciona un modo');
        this.setupEventListeners();
        this.generateDisplayCode({ notify: false });
        this.loadRecentCodes();
        
        this.elements.videoQuality.value = this.state.settings.videoQuality;
        this.initIceSettingsUI();
        this.initMotionDetection();
        this.showNotification('Sistema inicializado correctamente', 'success');
    }

    // ===== CONEXIÓN A DISTANCIA (STUN + TURN) =====
    /**
     * La conexión directa (P2P) funciona en la misma red o con NAT sencillo.
     * Cuando el supervisor está en otra red con NAT estricto, CGNAT o
     * cortafuegos, el vídeo sólo puede llegar a través de un servidor TURN
     * (relé). Aquí se prepara el formulario para configurar ese relé.
     */
    initIceSettingsUI() {
        const { btnIceSettings, iceModal, iceClose, btnIceSave, btnIceReset, btnIceTest } = this.elements;
        const iceApi = typeof IceServers !== 'undefined' ? IceServers : null;

        if (iceApi) this.iceSettings = iceApi.load();
        this.applyIceSettingsToForm();
        this.updateIceSummary();

        if (btnIceSettings && iceModal) {
            btnIceSettings.addEventListener('click', () => this.openIceSettings());
        }
        // El resumen de la cabecera es también una puerta al mismo panel.
        if (this.elements.iceSummary && iceModal) {
            this.elements.iceSummary.addEventListener('click', () => this.openIceSettings());
        }
        if (iceClose && iceModal) {
            iceClose.addEventListener('click', () => this.closeIceSettings());
        }
        if (iceModal) {
            iceModal.addEventListener('click', (event) => {
                if (event.target === iceModal) this.closeIceSettings();
            });
        }
        if (btnIceSave) {
            btnIceSave.addEventListener('click', () => this.saveIceSettings());
        }
        if (btnIceReset) {
            btnIceReset.addEventListener('click', () => this.resetIceSettings());
        }
        if (btnIceTest) {
            btnIceTest.addEventListener('click', () => this.testIceRelay());
        }
    }

    applyIceSettingsToForm() {
        const turn = (this.iceSettings && this.iceSettings.customTurn) || {};
        const { iceTurnUrls, iceTurnUsername, iceTurnCredential, iceUsePublicRelay } = this.elements;

        if (iceTurnUrls) iceTurnUrls.value = turn.urls || '';
        if (iceTurnUsername) iceTurnUsername.value = turn.username || '';
        if (iceTurnCredential) iceTurnCredential.value = turn.credential || '';
        if (iceUsePublicRelay) iceUsePublicRelay.checked = this.iceSettings.includeDefaultTurn !== false;
    }

    /** Resume en una línea qué vías de conexión están activas. */
    updateIceSummary() {
        const iceApi = typeof IceServers !== 'undefined' ? IceServers : null;
        const servers = iceApi ? iceApi.build(this.iceSettings) : [];
        const hasTurn = iceApi ? iceApi.hasTurn(servers) : false;
        const hasCustom = Boolean(
            this.iceSettings && this.iceSettings.customTurn && this.iceSettings.customTurn.urls
        );

        const summary = this.elements.iceSummary;
        if (summary) {
            // Con el relé público no se promete nada: la cuota es compartida y
            // sólo una prueba real confirma que responde.
            summary.textContent = hasTurn
                ? (hasCustom ? 'Relé propio + público' : 'Relé público (probar)')
                : 'Sólo conexión directa';
            summary.classList.toggle('warn', !hasTurn);
            summary.title = hasTurn
                ? 'Pulsa para configurar o probar el relé de conexión a distancia'
                : 'Sin relé no se puede supervisar desde otra red: pulsa para configurarlo';
        }

        const status = this.elements.iceStatus;
        if (status) {
            if (!hasTurn) {
                status.className = 'ice-status warn';
                status.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Sin relé (TURN) la supervisión desde otra red puede no conectar.';
            } else if (hasCustom) {
                status.className = 'ice-status ok';
                status.innerHTML = '<i class="fas fa-circle-check"></i> Usando tu servidor TURN propio: funciona desde cualquier red.';
            } else {
                status.className = 'ice-status info';
                status.innerHTML = '<i class="fas fa-circle-info"></i> Usando el relé público (cuota compartida). Para uso intensivo, añade tu propio TURN.';
            }
        }

        return servers;
    }

    /**
     * Comprueba de verdad que el relé responde: crea una RTCPeerConnection
     * con la configuración actual y espera a recibir un candidato TURN. Es la
     * forma de saber si el relé público sigue teniendo cuota disponible o si
     * el TURN propio está bien configurado (credenciales, cortafuegos...).
     */
    async testIceRelay() {
        const iceApi = typeof IceServers !== 'undefined' ? IceServers : null;
        const status = this.elements.iceStatus;
        const button = this.elements.btnIceTest;

        // Se prueba lo que hay escrito ahora mismo en el formulario.
        const customTurn = {
            urls: (this.elements.iceTurnUrls && this.elements.iceTurnUrls.value) || '',
            username: (this.elements.iceTurnUsername && this.elements.iceTurnUsername.value) || '',
            credential: (this.elements.iceTurnCredential && this.elements.iceTurnCredential.value) || ''
        };
        const includeDefaultTurn = !this.elements.iceUsePublicRelay || this.elements.iceUsePublicRelay.checked;

        if (iceApi) {
            const validation = iceApi.validateCustomTurn(customTurn);
            if (!validation.ok) {
                this.showNotification(validation.error, 'warning');
                return;
            }
        }

        const servers = iceApi
            ? iceApi.build({ customTurn, includeDefaultTurn })
            : this.iceServers;

        if (!iceApi || !iceApi.hasTurn(servers)) {
            this.showNotification('No hay ningún relé TURN configurado que probar', 'warning');
            return;
        }

        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Probando…';
        }
        if (status) {
            status.className = 'ice-status info';
            status.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Probando el relé TURN…';
        }

        const result = await this.checkTurnAvailability(servers);

        if (button) {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-vial"></i> Probar relé';
        }

        if (result.ok) {
            if (status) {
                status.className = 'ice-status ok';
                status.innerHTML = '<i class="fas fa-circle-check"></i> El relé TURN responde: podrás supervisar desde otra red.';
            }
            this.showNotification('Relé TURN operativo', 'success');
        } else {
            if (status) {
                status.className = 'ice-status warn';
                status.innerHTML = '<i class="fas fa-triangle-exclamation"></i> El relé TURN no responde: ' +
                    (result.error || 'revisa la URL, el usuario y la contraseña') +
                    '. Sin él, desde otra red puede no conectar.';
            }
            this.showNotification('El relé TURN no responde', 'warning');
        }
    }

    /**
     * Devuelve `{ok}` o `{ok:false, error}`. Nunca lanza: un fallo aquí sólo
     * significa que la conexión dependerá de la ruta directa.
     */
    checkTurnAvailability(servers) {
        return new Promise(resolve => {
            const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
            if (!PC) {
                resolve({ ok: false, error: 'este navegador no permite comprobarlo' });
                return;
            }

            let pc = null;
            let finished = false;
            let relayFound = false;
            let timeout = null;

            const finish = (result) => {
                if (finished) return;
                finished = true;
                if (timeout !== null) clearTimeout(timeout);
                try { if (pc) pc.close(); } catch (error) { /* ya cerrada */ }
                resolve(result);
            };

            // Un relé sano responde en pocos segundos; si no, se informa.
            timeout = setTimeout(() => finish({
                ok: false,
                error: 'tiempo de espera agotado'
            }), 12000);

            try {
                pc = new PC({ iceServers: servers, iceTransportPolicy: 'all' });

                pc.onicecandidate = (event) => {
                    if (!event.candidate) return;
                    if (event.candidate.type === 'relay') {
                        relayFound = true;
                        finish({ ok: true });
                    }
                };

                pc.onicegatheringstatechange = () => {
                    if (pc && pc.iceGatheringState === 'complete' && !relayFound) {
                        finish({ ok: false, error: 'no se obtuvo ningún candidato de relé' });
                    }
                };

                // Un canal de datos basta: no se envía ni se recibe vídeo.
                pc.createDataChannel('ice-test');
                Promise.resolve(pc.createOffer())
                    .then(offer => pc.setLocalDescription(offer))
                    .catch(() => finish({ ok: false, error: 'no se pudo iniciar la prueba' }));
            } catch (error) {
                finish({ ok: false, error: 'no se pudo iniciar la prueba' });
            }
        });
    }

    openIceSettings() {
        this.applyIceSettingsToForm();
        this.updateIceSummary();
        if (this.elements.iceModal) {
            this.elements.iceModal.classList.remove('hidden');
            if (this.elements.iceModalBody) this.elements.iceModalBody.scrollTop = 0;
        }
        if (this.elements.iceTurnUrls) this.elements.iceTurnUrls.focus();
    }

    closeIceSettings() {
        if (this.elements.iceModal) this.elements.iceModal.classList.add('hidden');
    }

    /**
     * Guarda la configuración del relé, reconstruye la lista ICE y reinicia
     * PeerJS para que las conexiones nuevas ya usen los servidores nuevos.
     * Nunca corta la cámara: sólo se reprograma la conexión.
     */
    saveIceSettings() {
        const iceApi = typeof IceServers !== 'undefined' ? IceServers : null;
        if (!iceApi) {
            this.showNotification('El módulo de conexión no está disponible', 'error');
            return;
        }

        const customTurn = {
            urls: (this.elements.iceTurnUrls && this.elements.iceTurnUrls.value) || '',
            username: (this.elements.iceTurnUsername && this.elements.iceTurnUsername.value) || '',
            credential: (this.elements.iceTurnCredential && this.elements.iceTurnCredential.value) || ''
        };
        const includeDefaultTurn = !this.elements.iceUsePublicRelay || this.elements.iceUsePublicRelay.checked;

        const validation = iceApi.validateCustomTurn(customTurn);
        if (!validation.ok) {
            this.showNotification(validation.error, 'warning');
            return;
        }

        // save() devuelve la versión normalizada y persistida.
        const settings = iceApi.save({ customTurn, includeDefaultTurn });
        this.iceSettings = settings;
        this.iceServers = iceApi.build(settings);
        this.config.peerServer.config.iceServers = this.iceServers;

        this.applyIceSettingsToForm();
        this.updateIceSummary();
        this.closeIceSettings();
        this.showNotification('Servidores de conexión actualizados', 'success');

        // PeerJS crea la RTCPeerConnection con la configuración que recibe al
        // instanciarse: hay que volver a registrarse para aplicarla.
        this.refreshPeerConfiguration();
    }

    resetIceSettings() {
        const iceApi = typeof IceServers !== 'undefined' ? IceServers : null;
        this.iceSettings = iceApi
            ? iceApi.save({ customTurn: iceApi.emptyCustomTurn(), includeDefaultTurn: true })
            : { customTurn: { urls: '', username: '', credential: '' }, includeDefaultTurn: true };
        this.iceServers = iceApi ? iceApi.build(this.iceSettings) : [];
        this.config.peerServer.config.iceServers = this.iceServers;

        this.applyIceSettingsToForm();
        this.updateIceSummary();
        this.showNotification('Configuración del relé restablecida', 'info');
        this.refreshPeerConfiguration();
    }

    /**
     * Aplica los servidores ICE nuevos. Reiniciar PeerJS cerraría las
     * conexiones abiertas, así que nunca se hace con una transmisión en
     * curso: en ese caso la lista nueva se usará en la próxima conexión.
     */
    async refreshPeerConfiguration() {
        if (!this.state.isEmitter && !this.state.isViewer) return;

        const inUse = (this.state.isEmitter && this.state.isStreaming) ||
            (this.state.isViewer && this.state.isConnected);
        if (inUse) {
            this.showNotification('Se aplicará en la próxima conexión, sin cortar la actual', 'info');
            return;
        }

        try {
            if (this.state.isEmitter) {
                if (!this.state.currentCode) return;
                await this.registerEmitterCode();
            } else if (this.state.hostPeerId) {
                await this.attemptConnection(this.state.hostPeerId);
            }
        } catch (error) {
            console.warn('No se pudo aplicar el nuevo relé ahora mismo:', error);
            this.showNotification('Se aplicará en la próxima conexión', 'info');
        }
    }

    // ===== DETECCIÓN DE MOVIMIENTO (motion.js) =====
    /**
     * Prepara exclusivamente la detección del supervisor. El emisor no crea
     * detector, no analiza su cámara y no muestra controles de movimiento.
     */
    initMotionDetection() {
        if (typeof MotionPanel === 'undefined') {
            console.warn('⚠️ motion.js no está disponible: la detección de movimiento queda desactivada');
            return;
        }

        try {
            this.motionPanels = {
                viewer: new MotionPanel({
                    prefix: 'viewer',
                    role: 'viewer',
                    getVideo: () => this.elements.remoteVideo,
                    notify: (message, type) => this.showNotification(message, type),
                    sendRemoteAlert: (payload) => this.sendMotionAlert(payload)
                })
            };
            this.motionPanels.viewer.init();

            if (this.elements.btnStopAlarm) {
                this.elements.btnStopAlarm.addEventListener('click', () => this.stopAllAlarms());
            }

            console.log('✅ Detección de movimiento del supervisor lista');
        } catch (error) {
            console.error('Error al preparar la detección de movimiento:', error);
            this.motionPanels = null;
        }
    }

    /** Panel de detección del supervisor, sólo cuando ese modo está activo. */
    getMotionPanel() {
        if (!this.motionPanels || !this.state.isViewer) return null;
        return this.motionPanels.viewer;
    }

    /** Detiene cualquier alarma que esté sonando. */
    stopAllAlarms() {
        if (this.motionPanels && this.motionPanels.viewer) {
            try {
                this.motionPanels.viewer.alarms.stop();
            } catch (error) { /* ignorado a propósito */ }
        }

        if (this.elements.btnStopAlarm) {
            this.elements.btnStopAlarm.classList.add('hidden');
        }

        this.showNotification('Alarma detenida', 'info');
    }

    /** Avisa al otro dispositivo de que se ha detectado movimiento. */
    sendMotionAlert(payload) {
        const sent = this.broadcastData({
            type: 'motion-alert',
            source: 'viewer',
            percent: payload.percent || 0,
            thresholdPercent: payload.thresholdPercent || 0,
            timestamp: payload.timestamp || Date.now()
        });

        if (!sent) {
            this.showNotification('No hay ningún dispositivo conectado al que avisar', 'warning');
        }

        return sent;
    }

    /** Envía un mensaje JSON a todas las conexiones de datos abiertas. */
    broadcastData(message) {
        let payload;

        try {
            payload = JSON.stringify(message);
        } catch (error) {
            return false;
        }

        let sent = 0;

        this.dataConnections.forEach(connection => {
            try {
                if (connection && connection.open) {
                    connection.send(payload);
                    sent++;
                }
            } catch (error) {
                console.warn('No se pudo enviar el aviso por el canal de datos:', error);
            }
        });

        if (sent === 0 && this.dataConnection && this.dataConnection.open) {
            try {
                this.dataConnection.send(payload);
                sent++;
            } catch (error) {
                console.warn('No se pudo enviar el aviso por el canal de datos:', error);
            }
        }

        return sent > 0;
    }

    /** El otro dispositivo ha detectado movimiento. */
    handleMotionAlert(message) {
        const panel = this.getMotionPanel();

        // El emisor no analiza movimiento, pero puede recibir un aviso explícito
        // enviado por el supervisor sin activar ningún detector local.
        if (!panel) {
            if (this.state.isEmitter) {
                const percent = Number(message.percent) || 0;
                this.showNotification(`Movimiento detectado por el supervisor (${percent.toFixed(1)}%)`, 'warning');
            }
            return;
        }

        panel.handleRemoteAlert({
            percent: message.percent || 0,
            thresholdPercent: message.thresholdPercent || 0,
            source: message.source || 'remote',
            timestamp: message.timestamp || Date.now()
        });
    }

    async initializePeerJS(customId = null) {
        if (this.peer) {
            try { this.peer.destroy(); } catch (error) { /* ya estaba cerrado */ }
            this.peer = null;
        }

        this.dataConnections.clear();
        this.dataConnection = null;
        for (const call of this.pendingIncomingCalls.values()) {
            try { call.close(); } catch (error) { /* ya estaba cerrada */ }
        }
        this.pendingIncomingCalls.clear();
        this.state.peerId = null;

        return new Promise((resolve, reject) => {
            let settled = false;
            let initTimeout = null;

            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                if (initTimeout !== null) clearTimeout(initTimeout);
                callback(value);
            };

            try {
                const peer = customId
                    ? new Peer(customId, this.config.peerServer)
                    : new Peer(undefined, this.config.peerServer);
                this.peer = peer;

                peer.on('open', (id) => {
                    if (this.peer !== peer) return;
                    console.log('✅ PeerJS conectado con ID:', id);
                    this.state.peerId = id;
                    if (customId && this.state.isEmitter) this.state.currentCode = String(id).toUpperCase();
                    this.updateConnectionStatus('🟢 Conectado al servidor');
                    finish(resolve, id);
                });

                peer.on('error', (err) => {
                    if (this.peer !== peer) return;
                    console.error('❌ Error de PeerJS:', err);

                    let errorMsg = 'Error de conexión';
                    switch (err.type) {
                        case 'unavailable-id':
                            errorMsg = 'El código ya está en uso. Genera uno nuevo';
                            break;
                        case 'peer-unavailable':
                            errorMsg = 'El código no existe todavía o el emisor está desconectado';
                            break;
                        case 'network':
                            errorMsg = 'Error de red. Verifica tu conexión a internet';
                            break;
                        case 'server-error':
                            errorMsg = 'Error del servidor. Intenta recargar la página';
                            break;
                        case 'disconnected':
                            errorMsg = 'Desconectado del servidor';
                            break;
                        default:
                            if (err && err.message) errorMsg = err.message;
                    }

                    // Los errores posteriores a `open` pertenecen a una conexión
                    // concreta y no deben invalidar la inicialización del modo.
                    if (!settled) finish(reject, new Error(errorMsg));
                });

                peer.on('connection', (conn) => {
                    if (this.peer !== peer) return;
                    console.log('📡 Conexión de datos recibida de:', conn.peer);
                    this.setupDataConnection(conn);
                });

                peer.on('call', (call) => {
                    if (this.peer !== peer) return;
                    console.log('📞 Llamada recibida de:', call.peer);
                    this.handleIncomingCall(call);
                });

                peer.on('disconnected', () => {
                    if (this.peer === peer) this.updateConnectionStatus('🟠 Reconectando con el servidor…');
                });

                initTimeout = setTimeout(() => {
                    finish(reject, new Error('Tiempo de espera agotado al conectar con el servidor PeerJS'));
                }, 15000);
            } catch (error) {
                console.error('Error al crear instancia de Peer:', error);
                finish(reject, new Error('Error al inicializar PeerJS'));
            }
        });
    }

    setupEventListeners() {
        this.elements.btnEmitter.addEventListener('click', () => this.setEmitterMode());
        this.elements.btnViewer.addEventListener('click', () => this.setViewerMode());
        
        this.elements.backFromEmitter.addEventListener('click', () => this.showModeSelection());
        this.elements.backFromViewer.addEventListener('click', () => this.showModeSelection());
        
        this.elements.btnStartEmitter.addEventListener('click', () => this.toggleEmitterStream());
        this.elements.btnStopEmitter.addEventListener('click', () => this.stopEmitter());
        this.elements.btnCopyCode.addEventListener('click', () => this.copyCode());
        this.elements.btnRefreshCode.addEventListener('click', () => this.refreshEmitterCode());
        this.elements.btnSwitchCamera.addEventListener('click', () => this.switchCamera());
        this.elements.btnFlipCamera.addEventListener('click', () => this.flipCamera());
        this.elements.btnAudioToggle.addEventListener('click', () => this.toggleEmitterAudio());
        this.elements.videoQuality.addEventListener('change', (e) => this.changeVideoQuality(e.target.value));
        
        this.elements.btnConnect.addEventListener('click', () => this.connectToEmitter());
        this.elements.peerCodeInput.addEventListener('input', (event) => {
            event.target.value = this.normalizeAccessCode(event.target.value);
        });
        this.elements.peerCodeInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.connectToEmitter();
            }
        });
        this.elements.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
        this.elements.btnTakeSnapshot.addEventListener('click', () => this.takeSnapshot());
        this.elements.btnMuteAudio.addEventListener('click', () => this.toggleMute());
        this.elements.btnStartAudio.addEventListener('click', () => this.startViewerAudio());
        this.elements.btnStopAudio.addEventListener('click', () => this.stopViewerAudio());
        this.elements.btnTestAudio.addEventListener('click', () => this.testAudio());
        this.elements.remoteVolume.addEventListener('input', (e) => this.changeRemoteVolume(e.target.value));
        
        this.elements.btnRetry.addEventListener('click', () => this.retryConnection());
        this.elements.modalClose.addEventListener('click', () => this.hideErrorModal());
        this.elements.closeModal.addEventListener('click', () => this.hideErrorModal());
        this.elements.errorModal.addEventListener('click', (e) => {
            if (e.target === this.elements.errorModal) this.hideErrorModal();
        });
    }

    normalizeAccessCode(value) {
        return String(value || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 6);
    }

    generateDisplayCode(options = {}) {
        // Se evitan 0/O y 1/I para reducir errores al copiar el código a mano.
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const previous = this.state.displayCode;
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        if (code === previous) {
            const last = chars.indexOf(code.charAt(5));
            code = code.slice(0, 5) + chars.charAt((last + 1) % chars.length);
        }

        this.state.displayCode = code;
        this.state.currentCode = null;
        this.elements.emitterCode.textContent = code;
        if (options.notify !== false) this.showNotification('Nuevo código generado: ' + code, 'success');
        return code;
    }

    updateEmitterCodeStatus(message, type = 'pending') {
        const element = this.elements.emitterCodeStatus;
        if (!element) return;

        const icons = {
            pending: 'fa-circle-notch fa-spin',
            ready: 'fa-circle-check',
            error: 'fa-circle-exclamation'
        };
        element.className = 'code-status ' + type;
        element.innerHTML = `<i class="fas ${icons[type] || icons.pending}"></i> ${message}`;
    }

    async registerEmitterCode() {
        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            const code = this.state.displayCode || this.generateDisplayCode({ notify: false });
            this.updateEmitterCodeStatus('Activando código…', 'pending');

            try {
                await this.initializePeerJS(code);
                this.state.currentCode = code;
                this.updateEmitterCodeStatus('Código activo y listo para conectar', 'ready');
                return code;
            } catch (error) {
                lastError = error;
                // Una colisión de código es poco probable, pero se resuelve sin
                // obligar al usuario a volver a pulsar ningún botón.
                if (String(error.message || error).includes('uso') && attempt < 2) {
                    this.generateDisplayCode({ notify: false });
                    continue;
                }
                break;
            }
        }

        this.updateEmitterCodeStatus('No se pudo activar el código', 'error');
        throw lastError || new Error('No se pudo activar el código');
    }

    async refreshEmitterCode() {
        if (this.state.isStreaming || this.state.isStartingStream) {
            this.showNotification('Detén la transmisión antes de cambiar el código', 'warning');
            return;
        }

        this.elements.btnRefreshCode.disabled = true;
        this.elements.btnCopyCode.disabled = true;
        this.generateDisplayCode({ notify: false });

        try {
            await this.registerEmitterCode();
            this.showNotification('Nuevo código activo: ' + this.state.currentCode, 'success');
        } catch (error) {
            this.showNotification('No se pudo activar el nuevo código: ' + error.message, 'error');
        } finally {
            this.elements.btnRefreshCode.disabled = false;
            this.elements.btnCopyCode.disabled = this.state.currentCode !== this.state.displayCode;
        }
    }

    async copyCode() {
        const code = this.state.currentCode;
        if (!code || code !== this.state.displayCode) {
            this.showNotification('Espera a que el código aparezca como activo', 'warning');
            return;
        }

        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(code);
            } else {
                const input = document.createElement('textarea');
                input.value = code;
                input.setAttribute('readonly', '');
                input.style.position = 'fixed';
                input.style.opacity = '0';
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                input.remove();
            }
            this.showNotification('Código copiado al portapapeles', 'success');
        } catch (error) {
            console.error('Error al copiar:', error);
            this.showNotification('No se pudo copiar. Mantén pulsado el código para copiarlo', 'error');
        }
    }

    loadRecentCodes() {
        const container = this.elements.recentCodes;
        container.innerHTML = '';
        
        if (this.state.recentCodes.length === 0) return;
        
        this.state.recentCodes.forEach(code => {
            const button = document.createElement('button');
            button.className = 'recent-code';
            button.textContent = code;
            button.addEventListener('click', () => {
                this.elements.peerCodeInput.value = code;
                this.connectToEmitter();
            });
            container.appendChild(button);
        });
    }

    saveRecentCode(code) {
        if (!this.state.recentCodes.includes(code)) {
            this.state.recentCodes.unshift(code);
            this.state.recentCodes = this.state.recentCodes.slice(0, 5);
            localStorage.setItem('recentCodes', JSON.stringify(this.state.recentCodes));
            this.loadRecentCodes();
        }
    }

    // ===== MODOS =====
    async setEmitterMode() {
        if (this.state.isEmitter) return;

        try {
            this.showNotification('Activando modo emisor...', 'info');
            this.state.isEmitter = true;
            this.state.isViewer = false;

            this.elements.modeSelection.classList.add('hidden');
            this.elements.emitterPanel.classList.remove('hidden');
            this.elements.viewerPanel.classList.add('hidden');
            this.elements.btnCopyCode.disabled = true;
            this.elements.btnRefreshCode.disabled = true;

            await this.registerEmitterCode();

            this.elements.btnCopyCode.disabled = false;
            this.elements.btnRefreshCode.disabled = false;
            this.updateEmitterStatus('Listo para transmitir', 'ready');
            this.showNotification('Modo emisor activado', 'success');
        } catch (error) {
            console.error('Error al activar modo emisor:', error);
            this.state.isEmitter = false;
            this.elements.btnCopyCode.disabled = false;
            this.elements.btnRefreshCode.disabled = false;
            this.showNotification('Error al activar modo emisor: ' + error.message, 'error');
            this.showModeSelection();
        }
    }

    async setViewerMode() {
        try {
            this.showNotification('Activando modo supervisor...', 'info');
            
            const viewerId = 'viewer-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            await this.initializePeerJS(viewerId);
            
            this.state.isEmitter = false;
            this.state.isViewer = true;
            
            this.elements.modeSelection.classList.add('hidden');
            this.elements.viewerPanel.classList.remove('hidden');
            this.elements.emitterPanel.classList.add('hidden');
            
            this.updateViewerStatus('Desconectado', 'disconnected');
            this.updateConnectionPrompt('ESPERANDO CONEXIÓN', 'Introduce un código para ver la transmisión en vivo');
            this.showNotification('Modo supervisor activado', 'success');
            
        } catch (error) {
            console.error('Error al activar modo supervisor:', error);
            this.showNotification('Error al activar modo supervisor: ' + error, 'error');
            this.showModeSelection();
        }
    }

    showModeSelection() {
        if (this.state.isEmitter) {
            this.stopEmitter();
        } else {
            this.disconnectFromEmitter();
        }
        
        for (const call of this.pendingIncomingCalls.values()) {
            try { call.close(); } catch (error) { /* ya estaba cerrada */ }
        }
        this.pendingIncomingCalls.clear();

        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }

        this.dataConnections.clear();
        this.dataConnection = null;
        this.clearAllTimeouts();

        this.state.isEmitter = false;
        this.state.isViewer = false;
        this.state.isConnected = false;
        this.state.isConnecting = false;
        this.state.peerId = null;
        this.state.currentCode = null;
        
        this.elements.emitterPanel.classList.add('hidden');
        this.elements.viewerPanel.classList.add('hidden');
        this.elements.modeSelection.classList.remove('hidden');
        
        this.updateConnectionStatus('🟢 Selecciona un modo');
        this.showNotification('Selecciona un modo de operación', 'info');
    }

    // ===== EMISOR =====
    async toggleEmitterStream() {
        if (this.state.isStartingStream) return;
        if (!this.state.isStreaming) {
            await this.startEmitter();
        } else {
            this.stopEmitter();
        }
    }

    async requestEmitterMedia() {
        await this.getMediaDevices();

        const quality = this.config.videoQuality[this.state.settings.videoQuality];
        const facingMode = this.state.isFrontCamera ? 'user' : 'environment';
        const preferredVideo = {
            ...quality,
            ...(this.currentDeviceId
                ? { deviceId: { exact: this.currentDeviceId } }
                : { facingMode: { ideal: facingMode } })
        };
        const preferredAudio = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        };

        try {
            return await navigator.mediaDevices.getUserMedia({
                video: preferredVideo,
                audio: preferredAudio
            });
        } catch (error) {
            if (error.name === 'SecurityError') throw error;

            // Algunos navegadores rechazan la petición completa cuando sólo se
            // deniega el micrófono. En ese caso aún se intenta abrir la cámara.
            if (error.name === 'NotAllowedError') {
                try {
                    const videoOnly = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: { ideal: facingMode } },
                        audio: false
                    });
                    this.showNotification('Cámara activa sin micrófono', 'warning');
                    return videoOnly;
                } catch (videoError) {
                    throw videoError;
                }
            }

            console.warn('No se pudieron aplicar los ajustes preferidos; reintentando con ajustes compatibles', error);
            try {
                return await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: quality.width },
                        height: { ideal: quality.height },
                        frameRate: { ideal: quality.frameRate },
                        facingMode: { ideal: facingMode }
                    },
                    audio: preferredAudio
                });
            } catch (fallbackError) {
                if (fallbackError.name === 'NotAllowedError' || fallbackError.name === 'SecurityError') throw fallbackError;

                // Una cámara útil debe poder comenzar aunque el dispositivo no
                // tenga micrófono o éste esté ocupado.
                const videoOnly = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: facingMode } },
                    audio: false
                });
                this.showNotification('Transmisión iniciada sin micrófono; la cámara sí está activa', 'warning');
                return videoOnly;
            }
        }
    }

    async startEmitter() {
        if (this.state.isStartingStream || this.state.isStreaming) return;
        this.state.isStartingStream = true;

        const startButton = this.elements.btnStartEmitter;
        startButton.disabled = true;
        startButton.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Iniciando…';
        this.updateEmitterStatus('Preparando cámara…', 'connecting');

        try {
            this.showNotification('Iniciando cámara y micrófono...', 'info');

            // Recupera automáticamente el registro del código si la conexión con
            // PeerJS se perdió mientras el usuario configuraba la cámara.
            if (!this.peer || this.peer.disconnected || this.state.currentCode !== this.state.displayCode) {
                await this.registerEmitterCode();
            }

            this.localStream = await this.requestEmitterMedia();
            this.elements.localVideo.srcObject = this.localStream;
            this.elements.localVideo.muted = true;

            await this.elements.localVideo.play().catch(error => {
                console.log('La vista local esperará una interacción para reproducirse:', error);
            });

            this.elements.btnStartEmitter.classList.add('hidden');
            this.elements.btnStopEmitter.classList.remove('hidden');
            this.elements.btnRefreshCode.disabled = true;
            this.state.isStreaming = true;

            this.updateEmitterStatus('Transmitiendo en vivo', 'streaming');
            this.updateQualityTag();

            const hasAudio = this.localStream.getAudioTracks().length > 0;
            this.elements.btnAudioToggle.disabled = !hasAudio;
            this.elements.btnAudioToggle.innerHTML = hasAudio
                ? '<i class="fas fa-microphone"></i> Micrófono: ON'
                : '<i class="fas fa-microphone-slash"></i> Sin micrófono';

            this.broadcastData({ type: 'emitter-status', streaming: true });
            this.answerPendingIncomingCalls();

            this.showNotification('Transmisión iniciada correctamente', 'success');
            if (this.state.connectedViewers.size > 0) {
                this.showNotification(`${this.state.connectedViewers.size} supervisor(es) conectado(s)`, 'info');
            }
        } catch (error) {
            console.error('Error al iniciar transmisión:', error);
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => track.stop());
                this.localStream = null;
                this.elements.localVideo.srcObject = null;
            }
            this.updateEmitterStatus('No se pudo iniciar', 'disconnected');
            this.handleMediaError(error);
        } finally {
            this.state.isStartingStream = false;
            startButton.disabled = false;
            startButton.innerHTML = '<i class="fas fa-play"></i> Iniciar Transmisión';
        }
    }

    stopEmitter() {
        const wasStreaming = this.state.isStreaming || !!this.localStream;
        if (wasStreaming) this.broadcastData({ type: 'emitter-status', streaming: false });

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
            this.elements.localVideo.srcObject = null;
        }

        // Cierra la llamada de CADA supervisor, no sólo la última.
        const calls = new Set([...this.viewerCalls.values(), this.currentCall].filter(Boolean));
        this.viewerCalls.clear();
        calls.forEach(call => {
            try { call.close(); } catch (error) { /* ya estaba cerrada */ }
        });
        this.currentCall = null;

        this.releaseAllSupervisorAudio();

        this.elements.btnStartEmitter.classList.remove('hidden');
        this.elements.btnStopEmitter.classList.add('hidden');
        this.elements.btnRefreshCode.disabled = false;
        this.elements.btnAudioToggle.disabled = true;
        this.state.isStreaming = false;
        this.state.isStartingStream = false;

        this.state.connectedViewers.clear();
        this.updateConnectedClients();

        this.updateEmitterStatus('Listo para transmitir', 'ready');
        if (wasStreaming) this.showNotification('Transmisión detenida', 'info');
    }

    async switchCamera() {
        if (!this.localStream) return;
        
        try {
            await this.getMediaDevices();
            
            if (this.mediaDevices.length < 2) {
                this.showNotification('No se encontró otra cámara', 'warning');
                return;
            }
            
            this.state.isFrontCamera = !this.state.isFrontCamera;
            
            const currentTrack = this.localStream.getVideoTracks()[0];
            currentTrack.stop();
            
            const facingMode = this.state.isFrontCamera ? 'user' : 'environment';
            const device = this.mediaDevices.find(d => 
                d.label.toLowerCase().includes(facingMode === 'user' ? 'front' : 'back') ||
                d.label.toLowerCase().includes(facingMode === 'user' ? 'delantera' : 'trasera')
            ) || this.mediaDevices[0];
            
            this.currentDeviceId = device.deviceId;
            
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    ...this.config.videoQuality[this.state.settings.videoQuality],
                    deviceId: { exact: device.deviceId }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 2
                }
            });
            
            const newVideoTrack = newStream.getVideoTracks()[0];
            
            this.localStream.removeTrack(currentTrack);
            this.localStream.addTrack(newVideoTrack);
            
            // La nueva cámara llega a todos los supervisores conectados.
            this.applyVideoTrackToCalls(newVideoTrack);
            
            this.showNotification(`Cámara cambiada a ${this.state.isFrontCamera ? 'frontal' : 'trasera'}`, 'success');
            
        } catch (error) {
            console.error('Error al cambiar cámara:', error);
            this.showNotification('Error al cambiar cámara', 'error');
        }
    }

    flipCamera() {
        this.state.isFlipped = !this.state.isFlipped;
        this.elements.localVideo.style.transform = this.state.isFlipped ? 'scaleX(1)' : 'scaleX(-1)';
        this.showNotification(`Modo espejo ${this.state.isFlipped ? 'activado' : 'desactivado'}`, 'info');
    }

    async getMediaDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.mediaDevices = devices.filter(device => device.kind === 'videoinput');
            
            if (this.mediaDevices.length > 0 && !this.currentDeviceId) {
                const frontCamera = this.mediaDevices.find(device => 
                    device.label.toLowerCase().includes('front') ||
                    device.label.toLowerCase().includes('user') ||
                    device.label.toLowerCase().includes('delantera')
                );
                this.currentDeviceId = frontCamera ? frontCamera.deviceId : this.mediaDevices[0].deviceId;
            }
        } catch (error) {
            console.error('Error al enumerar dispositivos:', error);
        }
    }

    toggleEmitterAudio() {
        if (!this.localStream) return;
        
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            const isEnabled = audioTrack.enabled;
            
            this.elements.btnAudioToggle.innerHTML = `
                <i class="fas fa-microphone${isEnabled ? '' : '-slash'}"></i>
                Micrófono: ${isEnabled ? 'ON' : 'OFF'}
            `;
            
            this.showNotification(`Micrófono ${isEnabled ? 'activado' : 'desactivado'}`, 'info');
        }
    }

    changeVideoQuality(quality) {
        this.state.settings.videoQuality = quality;
        localStorage.setItem('visionSettings', JSON.stringify(this.state.settings));
        
        if (this.state.isStreaming && this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            const constraints = this.config.videoQuality[quality];
            
            videoTrack.applyConstraints(constraints).then(() => {
                this.updateQualityTag();
                this.showNotification(`Calidad cambiada a ${quality.toUpperCase()}`, 'success');
            }).catch(error => {
                console.error('Error al cambiar calidad:', error);
                this.showNotification('Error al cambiar calidad', 'error');
            });
        }
    }

    // ===== SUPERVISOR =====
    async connectToEmitter() {
        if (this.state.isConnecting) return;

        const code = this.normalizeAccessCode(this.elements.peerCodeInput.value);
        this.elements.peerCodeInput.value = code;

        if (!/^[A-Z0-9]{6}$/.test(code)) {
            this.showNotification('Ingresa un código válido de 6 caracteres', 'warning');
            return;
        }

        this.saveRecentCode(code);
        this.state.hostPeerId = code;
        this.state.connectionAttempts = 0;
        this.state.isConnecting = true;
        this.elements.btnConnect.disabled = true;
        this.elements.btnConnect.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Conectando';

        this.updateViewerStatus('Conectando...', 'connecting');
        this.updateConnectionPrompt('CONECTANDO…', 'Buscando al emisor y esperando su cámara');
        this.showNotification(`Conectando a ${code}...`, 'info');

        // Aviso temprano: desde otra red, sin relé (TURN) la conexión puede
        // quedarse esperando aunque el código sea correcto.
        if (typeof IceServers !== 'undefined' && !IceServers.hasTurn(this.iceServers)) {
            this.showNotification(
                'No hay servidor de relé (TURN): si estás en otra red, añádelo en «Conexión a distancia»',
                'warning'
            );
        }

        try {
            await this.attemptConnection(code);
        } finally {
            this.state.isConnecting = false;
            this.elements.btnConnect.disabled = false;
            this.elements.btnConnect.innerHTML = '<i class="fas fa-plug"></i> Conectar';
        }
    }

    async attemptConnection(code) {
        try {
            this.clearAllTimeouts();

            if (!this.peer || this.peer.disconnected) {
                const viewerId = 'viewer-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
                await this.initializePeerJS(viewerId);
            }

            // El canal de datos mejora estados y avisos, pero nunca debe impedir
            // que el vídeo conecte si tarda o no está disponible.
            this.attemptDataConnection(code).catch(error => {
                console.warn('El canal de datos no está disponible; se continúa con el vídeo:', error);
            });
            await this.attemptVideoCall(code);
            this.state.connectionAttempts = 0;
            return true;
        } catch (error) {
            console.error('Error en attemptConnection:', error);
            this.handleConnectionError(error.message);
            return false;
        }
    }

    async attemptDataConnection(code) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout de conexión de datos (10 segundos)'));
            }, 10000);
            
            this.connectionTimeouts.push(timeout);
            
            const dataConn = this.peer.connect(code, {
                reliable: true,
                serialization: 'json'
            });
            
            dataConn.on('open', () => {
                clearTimeout(timeout);
                console.log('✅ Conexión de datos abierta con:', dataConn.peer);
                this.dataConnection = dataConn;
                this.dataConnections.set(dataConn.peer, dataConn);
                
                dataConn.on('data', (data) => {
                    this.handleDataMessage(data);
                });
                
                dataConn.on('close', () => {
                    console.log('Conexión de datos cerrada');
                    this.dataConnections.delete(dataConn.peer);
                    if (this.dataConnection === dataConn) this.dataConnection = null;
                    if (this.state.isConnected) {
                        this.handleDisconnection();
                    }
                });
                
                dataConn.on('error', (err) => {
                    console.error('Error en conexión de datos:', err);
                });
                
                resolve();
            });
            
            dataConn.on('error', (err) => {
                clearTimeout(timeout);
                console.error('Error en conexión de datos:', err);
                reject(new Error('Error en conexión de datos: ' + err.message));
            });
        });
    }

    async createLocalAudioStream() {
        try {
            this.localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.localAudioStream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });
            console.log('✅ Stream de audio local creado (micrófono real, silenciado)');
        } catch (err) {
            console.warn('No se pudo obtener permiso de micrófono. Creando stream de audio silencioso...', err);
            
            try {
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                gainNode.gain.value = 0;
                oscillator.connect(gainNode);
                
                const destination = audioContext.createMediaStreamDestination();
                gainNode.connect(destination);
                
                oscillator.start();
                this.localAudioStream = destination.stream;
                
                setTimeout(() => {
                    oscillator.stop();
                }, 100);
                
                console.log('✅ Stream de audio local creado (audio silencioso sintético)');
            } catch (audioError) {
                console.error('Error crítico: No se pudo crear ningún stream de audio', audioError);
                throw new Error('Se necesita acceso al micrófono o compatibilidad con AudioContext para iniciar la llamada');
            }
        }

        // No se añade ninguna pista de vídeo local al offer: el supervisor sólo
        // quiere RECIBIR vídeo del emisor. Con `offerToReceiveVideo: true` y sin
        // una pista de vídeo propia, el offer incluye una sección m=video de
        // recepción y la cámara del emisor fluye hacia el supervisor.
        // (Antes se insertaba una pista de vídeo en blanco deshabilitada para
        // forzar la m=video, pero eso ofrecía vídeo del supervisor en lugar de
        // solicitarlo, por lo que nunca llegaba la cámara del emisor.)
    }

    async attemptVideoCall(code) {
        return new Promise(async (resolve, reject) => {
            // Evita que el cierre posterior al error de ICE dé un mensaje
            // engañoso ("El emisor no inició la cámara").
            let iceFailure = false;

            try {
                const callTimeout = setTimeout(() => {
                    reject(new Error('El emisor no inició la cámara a tiempo o la red impidió la conexión'));
                }, 90000);
                
                this.connectionTimeouts.push(callTimeout);
                
                await this.createLocalAudioStream();
                
                // PeerJS 1.4.7 pasa `constraints` a createOffer; `offerOptions` se ignora.
                const call = this.peer.call(code, this.localAudioStream, {
                    constraints: {
                        offerToReceiveVideo: true,
                        offerToReceiveAudio: true
                    }
                });
                
                if (!call) {
                    clearTimeout(callTimeout);
                    throw new Error('No se pudo crear la llamada');
                }
                
                // Diagnóstico: cuando el vídeo empieza a llegar se comprueba si
                // va directo o por el relé, y se avisa si la conexión es frágil.
                this.startRouteDiagnostics(call);
                
                call.on('stream', (remoteStream) => {
                    clearTimeout(callTimeout);
                    console.log('✅ Stream remoto recibido');
                    this.handleRemoteStream(remoteStream);
                    resolve();
                });
                
                call.on('close', () => {
                    clearTimeout(callTimeout);
                    console.log('Llamada cerrada');
                    // Si el emisor no inició la cámara aparece un error de ICE
                    // justo antes del cierre: se deja que ese error dé el
                    // mensaje (reintento o consejo sobre el relé TURN).
                    if (iceFailure) return;
                    if (!this.state.isConnected) {
                        reject(new Error('Llamada cerrada antes de recibir stream'));
                    } else {
                        this.handleDisconnection();
                    }
                });
                
                call.on('error', (err) => {
                    clearTimeout(callTimeout);
                    console.error('Error en llamada:', err);
                    iceFailure = true;
                    reject(new Error(
                        'No se pudo establecer la conexión con el emisor. ' +
                        'Comprueba que ambos tienen Internet y que hay un servidor TURN ' +
                        '(«Conexión a distancia») si están en redes distintas.'
                    ));
                });
                
                this.currentCall = call;
                
            } catch (error) {
                reject(error);
            }
        });
    }

    handleRemoteStream(stream) {
        // PeerJS emite `stream` por cada pista, a menudo con el mismo MediaStream.
        // No reiniciar el vídeo ni los temporizadores al llegar la segunda pista.
        if (this.remoteStream === stream && this.state.isConnected) return;
        this.remoteStream = stream;
        this.setupVideoForMobile();
        this.elements.remoteVideo.srcObject = stream;
        this.elements.connectionOverlay.classList.add('hidden');
        
        // Detección de movimiento: ya hay vídeo remoto que analizar
        if (this.motionPanels) this.motionPanels.viewer.attach();
        
        this.elements.remoteVideo.muted = false;
        this.elements.remoteVideo.volume = this.elements.remoteVolume.value / 100;
        
        const videoTracks = stream.getVideoTracks();
        const audioTracks = stream.getAudioTracks();
        
        console.log('Stream recibido - Video tracks:', videoTracks.length, 'Audio tracks:', audioTracks.length);
        
        if (videoTracks.length === 0) {
            this.showNotification('Advertencia: No se detectó video en la transmisión', 'warning');
        }
        
        if (audioTracks.length === 0) {
            this.showNotification('Advertencia: No se detectó audio en la transmisión', 'warning');
        } else {
            audioTracks[0].enabled = true;
        }
        
        this.state.isConnected = true;
        this.updateViewerStatus('Conectado', 'streaming');
        this.updateConnectionState('Conectado');
        
        this.elements.btnStartAudio.classList.remove('hidden', 'disabled');
        this.elements.btnStartAudio.disabled = false;
        
        this.startUptimeTimer();
        this.startConnectionStatsMonitoring();
        
        this.showNotification('¡Conectado a la transmisión!', 'success');
        this.updateConnectionStats();
    }

    setupVideoForMobile() {
        const video = this.elements.remoteVideo;
        
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        // `muted` es un atributo booleano: muted="false" también silencia.
        video.removeAttribute('muted');
        
        video.onloadedmetadata = () => {
            console.log('Metadata del video cargado');
            video.play().catch(error => {
                console.log('Autoplay bloqueado:', error);
                this.showNotification('Toca la pantalla para iniciar el video', 'warning');
                
                const playOnInteraction = () => {
                    video.play().then(() => {
                        console.log('Video reproducido después de interacción');
                        this.showNotification('Video en reproducción', 'success');
                    }).catch(err => {
                        console.log('Error al reproducir video:', err);
                    });
                    
                    document.removeEventListener('click', playOnInteraction);
                    document.removeEventListener('touchstart', playOnInteraction);
                };
                
                document.addEventListener('click', playOnInteraction);
                document.addEventListener('touchstart', playOnInteraction);
            });
        };
        
        video.onplay = () => {
            console.log('Video empezó a reproducirse');
            this.showNotification('Transmisión en vivo', 'success');
        };
        
        video.onerror = (error) => {
            console.error('Error en video:', error);
            this.showNotification('Error al reproducir video', 'error');
        };
    }

    setupDataConnection(conn) {
        conn.on('open', () => {
            console.log('✅ Canal de datos abierto con:', conn.peer);
            this.dataConnection = conn;
            this.dataConnections.set(conn.peer, conn);

            if (this.state.isEmitter) {
                conn.send(JSON.stringify({
                    type: 'emitter-status',
                    streaming: this.state.isStreaming
                }));
            }
            
            conn.on('data', (data) => {
                this.handleDataMessage(data);
            });
            
            conn.on('close', () => {
                console.log('Conexión de datos cerrada');
                this.dataConnections.delete(conn.peer);
                if (this.dataConnection === conn) this.dataConnection = null;
                if (this.state.isConnected) {
                    this.handleDisconnection();
                }
            });
            
            conn.on('error', (err) => {
                console.error('Error en conexión de datos:', err);
            });
        });
    }

    handleDataMessage(data) {
        try {
            const message = typeof data === 'string' ? JSON.parse(data) : data;
            if (!message || typeof message !== 'object') return;

            switch(message.type) {
                case 'viewer-connected':
                    if (this.state.isEmitter) {
                        this.state.connectedViewers.add(message.viewerId);
                        this.updateConnectedClients();
                        this.showNotification('Nuevo supervisor conectado', 'info');
                    }
                    break;
                    
                case 'viewer-disconnected':
                    if (this.state.isEmitter) {
                        this.state.connectedViewers.delete(message.viewerId);
                        this.updateConnectedClients();
                    }
                    break;
                    
                case 'ping':
                    if (this.dataConnection) {
                        this.dataConnection.send(JSON.stringify({
                            type: 'pong',
                            timestamp: message.timestamp,
                            receivedAt: Date.now()
                        }));
                    }
                    break;
                    
                case 'pong':
                    const latency = Date.now() - message.timestamp;
                    this.elements.latencyValue.textContent = `${latency} ms`;
                    break;
                    
                case 'emitter-status':
                    if (this.state.isViewer && !message.streaming && !this.state.isConnected) {
                        this.updateViewerStatus('Esperando al emisor', 'connecting');
                        this.updateConnectionPrompt(
                            'EMISOR PREPARANDO CÁMARA',
                            'No cierres esta pantalla: conectará automáticamente cuando inicie la transmisión'
                        );
                    }
                    break;

                case 'motion-alert':
                    this.handleMotionAlert(message);
                    break;
            }
        } catch (error) {
            console.log('Mensaje recibido:', data);
        }
    }

    handleIncomingCall(call) {
        if (!this.state.isEmitter) {
            try { call.close(); } catch (error) { /* llamada inválida */ }
            return;
        }

        if (!this.localStream) {
            const previous = this.pendingIncomingCalls.get(call.peer);
            if (previous && previous !== call) {
                try { previous.close(); } catch (error) { /* sustituida */ }
            }

            this.pendingIncomingCalls.set(call.peer, call);
            const removePending = () => {
                if (this.pendingIncomingCalls.get(call.peer) === call) {
                    this.pendingIncomingCalls.delete(call.peer);
                }
            };
            call.on('close', removePending);
            call.on('error', removePending);

            this.broadcastData({ type: 'emitter-status', streaming: false });
            this.updateEmitterStatus('Supervisor esperando · inicia la transmisión', 'connecting');
            this.showNotification('Hay un supervisor esperando. Pulsa “Iniciar transmisión” cuando quieras', 'info');
            return;
        }

        this.answerIncomingCall(call);
    }

    answerPendingIncomingCalls() {
        if (!this.localStream || this.pendingIncomingCalls.size === 0) return;
        const calls = Array.from(this.pendingIncomingCalls.values());
        this.pendingIncomingCalls.clear();
        calls.forEach(call => this.answerIncomingCall(call));
    }

    answerIncomingCall(call) {
        if (!call || !this.localStream) return;

        try {
            call.answer(this.localStream);
            this.currentCall = call;
            // Se guarda cada llamada por supervisor: así el vídeo llega a
            // varios dispositivos a la vez y el cambio de cámara o el audio
            // bidireccional se aplican a todas, no sólo a la última.
            this.viewerCalls.set(call.peer, call);
            console.log('✅ Aceptada llamada de:', call.peer);

            this.broadcastData({
                type: 'viewer-connected',
                viewerId: call.peer
            });
            this.state.connectedViewers.add(call.peer);
            this.updateConnectedClients();

            call.on('stream', (supervisorStream) => {
                console.log('Audio recibido del supervisor:', call.peer);

                const audioElement = this.getSupervisorAudioElement(call.peer);
                audioElement.srcObject = supervisorStream;
                audioElement.play().catch(error => {
                    console.log('Audio del supervisor bloqueado hasta una interacción:', error);
                });
                this.showNotification('Supervisor habilitó audio bidireccional', 'info');
            });

            call.on('close', () => {
                this.state.connectedViewers.delete(call.peer);
                this.updateConnectedClients();
                if (this.viewerCalls.get(call.peer) === call) this.viewerCalls.delete(call.peer);
                if (this.currentCall === call) this.currentCall = null;
                this.releaseSupervisorAudio(call.peer);
            });

            call.on('error', (error) => {
                console.error('Error en llamada con supervisor:', error);
                this.state.connectedViewers.delete(call.peer);
                this.updateConnectedClients();
                if (this.viewerCalls.get(call.peer) === call) this.viewerCalls.delete(call.peer);
                if (this.currentCall === call) this.currentCall = null;
                this.releaseSupervisorAudio(call.peer);
            });
        } catch (error) {
            console.error('No se pudo aceptar la llamada del supervisor:', error);
            try { call.close(); } catch (closeError) { /* ignorado */ }
        }
    }

    /** Un elemento de audio oculto por cada supervisor (audio bidireccional). */
    getSupervisorAudioElement(viewerId) {
        if (this.supervisorAudioElement && this.supervisorAudioElement.dataset.viewer === viewerId) {
            return this.supervisorAudioElement;
        }

        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.volume = 1.0;
        audio.style.display = 'none';
        audio.dataset.viewer = viewerId;
        document.body.appendChild(audio);

        if (!this.supervisorAudioElements) this.supervisorAudioElements = new Map();
        this.supervisorAudioElements.set(viewerId, audio);
        return audio;
    }

    releaseAllSupervisorAudio() {
        if (this.supervisorAudioElements) {
            this.supervisorAudioElements.forEach(audio => audio.remove());
            this.supervisorAudioElements.clear();
        }
        if (this.supervisorAudioElement) {
            this.supervisorAudioElement.remove();
            this.supervisorAudioElement = null;
        }
    }

    releaseSupervisorAudio(viewerId) {
        if (!this.supervisorAudioElements) return;

        const audio = this.supervisorAudioElements.get(viewerId);
        this.supervisorAudioElements.delete(viewerId);
        if (audio) audio.remove();
        if (this.supervisorAudioElement === audio) this.supervisorAudioElement = null;
    }

    /** Aplica un cambio de pista de vídeo a todas las llamadas activas. */
    applyVideoTrackToCalls(track) {
        this.viewerCalls.forEach((call, viewerId) => {
            try {
                const senders = call.peerConnection && call.peerConnection.getSenders
                    ? call.peerConnection.getSenders()
                    : [];
                const sender = senders.find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(track);
            } catch (error) {
                console.warn('No se pudo actualizar la cámara de un supervisor:', viewerId, error);
            }
        });

        // Compatibilidad: llamadas que no estén registradas en el mapa.
        if (this.currentCall && !this.viewerCalls.has(this.currentCall.peer)) {
            try {
                const senders = this.currentCall.peerConnection.getSenders();
                const sender = senders.find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(track);
            } catch (error) { /* ignorado */ }
        }
    }

    async startViewerAudio() {
        try {
            const newAudioStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 2,
                    sampleRate: 48000
                },
                video: false
            });
            
            if (this.localAudioStream) {
                this.localAudioStream.getAudioTracks().forEach(track => track.stop());
            }
            
            this.localAudioStream = newAudioStream;
            
            if (this.currentCall) {
                const newAudioTrack = newAudioStream.getAudioTracks()[0];
                const senders = this.currentCall.peerConnection.getSenders();
                const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                
                if (audioSender) {
                    audioSender.replaceTrack(newAudioTrack);
                } else {
                    this.currentCall.peerConnection.addTrack(newAudioTrack, newAudioStream);
                }
                
                this.state.isAudioEnabled = true;
                this.elements.btnStartAudio.classList.add('hidden');
                this.elements.btnStopAudio.classList.remove('hidden');
                
                this.showNotification('Micrófono activado - Audio bidireccional', 'success');
                this.updateConnectionState('Conectado (Hablando)');
                this.updateConnectionStats();
            }
            
        } catch (error) {
            console.error('Error al activar micrófono:', error);
            this.showNotification('Error al acceder al micrófono: ' + error.message, 'error');
        }
    }

    stopViewerAudio() {
        if (this.currentCall && this.state.isAudioEnabled) {
            const senders = this.currentCall.peerConnection.getSenders();
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            
            if (audioSender && audioSender.track) {
                audioSender.replaceTrack(null);
            }
            
            this.state.isAudioEnabled = false;
            this.elements.btnStartAudio.classList.remove('hidden');
            this.elements.btnStopAudio.classList.add('hidden');
            
            this.showNotification('Micrófono desactivado', 'info');
            this.updateConnectionState('Conectado');
            this.updateConnectionStats();
        }
    }

    testAudio() {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.value = 440;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.1;
            
            oscillator.start();
            
            setTimeout(() => {
                oscillator.stop();
                this.showNotification('Prueba de audio completada', 'success');
            }, 500);
            
        } catch (error) {
            console.error('Error en prueba de audio:', error);
            this.showNotification('Error en prueba de audio', 'error');
        }
    }

    changeRemoteVolume(value) {
        if (this.elements.remoteVideo) {
            this.elements.remoteVideo.volume = value / 100;
            this.showNotification(`Volumen ajustado al ${value}%`, 'info');
        }
    }

    toggleFullscreen() {
        const video = this.elements.remoteVideo;
        
        if (!document.fullscreenElement) {
            if (video.requestFullscreen) {
                video.requestFullscreen();
            } else if (video.webkitRequestFullscreen) {
                video.webkitRequestFullscreen();
            } else if (video.mozRequestFullScreen) {
                video.mozRequestFullScreen();
            } else if (video.msRequestFullscreen) {
                video.msRequestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        }
    }

    takeSnapshot() {
        const video = this.elements.remoteVideo;
        if (!video.srcObject || video.videoWidth === 0) {
            this.showNotification('No hay video para capturar', 'warning');
            return;
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        link.download = `captura-${timestamp}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        
        this.showNotification('Captura guardada', 'success');
    }

    toggleMute() {
        if (this.elements.remoteVideo) {
            this.elements.remoteVideo.muted = !this.elements.remoteVideo.muted;
            const isMuted = this.elements.remoteVideo.muted;
            
            this.elements.btnMuteAudio.innerHTML = `
                <i class="fas fa-volume-${isMuted ? 'mute' : 'up'}"></i>
                ${isMuted ? 'Sonido: OFF' : 'Sonido: ON'}
            `;
            
            this.showNotification(`Audio ${isMuted ? 'silenciado' : 'activado'}`, 'info');
        }
    }

    disconnectFromEmitter() {
        this.clearAllTimeouts();

        if (this.routeCheckTimeout) {
            clearTimeout(this.routeCheckTimeout);
            this.routeCheckTimeout = null;
        }
        this.connectionRoute = null;
        
        if (this.currentCall) {
            this.currentCall.close();
            this.currentCall = null;
        }
        
        if (this.dataConnection) {
            this.dataConnection.close();
            this.dataConnection = null;
        }
        this.dataConnections.clear();

        if (this.motionPanels) this.motionPanels.viewer.detach('disconnected');
        
        if (this.remoteStream) {
            this.remoteStream.getTracks().forEach(track => track.stop());
            this.remoteStream = null;
            this.elements.remoteVideo.srcObject = null;
        }
        
        if (this.localAudioStream) {
            this.localAudioStream.getTracks().forEach(track => track.stop());
            this.localAudioStream = null;
        }
        
        this.state.isConnected = false;
        this.state.isAudioEnabled = false;
        this.state.hostPeerId = null;
        
        this.elements.connectionOverlay.classList.remove('hidden');
        this.updateConnectionPrompt('ESPERANDO CONEXIÓN', 'Introduce un código para ver la transmisión en vivo');
        this.elements.btnStartAudio.classList.remove('hidden');
        this.elements.btnStopAudio.classList.add('hidden');
        this.elements.btnStartAudio.classList.add('disabled');
        this.elements.btnStartAudio.disabled = true;
        this.elements.btnMuteAudio.innerHTML = '<i class="fas fa-volume-up"></i> Sonido: ON';
        
        this.updateViewerStatus('Desconectado', 'disconnected');
        this.updateConnectionState('Desconectado');
        if (this.elements.connectionRouteValue) this.elements.connectionRouteValue.textContent = '--';
        
        this.stopUptimeTimer();
        this.stopConnectionStatsMonitoring();
        
        this.showNotification('Desconectado de la transmisión', 'info');
    }

    // ===== MANEJO DE ERRORES =====
    handleMediaError(error) {
        let errorMsg = 'Error al acceder a los dispositivos';
        
        if (error.name === 'NotAllowedError') {
            errorMsg = 'Se denegó el acceso a la cámara/micrófono. Verifica los permisos del navegador.';
        } else if (error.name === 'NotFoundError') {
            errorMsg = 'No se encontró cámara o micrófono.';
        } else if (error.name === 'NotReadableError') {
            errorMsg = 'No se puede acceder al dispositivo. Puede estar en uso por otra aplicación.';
        } else if (error.name === 'OverconstrainedError') {
            errorMsg = 'No se puede cumplir con las restricciones solicitadas.';
        }
        
        this.showErrorModal(errorMsg);
    }

    handleConnectionError(error) {
        this.state.connectionAttempts++;
        
        if (this.state.connectionAttempts < 3) {
            this.showNotification(`Reintentando conexión (${this.state.connectionAttempts}/3)...`, 'warning');
            
            setTimeout(() => {
                if (this.state.hostPeerId) {
                    this.attemptConnection(this.state.hostPeerId);
                }
            }, 2000 * this.state.connectionAttempts);
        } else {
            const hasTurn = typeof IceServers === 'undefined' || IceServers.hasTurn(this.iceServers);
            const hint = hasTurn
                ? ' Si sigues en otra red, comprueba que tu servidor TURN sea accesible.'
                : ' Si el supervisor está en otra red, configura un servidor TURN en «Conexión a distancia».';
            this.showErrorModal(
                `No se pudo conectar después de ${this.state.connectionAttempts} intentos: ${error}.${hint}`
            );
            this.updateViewerStatus('Error de conexión', 'disconnected');
        }
    }

    showErrorModal(message) {
        this.elements.errorMessage.textContent = message;
        this.elements.errorModal.classList.remove('hidden');
    }

    hideErrorModal() {
        this.elements.errorModal.classList.add('hidden');
    }

    retryConnection() {
        this.hideErrorModal();
        this.state.connectionAttempts = 0;
        if (this.state.hostPeerId) {
            this.attemptConnection(this.state.hostPeerId);
        }
    }

    // ===== UTILIDADES =====
    updateEmitterStatus(message, type = 'ready') {
        this.elements.emitterStatusBadge.textContent = message;
        this.elements.emitterStatusBadge.className = 'status-badge ' + type;
    }

    updateViewerStatus(message, type = 'disconnected') {
        this.elements.viewerStatusBadge.textContent = message;
        this.elements.viewerStatusBadge.className = 'status-badge ' + type;
    }

    updateConnectionStatus(status) {
        this.elements.connectionStatus.textContent = status;
    }

    updateConnectionState(state) {
        this.elements.connectionState.textContent = state;
    }

    updateConnectionPrompt(title, text) {
        if (this.elements.connectionPromptTitle) this.elements.connectionPromptTitle.textContent = title;
        if (this.elements.connectionPromptText) this.elements.connectionPromptText.textContent = text;
    }

    updateQualityTag() {
        const quality = this.state.settings.videoQuality;
        const resolutions = {
            low: '480p',
            medium: '720p HD',
            high: '1080p FHD'
        };
        this.elements.qualityTag.textContent = resolutions[quality] || 'HD';
    }

    updateConnectedClients() {
        const container = this.elements.connectedClients;
        
        if (this.state.connectedViewers.size === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-user-clock"></i>
                    <p>Esperando conexiones...</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = '';
        this.state.connectedViewers.forEach(viewerId => {
            const client = document.createElement('div');
            client.className = 'client-item';
            client.innerHTML = `
                <i class="fas fa-user-circle"></i>
                <span>Supervisor ${viewerId.substring(0, 6)}</span>
                <div class="client-status online"></div>
            `;
            container.appendChild(client);

        });
    }

    // ===== DIAGNÓSTICO DE LA RUTA (directa o por relé) =====
    /**
     * Espera a que ICE elija pareja de candidatos y guarda cómo va la
     * conexión. Sirve para explicar al usuario por qué a veces funciona sólo
     * en la misma red: si no hay candidato "relay", es que no hay TURN.
     */
    startRouteDiagnostics(call) {
        if (this.routeCheckTimeout) {
            clearTimeout(this.routeCheckTimeout);
            this.routeCheckTimeout = null;
        }

        const peerConnection = call && call.peerConnection;
        if (!peerConnection) return;

        const attempt = (retries) => {
            this.detectConnectionRoute(peerConnection).then(route => {
                if (route) {
                    this.applyConnectionRoute(route);
                } else if (retries > 0) {
                    this.routeCheckTimeout = setTimeout(() => attempt(retries - 1), 1500);
                }
            });
        };

        // ICE suele resolverse en 1-3 s; se reintenta un poco por redes lentas.
        this.routeCheckTimeout = setTimeout(() => attempt(3), 1200);
    }

    /** Lee las estadísticas ICE y resume el tipo de conexión. */
    async detectConnectionRoute(peerConnection) {
        if (!peerConnection || typeof peerConnection.getStats !== 'function') return null;

        try {
            const report = await peerConnection.getStats();
            let pair = null;

            report.forEach(stat => {
                if (!pair && stat && stat.type === 'candidate-pair' &&
                    (stat.state === 'succeeded' || stat.state === 'in-progress')) {
                    pair = stat;
                }
            });

            if (!pair) return null;

            let local = null;
            let remote = null;
            report.forEach(stat => {
                if (!stat) return;
                if (stat.id === pair.localCandidateId) local = stat;
                if (stat.id === pair.remoteCandidateId) remote = stat;
            });

            const type = (local && local.candidateType) || (remote && remote.candidateType) || 'unknown';
            return {
                type,
                relay: type === 'relay',
                protocol: (local && local.protocol) || (remote && remote.protocol) || ''
            };
        } catch (error) {
            return null;
        }
    }

    applyConnectionRoute(route) {
        this.connectionRoute = route;
        const labels = {
            relay: 'Relé (TURN)',
            srflx: 'Directa (NAT)',
            prflx: 'Directa (NAT)',
            host: 'Red local',
            unknown: 'Detectando…'
        };
        const label = labels[route.type] || 'Directa';

        if (this.elements.connectionRouteValue) {
            this.elements.connectionRouteValue.textContent = label;
        }

        // No se pisa el estado cuando el supervisor está usando el micrófono.
        const state = this.elements.connectionState ? this.elements.connectionState.textContent : '';
        if (!/Hablando/i.test(state)) {
            this.updateConnectionState(route.relay ? 'Conectado (por relé)' : 'Conectado');
        }
        return label;
    }

    updateConnectionStats() {
        if (!this.state.isConnected) return;
        
        if (this.dataConnection) {
            this.dataConnection.send(JSON.stringify({
                type: 'ping',
                timestamp: Date.now()
            }));
        }
        
        if (this.state.isAudioEnabled) {
            this.elements.connectionStats.textContent = 'Audio bidireccional activo';
        } else {
            this.elements.connectionStats.textContent = 'Audio unidireccional (solo emisor)';
        }
    }

    startUptimeTimer() {
        this.connectionStartTime = Date.now();
        
        this.uptimeInterval = setInterval(() => {
            const elapsed = Date.now() - this.connectionStartTime;
            const minutes = Math.floor(elapsed / 60000);
            const seconds = Math.floor((elapsed % 60000) / 1000);
            
            this.elements.uptime.textContent = 
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    stopUptimeTimer() {
        if (this.uptimeInterval) {
            clearInterval(this.uptimeInterval);
            this.uptimeInterval = null;
        }
        this.elements.uptime.textContent = '00:00';
    }

    startConnectionStatsMonitoring() {
        this.statsInterval = setInterval(() => {
            if (this.state.isConnected) {
                this.updateConnectionStats();
            }
        }, 3000);
    }

    stopConnectionStatsMonitoring() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }

    clearAllTimeouts() {
        this.connectionTimeouts.forEach(timeout => {
            clearTimeout(timeout);
        });
        this.connectionTimeouts = [];
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <i class="fas fa-${this.getNotificationIcon(type)}"></i>
            <div class="notification-content">${message}</div>
            <button class="notification-close">&times;</button>
        `;
        
        notification.querySelector('.notification-close').addEventListener('click', () => {
            notification.remove();
        });
        
        this.elements.notificationContainer.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 5000);
    }

    getNotificationIcon(type) {
        switch (type) {
            case 'success': return 'check-circle';
            case 'error': return 'exclamation-circle';
            case 'warning': return 'exclamation-triangle';
            default: return 'info-circle';
        }
    }

    // ===== EVENTOS DEL DOM =====
    handleDisconnection() {
        this.state.isConnected = false;
        this.elements.connectionOverlay.classList.remove('hidden');
        this.updateConnectionPrompt('CONEXIÓN INTERRUMPIDA', 'Intentando reconectar automáticamente…');
        this.updateViewerStatus('Desconectado', 'disconnected');
        this.updateConnectionState('Desconectado');
        this.stopUptimeTimer();
        this.stopConnectionStatsMonitoring();
        
        if (this.state.settings.autoReconnect && this.state.hostPeerId) {
            this.showNotification('Intentando reconectar en 3 segundos...', 'warning');
            setTimeout(() => {
                if (this.state.hostPeerId && !this.state.isConnected) {
                    this.attemptConnection(this.state.hostPeerId);
                }
            }, 3000);
        }
    }
}

// Inicializar aplicación
document.addEventListener('DOMContentLoaded', () => {
    if (!navigator.mediaDevices || !window.Peer) {
        alert('No se pudo iniciar la aplicación. Abre la página por HTTPS (o localhost), usa un navegador actualizado y comprueba tu conexión a Internet.');
        return;
    }
    
    window.app = new RemoteVisionApp();
    
    const urlParams = new URLSearchParams(window.location.search);
    const connectTo = urlParams.get('connect');
    if (connectTo) {
        setTimeout(() => {
            window.app.setViewerMode();
            window.app.elements.peerCodeInput.value = connectTo.toUpperCase();
            setTimeout(() => {
                window.app.connectToEmitter();
            }, 1000);
        }, 500);
    }
});
