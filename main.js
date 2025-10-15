require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const http = require("http");
const socketIO = require("socket.io");
const {
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    MediaStream,
} = require("wrtc");

// --- 1. CONFIGURACIÓN Y CONSTANTES ---

// Cargar variables de entorno
const {
    PHONE_NUMBER_ID,
    ACCESS_TOKEN,
    VERIFY_TOKEN, // Token para la verificación del webhook
    TURN_USERNAME,  // Usuario para el servidor TURN
    TURN_CREDENTIAL // Contraseña para el servidor TURN
} = process.env;

// Configuración de servidores ICE (STUN y TURN) para mayor fiabilidad
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    {
        urls: "turn:global.relay.metered.ca:80",
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL,
    },
    {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL,
    },
];

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/calls`;
const AUTH_HEADER = `Bearer ${ACCESS_TOKEN}`;

// --- 2. INICIALIZACIÓN DEL SERVIDOR ---
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- 3. GESTIÓN DE SESIONES DE LLAMADA (ARQUITECTURA ESCALABLE) ---

// Usamos un Map para almacenar el estado de cada llamada activa por su callId.
// Esto reemplaza las variables globales y permite múltiples llamadas simultáneas.
const activeCallSessions = new Map();

/**
 * Cierra las conexiones WebRTC y elimina la sesión del mapa para liberar recursos.
 * @param {string} callId - El ID de la llamada a limpiar.
 */
function cleanupCallSession(callId) {
    const session = activeCallSessions.get(callId);
    if (!session) return;

    console.log(`Limpiando sesión para la llamada: ${callId}`);
    session.browserPc?.close();
    session.whatsappPc?.close();
    activeCallSessions.delete(callId);
}

// --- 4. MANEJADORES DE WEBHOOK DE META ---

/**
 * Maneja la verificación del webhook (petición GET de Meta).
 */
app.get("/call-events", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("WEBHOOK_VERIFIED");
        res.status(200).send(challenge);
    } else {
        console.error("Fallo en la verificación del Webhook.");
        res.sendStatus(403);
    }
});

/**
 * Maneja los eventos de llamada entrantes (petición POST de Meta).
 */
app.post("/call-events", async (req, res) => {
    try {
        console.log(req.body)
        const call = req.body?.entry?.[0]?.changes?.[0]?.value?.calls?.[0];
        if (!call || !call.id || !call.event) {
            return res.sendStatus(200); // Evento no válido o no es de llamada
        }

        const callId = call.id;

        if (call.event === "connect") {
            console.log(`Llamada entrante recibida. ID: ${callId}`);
            const contact = req.body.entry[0].changes[0].value.contacts[0];
            
            // Crear una nueva sesión para esta llamada
            const newSession = {
                whatsappOfferSdp: call.session.sdp,
                callerName: contact.profile.name || "Desconocido",
                callerNumber: contact.wa_id || "Desconocido",
                browserSocket: null,
                browserOfferSdp: null,
                browserPc: null,
                whatsappPc: null,
            };
            activeCallSessions.set(callId, newSession);

            // Notificar a todos los clientes web conectados sobre la nueva llamada
            io.emit("call-is-coming", {
                callId,
                callerName: newSession.callerName,
                callerNumber: newSession.callerNumber,
            });

        } else if (call.event === "terminate") {
            console.log(`Llamada terminada por WhatsApp. ID: ${callId}`);
            const session = activeCallSessions.get(callId);
            if (session?.browserSocket) {
                session.browserSocket.emit("call-ended", { callId });
            }
            cleanupCallSession(callId);
        }
        res.sendStatus(200);
    } catch (err) {
        console.error("Error procesando el webhook /call-events:", err);
        res.sendStatus(500);
    }
});

// --- 5. LÓGICA DE SOCKET.IO CON EL CLIENTE WEB ---

io.on("connection", (socket) => {
    console.log(`Cliente web conectado: ${socket.id}`);

    socket.on("browser-offer", async ({ callId, sdp }) => {
        console.log(`Oferta SDP recibida del navegador para la llamada: ${callId}`);
        const session = activeCallSessions.get(callId);
        if (!session) {
            return console.error(`No se encontró una sesión activa para la llamada: ${callId}`);
        }
        session.browserSocket = socket;
        session.browserOfferSdp = sdp;
        await initiateWebRTCBridge(callId);
    });

    socket.on("browser-candidate", async ({ callId, candidate }) => {
        const session = activeCallSessions.get(callId);
        if (session?.browserPc) {
            try {
                await session.browserPc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error("Fallo al añadir candidato ICE del navegador:", err);
            }
        }
    });

    socket.on("reject-call", async (callId) => {
        await answerCallToWhatsApp(callId, null, "reject");
        cleanupCallSession(callId);
    });

    socket.on("terminate-call", async (callId) => {
        await answerCallToWhatsApp(callId, null, "terminate");
        cleanupCallSession(callId);
    });
});

// --- 6. LÓGICA DEL PUENTE WEBRTC ---

async function initiateWebRTCBridge(callId) {
    const session = activeCallSessions.get(callId);
    if (!session || !session.whatsappOfferSdp || !session.browserOfferSdp) {
        return console.error("Faltan datos de sesión para iniciar el puente WebRTC.");
    }

    try {
        // --- Conexión con el Navegador ---
        session.browserPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const browserStream = new MediaStream();
        session.browserPc.ontrack = (event) => {
            console.log(`Track de audio recibido del navegador para ${callId}`);
            event.streams[0].getTracks().forEach((track) => browserStream.addTrack(track));
        };
        session.browserPc.onicecandidate = (event) => {
            if (event.candidate) {
                session.browserSocket.emit("browser-candidate", { callId, candidate: event.candidate });
            }
        };
        await session.browserPc.setRemoteDescription({ type: "offer", sdp: session.browserOfferSdp });

        // --- Conexión con WhatsApp ---
        session.whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const whatsappStream = new MediaStream();
        session.whatsappPc.ontrack = (event) => {
            console.log(`Track de audio recibido de WhatsApp para ${callId}`);
            event.streams[0].getTracks().forEach((track) => whatsappStream.addTrack(track));
        };
        await session.whatsappPc.setRemoteDescription({ type: "offer", sdp: session.whatsappOfferSdp });

        // --- Cruzar los streams de audio ---
        browserStream.getAudioTracks().forEach((track) => session.whatsappPc.addTrack(track, browserStream));
        whatsappStream.getAudioTracks().forEach((track) => session.browserPc.addTrack(track, whatsappStream));

        // --- Crear y enviar respuestas SDP ---
        const browserAnswer = await session.browserPc.createAnswer();
        await session.browserPc.setLocalDescription(browserAnswer);
        session.browserSocket.emit("browser-answer", { callId, sdp: browserAnswer.sdp });

        const waAnswer = await session.whatsappPc.createAnswer();
        await session.whatsappPc.setLocalDescription(waAnswer);
        
        // --- Aceptar la llamada en la API de Meta ---
        const preAcceptSuccess = await answerCallToWhatsApp(callId, waAnswer.sdp, "pre_accept");
        if (preAcceptSuccess) {
            setTimeout(async () => {
                const acceptSuccess = await answerCallToWhatsApp(callId, waAnswer.sdp, "accept");
                if (acceptSuccess) {
                    session.browserSocket.emit("start-browser-timer", { callId });
                }
            }, 1000);
        } else {
            console.error("Fallo en el pre-accept. Abortando la aceptación de la llamada.");
            cleanupCallSession(callId);
        }
    } catch (err) {
        console.error(`Error al iniciar el puente WebRTC para ${callId}:`, err);
        cleanupCallSession(callId);
    }
}

// --- 7. FUNCIONES AUXILIARES DE API ---

async function answerCallToWhatsApp(callId, sdp, action) {
    const body = { messaging_product: "whatsapp", call_id: callId, action };
    if (sdp) {
        body.session = { sdp_type: "answer", sdp };
    }
    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
        });
        const success = response.data?.success === true;
        console.log(`Acción '${action}' para ${callId} enviada. Éxito: ${success}`);
        return success;
    } catch (error) {
        console.error(`Fallo al enviar acción '${action}' a WhatsApp para ${callId}:`, error.response?.data || error.message);
        return false;
    }
}

// --- 8. INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});