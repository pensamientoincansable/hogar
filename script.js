class RemoteVisionApp {
    constructor() {
        // Configuración mejorada
        this.config = {
            peerServer: {
                host: '0.peerjs.com',
                port: 443,
                path: '/',
                secure: true,
                debug: 2,
                config: {
                    'iceServers': [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' },
                        { 
                            urls: 'turn:numb.viagenie.ca',
                            credential: 'muazkh',
                            username: 'webrtc@live.com'
                        }
                    ]
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

        // Elementos del DOM
        this.elements = {
            // Pantallas
            modeSelection: document.getElementById('modeSelection'),
            emitterPanel: document.getElementById('emitterPanel'),
            viewerPanel: document.getElementById('viewerPanel'),
            
            // Modo selección
            btnEmitter: document.getElementById('btnEmitter'),
            btnViewer: document.getElementById('btnViewer'),
            
            // Panel Emisor
            backFromEmitter: document.getElementById('backFromEmitter'),
            localVideo: document.getElementById('localVideo'),
            emitterCode: document.getElementById('emitterCode'),
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
            
            // Panel Supervisor
            backFromViewer: document.getElementById('backFromViewer'),
            peerCodeInput: document.getElementById('peerCodeInput'),
            btnConnect: document.getElementById('btnConnect'),
            remoteVideo: document.getElementById('remoteVideo'),
            connectionOverlay: document.getElementById('connectionOverlay'),
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
            
            // Estado global
            connectionStatus: document.getElementById('connectionStatus'),
            
            // Notificaciones y modal
            notificationContainer: document.getElementById('notificationContainer'),
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
        
        this.generateDisplayCode();
        
        this.loadRecentCodes();
        
        this.elements.videoQuality.value = this.state.settings.videoQuality;
        
        this.showNotification('Sistema inicializado correctamente', 'success');
    }

    async initializePeerJS(customId = null) {
        return new Promise((resolve, reject) => {
            if (this.peer && !this.peer.disconnected) {
                this.peer.destroy();
                this.peer = null;
            }
            
            try {
                this.peer = customId ? 
                    new Peer(customId, this.config.peerServer) : 
                    new Peer(this.config.peerServer);
                
                this.peer.on('open', (id) => {
                    console.log('✅ PeerJS conectado con ID:', id);
                    this.state.peerId = id;
                    this.updateConnectionStatus('🟢 Conectado al servidor');
                    resolve();
                });
                
                this.peer.on('error', (err) => {
                    console.error('❌ Error de PeerJS:', err);
                    
                    let errorMsg = 'Error de conexión';
                    switch(err.type) {
                        case 'peer-unavailable':
                            errorMsg = 'El código ingresado no existe o ha expirado';
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
                    }
                    
                    if (err.type !== 'disconnected') {
                        reject(errorMsg);
                    }
                });
                
                this.peer.on('connection', (conn) => {
                    console.log('📡 Conexión de datos recibida de:', conn.peer);
                    this.setupDataConnection(conn);
                });
                
                this.peer.on('call', (call) => {
                    console.log('📞 Llamada recibida de:', call.peer);
                    this.handleIncomingCall(call);
                });
                
                // Timeout para inicialización
                const initTimeout = setTimeout(() => {
                    if (!this.state.peerId) {
                        reject('Timeout al conectar con el servidor PeerJS');
                    }
                }, 15000);
                
                this.connectionTimeouts.push(initTimeout);
                
            } catch (error) {
                console.error('Error al crear instancia de Peer:', error);
                reject('Error al inicializar PeerJS');
            }
        });
    }

    setupEventListeners() {
        // Modo selección
        this.elements.btnEmitter.addEventListener('click', () => this.setEmitterMode());
        this.elements.btnViewer.addEventListener('click', () => this.setViewerMode());
        
        // Navegación
        this.elements.backFromEmitter.addEventListener('click', () => this.showModeSelection());
        this.elements.backFromViewer.addEventListener('click', () => this.showModeSelection());
        
        // Panel Emisor
        this.elements.btnStartEmitter.addEventListener('click', () => this.toggleEmitterStream());
        this.elements.btnStopEmitter.addEventListener('click', () => this.stopEmitter());
        this.elements.btnCopyCode.addEventListener('click', () => this.copyCode());
        this.elements.btnRefreshCode.addEventListener('click', () => this.generateDisplayCode());
        this.elements.btnSwitchCamera.addEventListener('click', () => this.switchCamera());
        this.elements.btnFlipCamera.addEventListener('click', () => this.flipCamera());
        this.elements.btnAudioToggle.addEventListener('click', () => this.toggleEmitterAudio());
        this.elements.videoQuality.addEventListener('change', (e) => this.changeVideoQuality(e.target.value));
        
        // Panel Supervisor
        this.elements.btnConnect.addEventListener('click', () => this.connectToEmitter());
        this.elements.peerCodeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.connectToEmitter();
        });
        this.elements.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
        this.elements.btnTakeSnapshot.addEventListener('click', () => this.takeSnapshot());
        this.elements.btnMuteAudio.addEventListener('click', () => this.toggleMute());
        this.elements.btnStartAudio.addEventListener('click', () => this.startViewerAudio());
        this.elements.btnStopAudio.addEventListener('click', () => this.stopViewerAudio());
        this.elements.btnTestAudio.addEventListener('click', () => this.testAudio());
        this.elements.remoteVolume.addEventListener('input', (e) => this.changeRemoteVolume(e.target.value));
        
        // Modal de error
        this.elements.btnRetry.addEventListener('click', () => this.retryConnection());
        this.elements.modalClose.addEventListener('click', () => this.hideErrorModal());
        this.elements.closeModal.addEventListener('click', () => this.hideErrorModal());
        this.elements.errorModal.addEventListener('click', (e) => {
            if (e.target === this.elements.errorModal) this.hideErrorModal();
        });
    }

    generateDisplayCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        
        this.state.displayCode = code;
        this.elements.emitterCode.textContent = code;
        
        this.showNotification('Nuevo código generado: ' + code, 'success');
    }

    copyCode() {
        navigator.clipboard.writeText(this.state.displayCode).then(() => {
            this.showNotification('Código copiado al portapapeles', 'success');
        }).catch(err => {
            console.error('Error al copiar:', err);
            this.showNotification('Error al copiar el código', 'error');
        });
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
        try {
            this.showNotification('Activando modo emisor...', 'info');
            
            await this.initializePeerJS(this.state.displayCode);
            
            this.state.isEmitter = true;
            this.state.isViewer = false;
            
            this.elements.modeSelection.classList.add('hidden');
            this.elements.emitterPanel.classList.remove('hidden');
            this.elements.viewerPanel.classList.add('hidden');
            
            this.updateEmitterStatus('Listo para transmitir', 'ready');
            this.showNotification('Modo emisor activado', 'success');
            
        } catch (error) {
            console.error('Error al activar modo emisor:', error);
            this.showNotification('Error al activar modo emisor: ' + error, 'error');
            this.showModeSelection();
        }
    }

    async setViewerMode() {
        try {
            this.showNotification('Activando modo supervisor...', 'info');
            
            // Generar ID único para el supervisor
            const viewerId = 'viewer-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            await this.initializePeerJS(viewerId);
            
            this.state.isEmitter = false;
            this.state.isViewer = true;
            
            this.elements.modeSelection.classList.add('hidden');
            this.elements.viewerPanel.classList.remove('hidden');
            this.elements.emitterPanel.classList.add('hidden');
            
            this.updateViewerStatus('Desconectado', 'disconnected');
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
        
        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }
        
        // Limpiar todos los timeouts
        this.clearAllTimeouts();
        
        this.state.isEmitter = false;
        this.state.isViewer = false;
        this.state.isConnected = false;
        this.state.peerId = null;
        
        this.elements.emitterPanel.classList.add('hidden');
        this.elements.viewerPanel.classList.add('hidden');
        this.elements.modeSelection.classList.remove('hidden');
        
        this.updateConnectionStatus('🟢 Selecciona un modo');
        this.showNotification('Selecciona un modo de operación', 'info');
    }

    // ===== EMISOR =====
    async toggleEmitterStream() {
        console.log('toggleEmitterStream llamado, isStreaming:', this.state.isStreaming);
        if (!this.state.isStreaming) {
            await this.startEmitter();
        } else {
            this.stopEmitter();
        }
    }

    async startEmitter() {
        console.log('startEmitter iniciando...');
        try {
            this.showNotification('Iniciando transmisión...', 'info');
            
            // Obtener lista de dispositivos primero
            await this.getMediaDevices();
            
            // Configurar cámara frontal por defecto
            const facingMode = this.state.isFrontCamera ? 'user' : 'environment';
            
            const constraints = {
                video: {
                    ...this.config.videoQuality[this.state.settings.videoQuality],
                    facingMode: facingMode,
                    deviceId: this.currentDeviceId ? { exact: this.currentDeviceId } : undefined
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 2,
                    sampleRate: 48000
                }
            };
            
            console.log('Solicitando permisos de medios con constraints:', constraints);
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Stream obtenido exitosamente:', this.localStream);
            
            // Mostrar video local
            this.elements.localVideo.srcObject = this.localStream;
            this.elements.localVideo.muted = true; // Silenciar audio local para evitar eco
            
            // Intentar reproducir automáticamente
            await this.elements.localVideo.play().catch(e => {
                console.log('Video local autoplay bloqueado:', e);
            });
            
            // Actualizar UI
            this.elements.btnStartEmitter.classList.add('hidden');
            this.elements.btnStopEmitter.classList.remove('hidden');
            this.state.isStreaming = true;
            
            // Actualizar estado
            this.updateEmitterStatus('Transmitiendo en vivo', 'streaming');
            this.updateQualityTag();
            
            // Habilitar controles
            this.elements.btnAudioToggle.disabled = false;
            
            this.showNotification('Transmisión iniciada correctamente', 'success');
            
            // Notificar a viewers conectados
            if (this.state.connectedViewers.size > 0) {
                this.showNotification(`${this.state.connectedViewers.size} supervisor(es) conectado(s)`, 'info');
            }
            
        } catch (error) {
            console.error('Error al iniciar transmisión:', error);
            this.handleMediaError(error);
        }
    }

    stopEmitter() {
        console.log('stopEmitter llamado');
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
            this.elements.localVideo.srcObject = null;
        }
        
        // Cerrar conexiones activas
        if (this.currentCall) {
            this.currentCall.close();
            this.currentCall = null;
        }
        
        if (this.dataConnection) {
            this.dataConnection.close();
            this.dataConnection = null;
        }
        
        // Limpiar audio del supervisor si existe
        if (this.supervisorAudioElement) {
            this.supervisorAudioElement.remove();
            this.supervisorAudioElement = null;
        }
        
        // Actualizar UI
        this.elements.btnStartEmitter.classList.remove('hidden');
        this.elements.btnStopEmitter.classList.add('hidden');
        this.state.isStreaming = false;
        
        // Limpiar lista de viewers
        this.state.connectedViewers.clear();
        this.updateConnectedClients();
        
        this.updateEmitterStatus('Transmisión detenida', 'disconnected');
        this.showNotification('Transmisión detenida', 'info');
    }

    async switchCamera() {
        if (!this.localStream) return;
        
        try {
            // Obtener dispositivos disponibles
            await this.getMediaDevices();
            
            if (this.mediaDevices.length < 2) {
                this.showNotification('No se encontró otra cámara', 'warning');
                return;
            }
            
            // Cambiar entre frontal/trasera
            this.state.isFrontCamera = !this.state.isFrontCamera;
            
            // Detener track actual
            const currentTrack = this.localStream.getVideoTracks()[0];
            currentTrack.stop();
            
            // Encontrar nueva cámara
            const facingMode = this.state.isFrontCamera ? 'user' : 'environment';
            const device = this.mediaDevices.find(d => 
                d.label.toLowerCase().includes(facingMode === 'user' ? 'front' : 'back') ||
                d.label.toLowerCase().includes(facingMode === 'user' ? 'delantera' : 'trasera')
            ) || this.mediaDevices[0];
            
            this.currentDeviceId = device.deviceId;
            
            // Obtener nuevo stream
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
            
            // Reemplazar track de video
            const newVideoTrack = newStream.getVideoTracks()[0];
            const audioTrack = this.localStream.getAudioTracks()[0];
            
            this.localStream.removeTrack(currentTrack);
            this.localStream.addTrack(newVideoTrack);
            
            // Actualizar conexiones activas
            if (this.currentCall) {
                const sender = this.currentCall.peerConnection.getSenders()
                    .find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(newVideoTrack);
                }
            }
            
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
                // Seleccionar cámara frontal por defecto
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
        const code = this.elements.peerCodeInput.value.trim().toUpperCase();
        
        if (!code || code.length !== 6) {
            this.showNotification('Ingresa un código válido de 6 caracteres', 'warning');
            return;
        }
        
        // Guardar código reciente
        this.saveRecentCode(code);
        
        this.state.hostPeerId = code;
        this.state.connectionAttempts = 0;
        
        this.updateViewerStatus('Conectando...', 'connecting');
        this.showNotification(`Conectando a ${code}...`, 'info');
        
        // Intentar conectar
        await this.attemptConnection(code);
    }

    async attemptConnection(code) {
        try {
            // Limpiar timeouts anteriores
            this.clearAllTimeouts();
            
            if (!this.peer || this.peer.disconnected) {
                throw new Error('No conectado al servidor PeerJS');
            }
            
            // Primero intentamos conexión de datos con timeout
            await this.attemptDataConnection(code);
            
            // Ahora intentamos la llamada de video
            await this.attemptVideoCall(code);
            
        } catch (error) {
            console.error('Error en attemptConnection:', error);
            this.handleConnectionError(error.message);
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
                
                dataConn.on('data', (data) => {
                    this.handleDataMessage(data);
                });
                
                dataConn.on('close', () => {
                    console.log('Conexión de datos cerrada');
                    this.dataConnection = null;
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

    async attemptVideoCall(code) {
        return new Promise(async (resolve, reject) => {
            try {
                // Timeout para la llamada de video
                const callTimeout = setTimeout(() => {
                    reject(new Error('Timeout esperando stream del emisor (20 segundos)'));
                }, 20000);
                
                this.connectionTimeouts.push(callTimeout);
                
                // Crear un stream de audio para la llamada
                await this.createLocalAudioStream();
                
                // Ahora llamamos CON el stream local, como exige PeerJS
                const call = this.peer.call(code, this.localAudioStream);
                
                if (!call) {
                    clearTimeout(callTimeout);
                    throw new Error('No se pudo crear la llamada');
                }
                
                call.on('stream', (remoteStream) => {
                    clearTimeout(callTimeout);
                    console.log('✅ Stream remoto recibido');
                    this.handleRemoteStream(remoteStream);
                    resolve();
                });
                
                call.on('close', () => {
                    clearTimeout(callTimeout);
                    console.log('Llamada cerrada');
                    if (!this.state.isConnected) {
                        reject(new Error('Llamada cerrada antes de recibir stream'));
                    } else {
                        this.handleDisconnection();
                    }
                });
                
                call.on('error', (err) => {
                    clearTimeout(callTimeout);
                    console.error('Error en llamada:', err);
                    reject(new Error('Error en la llamada de video: ' + err.message));
                });
                
                this.currentCall = call;
                
            } catch (error) {
                reject(error);
            }
        });
    }

    async createLocalAudioStream() {
        // Intenta obtener un stream de micrófono real pero silenciado
        try {
            this.localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.localAudioStream.getAudioTracks().forEach(track => {
                track.enabled = false; // Silenciado por defecto
            });
            console.log('✅ Stream de audio local creado (micrófono real, silenciado)');
        } catch (err) {
            console.warn('No se pudo obtener permiso de micrófono. Creando stream de audio silencioso...', err);
            
            // Fallback: Crea un stream de audio silencioso con AudioContext
            try {
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                // Configurar oscilador silencioso
                gainNode.gain.value = 0; // Volumen en 0 = silencioso
                oscillator.connect(gainNode);
                
                const destination = audioContext.createMediaStreamDestination();
                gainNode.connect(destination);
                
                oscillator.start();
                this.localAudioStream = destination.stream;
                
                // Detenemos el oscilador, el stream sigue siendo válido
                setTimeout(() => {
                    oscillator.stop();
                }, 100);
                
                console.log('✅ Stream de audio local creado (audio silencioso sintético)');
            } catch (audioError) {
                console.error('Error crítico: No se pudo crear ningún stream de audio', audioError);
                throw new Error('Se necesita acceso al micrófono o compatibilidad con AudioContext para iniciar la llamada');
            }
        }
    }

    handleRemoteStream(stream) {
        this.remoteStream = stream;
        this.elements.remoteVideo.srcObject = stream;
        this.elements.connectionOverlay.classList.add('hidden');
        
        // Configurar eventos del video para móviles
        this.setupVideoForMobile();
        
        // Asegurarse de que el video no esté silenciado por defecto
        this.elements.remoteVideo.muted = false;
        this.elements.remoteVideo.volume = this.elements.remoteVolume.value / 100;
        
        // Verificar que el stream tenga video y audio
        const videoTracks = stream.getVideoTracks();
        const audioTracks = stream.getAudioTracks();
        
        console.log('Stream recibido - Video tracks:', videoTracks.length, 'Audio tracks:', audioTracks.length);
        
        if (videoTracks.length === 0) {
            this.showNotification('Advertencia: No se detectó video en la transmisión', 'warning');
        }
        
        if (audioTracks.length === 0) {
            this.showNotification('Advertencia: No se detectó audio en la transmisión', 'warning');
        } else {
            // Configurar audio del emisor
            audioTracks[0].enabled = true;
        }
        
        this.state.isConnected = true;
        this.updateViewerStatus('Conectado', 'streaming');
        this.updateConnectionState('Conectado');
        
        // Habilitar controles
        this.elements.btnStartAudio.classList.remove('disabled');
        this.elements.btnStartAudio.disabled = false;
        
        // Iniciar temporizador de conexión
        this.startUptimeTimer();
        
        // Iniciar monitoreo de conexión
        this.startConnectionStatsMonitoring();
        
        this.showNotification('¡Conectado a la transmisión!', 'success');
        
        // Actualizar estadísticas periódicamente
        this.updateConnectionStats();
    }

    setupVideoForMobile() {
        const video = this.elements.remoteVideo;
        
        // Para iOS, necesitamos playsinline para que el video se reproduzca en la página
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.setAttribute('muted', 'false');
        
        // Configurar eventos de reproducción
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
                    
                    // Remover listeners después de usarlos
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
            console.log('✅ Conexión de datos recibida de emisor:', conn.peer);
            this.dataConnection = conn;
            
            conn.on('data', (data) => {
                this.handleDataMessage(data);
            });
            
            conn.on('close', () => {
                console.log('Conexión de datos cerrada');
                this.dataConnection = null;
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
            const message = JSON.parse(data);
            
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
                    // Responder al ping para medir latencia
                    if (this.dataConnection) {
                        this.dataConnection.send(JSON.stringify({
                            type: 'pong',
                            timestamp: message.timestamp,
                            receivedAt: Date.now()
                        }));
                    }
                    break;
                    
                case 'pong':
                    // Calcular latencia
                    const latency = Date.now() - message.timestamp;
                    this.elements.latencyValue.textContent = `${latency} ms`;
                    break;
            }
        } catch (error) {
            console.log('Mensaje recibido:', data);
        }
    }

    handleIncomingCall(call) {
        if (this.state.isEmitter && this.localStream) {
            // El emisor responde con su stream local (video y audio)
            call.answer(this.localStream);
            this.currentCall = call;
            
            console.log('✅ Aceptada llamada de:', call.peer);
            
            // Notificar al emisor sobre el nuevo viewer
            if (this.dataConnection) {
                this.dataConnection.send(JSON.stringify({
                    type: 'viewer-connected',
                    viewerId: call.peer
                }));
            }
            
            // Agregar viewer a la lista
            this.state.connectedViewers.add(call.peer);
            this.updateConnectedClients();
            
            // Escuchar el audio del supervisor cuando active su micrófono
            call.on('stream', (supervisorStream) => {
                console.log('Audio recibido del supervisor:', call.peer);
                
                // Crear un elemento de audio oculto para reproducir el audio del supervisor
                if (!this.supervisorAudioElement) {
                    this.supervisorAudioElement = document.createElement('audio');
                    this.supervisorAudioElement.autoplay = true;
                    this.supervisorAudioElement.volume = 1.0;
                    this.supervisorAudioElement.style.display = 'none';
                    document.body.appendChild(this.supervisorAudioElement);
                }
                
                // Asignar el stream al elemento de audio
                this.supervisorAudioElement.srcObject = supervisorStream;
                
                // Configurar para reproducción automática
                this.supervisorAudioElement.play().catch(e => {
                    console.log('Audio del supervisor autoplay bloqueado:', e);
                });
                
                this.showNotification('Supervisor habilitó audio bidireccional', 'info');
            });
            
            call.on('close', () => {
                console.log('Llamada cerrada por supervisor:', call.peer);
                if (this.dataConnection) {
                    this.dataConnection.send(JSON.stringify({
                        type: 'viewer-disconnected',
                        viewerId: call.peer
                    }));
                }
                this.state.connectedViewers.delete(call.peer);
                this.updateConnectedClients();
                
                // Limpiar audio del supervisor
                if (this.supervisorAudioElement) {
                    this.supervisorAudioElement.remove();
                    this.supervisorAudioElement = null;
                }
            });
            
            call.on('error', (err) => {
                console.error('Error en llamada con supervisor:', err);
                this.state.connectedViewers.delete(call.peer);
                this.updateConnectedClients();
            });
        } else if (this.state.isEmitter && !this.localStream) {
            // El emisor no está transmitiendo, rechazar la llamada
            console.log('Emisor no está transmitiendo, rechazando llamada');
            call.close();
        }
    }

    async startViewerAudio() {
        try {
            // Obtener un nuevo stream de micrófono REAL y activado
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
            
            // Detener el track de audio antiguo (el silencioso)
            if (this.localAudioStream) {
                this.localAudioStream.getTracks().forEach(track => track.stop());
            }
            
            // Reemplazar el stream local con el nuevo
            this.localAudioStream = newAudioStream;
            
            if (this.currentCall) {
                const newAudioTrack = newAudioStream.getAudioTracks()[0];
                const senders = this.currentCall.peerConnection.getSenders();
                const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                
                if (audioSender) {
                    // Reemplazar el track de audio existente en la conexión WebRTC
                    audioSender.replaceTrack(newAudioTrack);
                } else {
                    // Esto no debería pasar, pero por si acaso se agrega
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
                // No detenemos el track aquí, solo lo reemplazamos por null
                // Esto detiene el envío pero mantiene la capacidad de reanudar
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
        
        // Crear enlace de descarga
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
        // Limpiar timeouts
        this.clearAllTimeouts();
        
        if (this.currentCall) {
            this.currentCall.close();
            this.currentCall = null;
        }
        
        if (this.dataConnection) {
            this.dataConnection.close();
            this.dataConnection = null;
        }
        
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
        this.elements.btnStartAudio.classList.add('hidden');
        this.elements.btnStopAudio.classList.add('hidden');
        this.elements.btnStartAudio.classList.add('disabled');
        this.elements.btnMuteAudio.innerHTML = '<i class="fas fa-volume-up"></i> Sonido: ON';
        
        this.updateViewerStatus('Desconectado', 'disconnected');
        this.updateConnectionState('Desconectado');
        
        // Detener temporizador
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
            this.showErrorModal(`No se pudo conectar después de ${this.state.connectionAttempts} intentos: ${error}`);
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

    updateConnectionStats() {
        if (!this.state.isConnected) return;
        
        // Enviar ping para medir latencia
        if (this.dataConnection) {
            this.dataConnection.send(JSON.stringify({
                type: 'ping',
                timestamp: Date.now()
            }));
        }
        
        // Actualizar estadísticas de conexión
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
        // Limpiar todos los timeouts almacenados
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
    // Verificar compatibilidad
    if (!navigator.mediaDevices || !window.Peer) {
        alert('Tu navegador no es compatible. Por favor, usa Chrome, Firefox o Edge actualizado.');
        return;
    }
    
    // Inicializar
    window.app = new RemoteVisionApp();
    
    // Manejar conexión por parámetro de URL
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
