class SimpleSurveillance {
    constructor() {
        // Elementos del DOM
        this.elements = {
            startScreen: document.getElementById('startScreen'),
            emitterPanel: document.getElementById('emitterPanel'),
            viewerPanel: document.getElementById('viewerPanel'),
            
            btnEmitter: document.getElementById('btnEmitter'),
            btnViewer: document.getElementById('btnViewer'),
            backFromEmitter: document.getElementById('backFromEmitter'),
            backFromViewer: document.getElementById('backFromViewer'),
            
            emitterCode: document.getElementById('emitterCode'),
            localVideo: document.getElementById('localVideo'),
            btnStartEmitter: document.getElementById('btnStartEmitter'),
            btnCopyCode: document.getElementById('btnCopyCode'),
            emitterStatus: document.getElementById('emitterStatus'),
            
            peerCodeInput: document.getElementById('peerCodeInput'),
            btnConnect: document.getElementById('btnConnect'),
            remoteVideo: document.getElementById('remoteVideo'),
            viewerStatus: document.getElementById('viewerStatus'),
            btnStartAudio: document.getElementById('btnStartAudio'),
            btnToggleFullscreen: document.getElementById('btnToggleFullscreen')
        };

        // Estado
        this.peer = null;
        this.localStream = null;
        this.remoteStream = null;
        this.currentConnection = null;
        this.isEmitter = false;
        this.isConnected = false;
        this.peerId = null;
        this.audioEnabled = false;

        // Inicializar
        this.init();
    }

    init() {
        // Event listeners
        this.elements.btnEmitter.addEventListener('click', () => this.setEmitterMode());
        this.elements.btnViewer.addEventListener('click', () => this.setViewerMode());
        this.elements.backFromEmitter.addEventListener('click', () => this.showStartScreen());
        this.elements.backFromViewer.addEventListener('click', () => this.showStartScreen());
        this.elements.btnStartEmitter.addEventListener('click', () => this.startEmitter());
        this.elements.btnCopyCode.addEventListener('click', () => this.copyCode());
        this.elements.btnConnect.addEventListener('click', () => this.connectToEmitter());
        this.elements.btnStartAudio.addEventListener('click', () => this.toggleAudio());
        this.elements.btnToggleFullscreen.addEventListener('click', () => this.toggleFullscreen());
        this.elements.peerCodeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.connectToEmitter();
        });

        // Generar código aleatorio para el emisor
        this.generateRandomCode();

        // Inicializar PeerJS
        this.initializePeerJS();
    }

    generateRandomCode() {
        // Generar código de 6 caracteres alfanuméricos
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        this.elements.emitterCode.textContent = code;
    }

    initializePeerJS() {
        // Usar servidor PeerJS público
        this.peer = new Peer({
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            secure: true,
            debug: 3
        });

        this.peer.on('open', (id) => {
            console.log('Conectado a PeerJS con ID:', id);
        });

        this.peer.on('error', (err) => {
            console.error('Error de PeerJS:', err);
            this.showError('Error de conexión. Recarga la página.');
        });

        // Cuando alguien se conecta al emisor
        this.peer.on('connection', (conn) => {
            conn.on('data', (data) => {
                if (data.type === 'audio-toggle' && this.localStream) {
                    // El supervisor quiere activar/desactivar audio
                    this.updateAudioStatus(data.enabled);
                }
            });
        });

        // Cuando alguien llama al emisor
        this.peer.on('call', (call) => {
            if (this.isEmitter && this.localStream) {
                call.answer(this.localStream);
                this.currentConnection = call;
                
                call.on('stream', (stream) => {
                    // Emisor recibe audio del supervisor (opcional)
                    console.log('Audio recibido del supervisor');
                });
                
                call.on('close', () => {
                    this.updateEmitterStatus('Supervisor desconectado');
                });
            }
        });
    }

    setEmitterMode() {
        this.isEmitter = true;
        this.elements.startScreen.classList.add('hidden');
        this.elements.emitterPanel.classList.remove('hidden');
        this.elements.viewerPanel.classList.add('hidden');
        this.updateEmitterStatus('Listo para transmitir');
    }

    setViewerMode() {
        this.isEmitter = false;
        this.elements.startScreen.classList.add('hidden');
        this.elements.viewerPanel.classList.remove('hidden');
        this.elements.emitterPanel.classList.add('hidden');
        this.updateViewerStatus('Introduce el código del emisor', 'connecting');
    }

    showStartScreen() {
        // Limpiar conexiones
        if (this.isEmitter) {
            this.stopEmitter();
        } else {
            this.disconnectFromEmitter();
        }
        
        this.isEmitter = false;
        this.elements.emitterPanel.classList.add('hidden');
        this.elements.viewerPanel.classList.add('hidden');
        this.elements.startScreen.classList.remove('hidden');
    }

    async startEmitter() {
        try {
            this.updateEmitterStatus('Solicitando acceso a cámara y micrófono...');
            
            // Solicitar acceso a cámara y micrófono
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'environment'
                },
                audio: true
            });

            this.elements.localVideo.srcObject = this.localStream;
            this.elements.btnStartEmitter.textContent = '⏸️ Pausar Transmisión';
            this.updateEmitterStatus('Transmitiendo en vivo ✓');
            
            // Actualizar PeerJS con nuestro código generado
            const code = this.elements.emitterCode.textContent;
            this.peer.id = code;
            
        } catch (error) {
            console.error('Error al acceder a los dispositivos:', error);
            
            if (error.name === 'NotAllowedError') {
                this.showError('Se denegó el acceso a la cámara/micrófono');
            } else if (error.name === 'NotFoundError') {
                this.showError('No se encontró cámara o micrófono');
            } else {
                this.showError('Error: ' + error.message);
            }
        }
    }

    stopEmitter() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
            this.elements.localVideo.srcObject = null;
        }
        
        if (this.currentConnection) {
            this.currentConnection.close();
            this.currentConnection = null;
        }
        
        this.elements.btnStartEmitter.textContent = '▶️ Iniciar Transmisión';
        this.updateEmitterStatus('Transmisión detenida');
    }

    async connectToEmitter() {
        const code = this.elements.peerCodeInput.value.trim().toUpperCase();
        if (!code) {
            this.showError('Por favor ingresa un código válido');
            return;
        }

        this.updateViewerStatus('Conectando con el emisor...', 'connecting');

        try {
            // Conectar al emisor
            const call = this.peer.call(code);
            
            call.on('stream', (stream) => {
                this.remoteStream = stream;
                this.elements.remoteVideo.srcObject = stream;
                this.isConnected = true;
                
                this.updateViewerStatus('Conectado ✓ Transmisión en vivo', 'connected');
                this.elements.btnStartAudio.disabled = false;
            });

            call.on('close', () => {
                this.disconnectFromEmitter();
                this.updateViewerStatus('Desconectado del emisor', 'connecting');
            });

            call.on('error', (err) => {
                console.error('Error en la llamada:', err);
                this.showError('No se pudo conectar. Verifica el código.');
            });

            this.currentConnection = call;

        } catch (error) {
            console.error('Error al conectar:', error);
            this.showError('Error de conexión. Intenta nuevamente.');
        }
    }

    async toggleAudio() {
        if (!this.audioEnabled) {
            try {
                const audioStream = await navigator.mediaDevices.getUserMedia({
                    audio: true
                });
                
                // Enviar audio al emisor
                if (this.currentConnection) {
                    const audioTrack = audioStream.getAudioTracks()[0];
                    const sender = this.currentConnection.peerConnection.getSenders()
                        .find(s => s.track && s.track.kind === 'audio');
                    
                    if (sender) {
                        sender.replaceTrack(audioTrack);
                    }
                }
                
                this.audioEnabled = true;
                this.elements.btnStartAudio.textContent = '🔇 Silenciar Micrófono';
                this.updateViewerStatus('Micrófono activado - Hablando', 'connected');
                
            } catch (error) {
                console.error('Error al acceder al micrófono:', error);
                this.showError('No se pudo acceder al micrófono');
            }
        } else {
            // Silenciar micrófono
            if (this.currentConnection) {
                const sender = this.currentConnection.peerConnection.getSenders()
                    .find(s => s.track && s.track.kind === 'audio');
                
                if (sender && sender.track) {
                    sender.track.stop();
                    sender.replaceTrack(null);
                }
            }
            
            this.audioEnabled = false;
            this.elements.btnStartAudio.textContent = '🎤 Hablar con Emisor';
            this.updateViewerStatus('Micrófono desactivado', 'connected');
        }
    }

    disconnectFromEmitter() {
        if (this.currentConnection) {
            this.currentConnection.close();
            this.currentConnection = null;
        }
        
        if (this.remoteStream) {
            this.remoteStream.getTracks().forEach(track => track.stop());
            this.remoteStream = null;
            this.elements.remoteVideo.srcObject = null;
        }
        
        this.isConnected = false;
        this.audioEnabled = false;
        this.elements.btnStartAudio.disabled = true;
        this.elements.btnStartAudio.textContent = '🎤 Hablar con Emisor';
    }

    copyCode() {
        const code = this.elements.emitterCode.textContent;
        navigator.clipboard.writeText(code).then(() => {
            this.updateEmitterStatus('Código copiado al portapapeles ✓');
            setTimeout(() => {
                this.updateEmitterStatus('Transmitiendo en vivo ✓');
            }, 2000);
        }).catch(err => {
            console.error('Error al copiar:', err);
            this.showError('Error al copiar el código');
        });
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
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            }
        }
    }

    updateEmitterStatus(message) {
        this.elements.emitterStatus.textContent = message;
        this.elements.emitterStatus.className = 'status';
        
        if (message.includes('Error')) {
            this.elements.emitterStatus.classList.add('status-error');
        } else if (message.includes('Transmitiendo')) {
            this.elements.emitterStatus.classList.add('status-connected');
        } else {
            this.elements.emitterStatus.classList.add('status-connecting');
        }
    }

    updateViewerStatus(message, type = 'connecting') {
        this.elements.viewerStatus.textContent = message;
        this.elements.viewerStatus.className = 'status';
        
        if (type === 'connected') {
            this.elements.viewerStatus.classList.add('status-connected');
        } else if (type === 'error') {
            this.elements.viewerStatus.classList.add('status-error');
        } else {
            this.elements.viewerStatus.classList.add('status-connecting');
        }
    }

    updateAudioStatus(enabled) {
        // Para el emisor: mostrar si el supervisor está hablando
        if (this.isEmitter) {
            const status = enabled ? 'Supervisor hablando...' : 'Transmitiendo en vivo ✓';
            this.updateEmitterStatus(status);
        }
    }

    showError(message) {
        if (this.isEmitter) {
            this.updateEmitterStatus(`Error: ${message}`);
        } else {
            this.updateViewerStatus(`Error: ${message}`, 'error');
        }
        
        setTimeout(() => {
            if (this.isEmitter) {
                this.updateEmitterStatus('Listo para transmitir');
            } else {
                this.updateViewerStatus('Introduce el código del emisor', 'connecting');
            }
        }, 3000);
    }
}

// Inicializar la aplicación
document.addEventListener('DOMContentLoaded', () => {
    // Verificar compatibilidad con WebRTC
    if (!navigator.mediaDevices || !window.Peer) {
        alert('Tu navegador no soporta WebRTC. Usa Chrome, Firefox o Edge actualizado.');
        return;
    }
    
    new SimpleSurveillance();
});