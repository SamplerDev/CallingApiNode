const socket = io();
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
let timerInterval;

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// --- Conexión con el Servidor ---
socket.on('connect', () => {
    statusEl.textContent = 'Connected. Waiting for calls...';
    console.log('Connected to server with ID:', socket.id);
});

// --- Lógica de Llamada Entrante ---
socket.on('call-is-coming', async ({ callId, callerName, callerNumber }) => {
    statusEl.textContent = 'Incoming call!';
    currentCallId = callId;
    callerNameEl.textContent = callerName;
    callerNumberEl.textContent = callerNumber;
    incomingCallEl.classList.remove('hidden');
});

acceptBtn.addEventListener('click', acceptCall);
rejectBtn.addEventListener('click', () => {
    socket.emit('reject-call', currentCallId);
    resetUI();
});
terminateBtn.addEventListener('click', () => {
    socket.emit('terminate-call', currentCallId);
    resetUI();
});

async function acceptCall() {
    console.log('Accepting call...', currentCallId);
    incomingCallEl.classList.add('hidden');

    try {
        // ... (código existente para getUserMedia y crear PeerConnection) ...
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        
        pc.ontrack = (event) => {
            remoteAudio.srcObject = event.streams[0];
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // MODIFICACIÓN: Enviar el callId junto con el candidato
                socket.emit('browser-candidate', { callId: currentCallId, candidate: event.candidate });
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // MODIFICACIÓN CLAVE: Enviar el callId junto con la oferta SDP
        socket.emit('browser-offer', { callId: currentCallId, sdp: offer.sdp });
        console.log('Browser SDP offer sent for call:', currentCallId);

    } catch (err) {
        console.error('Error accepting call:', err);
        resetUI();
    }
}

// MODIFICACIÓN: Actualizar los manejadores de eventos para usar el callId
socket.on('browser-answer', async ({ callId, sdp }) => {
    if (callId !== currentCallId) return; // Ignorar si no es para la llamada actual
    console.log('Received SDP answer from server');
    await pc.setRemoteDescription({ type: 'answer', sdp });
});

socket.on('browser-candidate', async ({ callId, candidate }) => {
    if (callId !== currentCallId) return;
    await pc.addIceCandidate(candidate);
});

socket.on('start-browser-timer', ({ callId }) => {
    if (callId !== currentCallId) return;
    statusEl.textContent = 'Call in progress.';
    activeCallEl.classList.remove('hidden');
    startTimer();
});

socket.on('call-ended', ({ callId }) => {
    if (callId !== currentCallId) return;
    statusEl.textContent = 'Call ended.';
    resetUI();
});


// --- Funciones de Utilidad ---
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
    statusEl.textContent = 'Waiting for calls...';

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
}