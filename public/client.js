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
    console.log('Accepting call...');
    incomingCallEl.classList.add('hidden');

    try {
        // 1. Pedir permiso para el micrófono
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        statusEl.textContent = 'Microphone access granted. Connecting...';

        // 2. Crear PeerConnection
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        // 3. Añadir el stream local (micrófono) al PeerConnection
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        // 4. Manejar el stream remoto (audio de WhatsApp)
        pc.ontrack = (event) => {
            console.log('Remote track received');
            remoteAudio.srcObject = event.streams[0];
        };

        // 5. Enviar candidatos ICE al servidor
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('browser-candidate', event.candidate);
            }
        };

        // 6. Crear la oferta SDP y enviarla al servidor
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('browser-offer', offer);
        console.log('Browser SDP offer sent');

    } catch (err) {
        console.error('Error accepting call:', err);
        statusEl.textContent = 'Error: Could not start call.';
        resetUI();
    }
}

// --- Recibir la respuesta del servidor ---
socket.on('browser-answer', async (sdp) => {
    console.log('Received SDP answer from server');
    try {
        await pc.setRemoteDescription({ type: 'answer', sdp });
        console.log('Remote description (answer) set.');
    } catch (err) {
        console.error('Error setting remote description:', err);
    }
});

// Recibir candidatos ICE del servidor
socket.on('browser-candidate', async (candidate) => {
    try {
        await pc.addIceCandidate(candidate);
    } catch (err) {
        console.error('Error adding ICE candidate:', err);
    }
});

// --- Manejo del estado de la llamada ---
socket.on('start-browser-timer', () => {
    statusEl.textContent = 'Call in progress.';
    activeCallEl.classList.remove('hidden');
    startTimer();
});

socket.on('call-ended', () => {
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