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
} = require("wrtc");

// --- 1. CONFIGURACIÓN Y CONSTANTES ---
const {
    PHONE_NUMBER_ID, ACCESS_TOKEN, VERIFY_TOKEN,
    TURN_USERNAME, TURN_CREDENTIAL
} = process.env;

const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:global.relay.metered.ca:80", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
];

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/calls`;
const AUTH_HEADER = `Bearer ${ACCESS_TOKEN}`;

// --- 2. INICIALIZACIÓN DEL SERVIDOR ---
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- 3. GESTIÓN DE SESIONES ---
const activeCallSessions = new Map();

function cleanupCallSession(callId) {
    const session = activeCallSessions.get(callId);
    if (!session) return;
    console.log(`Limpiando sesión para la llamada: ${callId}`);
    session.browserPc?.close();
    session.whatsappPc?.close();
    activeCallSessions.delete(callId);
}

// --- 4. WEBHOOKS DE META ---
app.get("/call-events", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("WEBHOOK_VERIFIED");
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ====================================================================
// === CAMBIO DE ARQUITECTURA: LÓGICA DEL WEBHOOK POST MODIFICADA ===
// ====================================================================
app.post("/call-events", async (req, res) => {
    try {
        const call = req.body?.entry?.[0]?.changes?.[0]?.value?.calls?.[0];
        if (!call || !call.id) return res.sendStatus(200);

        const callId = call.id;
        const event = call.event;

        if (event === "connect") {
            console.log(`Llamada entrante recibida. ID: ${callId}. Iniciando negociación...`);
            
            // 1. Crear la PeerConnection de WhatsApp INMEDIATAMENTE
            const whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            
            const session = {
                whatsappPc,
                browserPc: null,
                browserSocket: null,
                callerName: req.body.entry[0].changes[0].value.contacts[0]?.profile?.name || "Desconocido",
            };
            activeCallSessions.set(callId, session);

            // 2. Configurar el track de WhatsApp
            whatsappPc.ontrack = (event) => {
                console.log(`Track de audio recibido de WhatsApp para ${callId}`);
                if (session.browserPc) {
                    console.log("Reenviando track de WhatsApp al navegador.");
                    session.browserPc.addTrack(event.track, event.streams[0]);
                }
            };

            // 3. Establecer la oferta de WhatsApp y crear una respuesta
            await whatsappPc.setRemoteDescription({ type: "offer", sdp: call.session.sdp });
            const answerForWhatsapp = await whatsappPc.createAnswer();
            await whatsappPc.setLocalDescription(answerForWhatsapp);

            // 4. Enviar la descripción local del servidor (que es una respuesta para WA)
            // como una OFERTA para el navegador.
            console.log(`Enviando oferta al frontend para la llamada ${callId}`);
            io.emit("offer-from-server", {
                callId,
                callerName: session.callerName,
                sdp: whatsappPc.localDescription.sdp,
            });

        } else if (event === "terminate") {
            console.log(`Llamada terminada por WhatsApp. ID: ${callId}`);
            const session = activeCallSessions.get(callId);
            if (session?.browserSocket) {
                session.browserSocket.emit("call-terminated", { callId });
            }
            cleanupCallSession(callId);
        }
        res.sendStatus(200);
    } catch (err) {
        console.error("Error procesando el webhook /call-events:", err);
        res.sendStatus(500);
    }
});

// ====================================================================
// === CAMBIO DE ARQUITECTURA: LÓGICA DE SOCKET.IO MODIFICADA ===
// ====================================================================
io.on("connection", (socket) => {
    console.log(`Cliente web conectado: ${socket.id}`);

    // El navegador envía su RESPUESTA a la oferta del servidor
    socket.on("answer-from-browser", async ({ callId, sdp }) => {
        console.log(`Respuesta SDP recibida del navegador para la llamada: ${callId}`);
        const session = activeCallSessions.get(callId);
        if (!session) {
            return console.error(`No se encontró sesión para la llamada: ${callId}`);
        }
        session.browserSocket = socket;

        try {
            // 1. Crear la PeerConnection del navegador
            const browserPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            session.browserPc = browserPc;

            // 2. Configurar el track del navegador
            browserPc.ontrack = (event) => {
                console.log(`Track de audio recibido del navegador para ${callId}`);
                if (session.whatsappPc) {
                    console.log("Reenviando track del navegador a WhatsApp.");
                    session.whatsappPc.addTrack(event.track, event.streams[0]);
                }
            };

            // 3. Establecer las descripciones SDP
            // La oferta que usó el navegador es la descripción local de whatsappPc
            await browserPc.setRemoteDescription(session.whatsappPc.localDescription);
            // La respuesta del navegador es su propia descripción local
            await browserPc.setLocalDescription({ type: "answer", sdp });

            // 4. ¡AHORA SÍ! Enviar pre-accept y accept a Meta
            console.log(`Puente WebRTC establecido. Enviando pre-accept a Meta para ${callId}`);
            const preAcceptSuccess = await answerCallToWhatsApp(callId, session.whatsappPc.localDescription.sdp, "pre_accept");
            if (preAcceptSuccess) {
                setTimeout(async () => {
                    await answerCallToWhatsApp(callId, session.whatsappPc.localDescription.sdp, "accept");
                    socket.emit("call-active", { callId });
                }, 1000);
            } else {
                console.error("Fallo en el pre-accept. Limpiando llamada.");
                cleanupCallSession(callId);
            }
        } catch (err) {
            console.error(`Error al procesar la respuesta del navegador para ${callId}:`, err);
            cleanupCallSession(callId);
        }
    });

    socket.on("hangup-from-browser", async (callId) => {
        console.log(`Navegador colgó la llamada: ${callId}`);
        await answerCallToWhatsApp(callId, null, "terminate");
        cleanupCallSession(callId);
    });
});

// --- FUNCIONES AUXILIARES ---
async function answerCallToWhatsApp(callId, sdp, action) {
    const body = { messaging_product: "whatsapp", call_id: callId, action };
    if (sdp) {
        body.session = { sdp_type: "answer", sdp };
    }
    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
        });
        console.log(`Acción '${action}' para ${callId} enviada. Éxito: ${response.data.success}`);
        return response.data.success;
    } catch (error) {
        console.error(`Fallo al enviar acción '${action}' a WhatsApp para ${callId}:`, error.response?.data || error.message);
        return false;
    }
}

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});