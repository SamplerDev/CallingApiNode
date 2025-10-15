const socket = io();

// --- ELEMENTOS DEL DOM Y ESTADO ---
const statusEl = document.getElementById('status');
const incomingCallEl = document.getElementById('incoming-call');
const activeCallEl = document.getElementById('active-call');
const callerNameEl = document.getElementById('caller-name');
const callerNumberEl = document.getElementById('caller-number');
const acceptBtn = document.getElementById('accept-btn');
const rejectBtn = document.getElementById('reject-btn');
const terminateBtn = document.getElementById('terminate-btn');
const remoteAudio = document.getElementById('remote-audio');
const timerEl = document.getElementById('timer');

let pc; // PeerConnection
let localStream;
let currentCallId;
let serverOfferSdp; // Almacenamos la oferta del servidor
let timerInterval;

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// --- LÓGICA DE SOCKET.IO ---
socket.on('connect', () => {
    statusEl.textContent = 'Conectado. Esperando llamadas...';
    console.log('Conectado al servidor con ID:', socket.id);
});

// ====================================================================
// === CAMBIO DE ARQUITECTURA: EL SERVIDOR ENVÍA UNA OFERTA DIRECTAMENTE ===
// ====================================================================
socket.on('offer-from-server', ({ callId, callerName, sdp }) => {
    console.log(`Oferta recibida del servidor para la llamada ${callId}`);
    // Solo procesar si no estamos ya en una llamada
    if (currentCallId) {
        console.warn("Llamada entrante ignorada, ya hay una activa.");
        return;
    }
    currentCallId = callId;
    serverOfferSdp = sdp;
    
    callerNameEl.textContent = callerName;
    callerNumberEl.textContent = callId; // Opcional: mostrar el ID
    incomingCallEl.classList.remove('hidden');
    statusEl.textContent = `Llamada entrante de ${callerName}`;
});

socket.on('call-active', ({ callId }) => {
    if (callId !== currentCallId) return;
    statusEl.textContent = 'Llamada en curso.';
    incomingCallEl.classList.add('hidden');
    activeCallEl.classList.remove('hidden');
    startTimer();
});

socket.on('call-terminated', ({ callId }) => {
    if (callId !== currentCallId) return;
    statusEl.textContent = 'Llamada terminada.';
    resetUI();
});

// --- LÓGICA DE BOTONES Y WEBRTC ---
acceptBtn.addEventListener('click', acceptCall);
rejectBtn.addEventListener('click', () => {
    // Para rechazar, simplemente colgamos sin haber aceptado
    socket.emit('hangup-from-browser', currentCallId);
    resetUI();
});
terminateBtn.addEventListener('click', () => {
    socket.emit('hangup-from-browser', currentCallId);
    resetUI();
});

// ====================================================================
// === CAMBIO DE ARQUITECTURA: AHORA CREAMOS UNA RESPUESTA, NO UNA OFERTA ===
// ====================================================================
async function acceptCall() {
    if (!serverOfferSdp) return console.error("No hay oferta del servidor para aceptar.");

    console.log('Aceptando llamada...', currentCallId);
    incomingCallEl.classList.add('hidden');

    try {
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        pc.ontrack = (event) => {
            console.log("Recibiendo track de audio remoto...");
            remoteAudio.srcObject = event.streams[0];
        };

        // Añadir nuestro micrófono a la conexión
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        // 1. Establecer la oferta del servidor como descripción remota
        await pc.setRemoteDescription({ type: 'offer', sdp: serverOfferSdp });

        // 2. Crear una RESPUESTA (answer)
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // 3. Enviar nuestra RESPUESTA al servidor
        socket.emit('answer-from-browser', {
            callId: currentCallId,
            sdp: pc.localDescription.sdp
        });

    } catch (err) {
        console.error('Error al aceptar la llamada:', err);
        resetUI();
    }
}

// --- FUNCIONES DE UTILIDAD ---
function startTimer() {
    let seconds = 0;
    timerInterval = setInterval(() => {
        seconds++;
        const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
        const secs = String(seconds % 60).padStart(2, '0');
        timerEl.textContent = `${mins}:${secs}`;
    }, 1000);
}

function resetUI() {
    incomingCallEl.classList.add('hidden');
    activeCallEl.classList.add('hidden');
    statusEl.textContent = 'Conectado. Esperando llamadas...';

    if (pc) {
        pc.close();
        pc = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (timerInterval) {
        clearInterval(timerInterval);
        timerEl.textContent = '00:00';
    }
    remoteAudio.srcObject = null;
    currentCallId = null;
    serverOfferSdp = null;
}