const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const salas = {};

// Servir archivos estáticos (imprescindible para los .mp3 y el CSS)
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- PORTERÍA Y COMUNICACIÓN (Eventos de Socket) ---
io.on('connection', (socket) => {

    socket.on('unirse_sala', (datos) => {
        const { salaId, nombre } = datos;
        if (!salas[salaId]) {
            salas[salaId] = {
                id: salaId,
                estado: 'LOBBY',
                jugadores: [],
                historias: [],
                rondaActual: 0,
                timer: null,
                liderId: socket.id,
                ajustes: { tiempo: 90, caracteres: 100 },
                indiceHistoriaP: 0,
                indiceSegmentoP: 0
            };
        }
        salas[salaId].jugadores.push({ id: socket.id, nombre, listo: false });
        socket.join(salaId);
        io.to(salaId).emit('actualizar_lista', salas[salaId].jugadores);
        socket.emit('es_lider', socket.id === salas[salaId].liderId);
    });

    socket.on('actualizar_ajustes', (datos) => {
        const { salaId, tiempo, caracteres } = datos;
        const sala = salas[salaId];
        if (sala && socket.id === sala.liderId) {
            sala.ajustes.tiempo = parseInt(tiempo);
            sala.ajustes.caracteres = parseInt(caracteres);
        }
    });

    socket.on('iniciar_juego', (salaId) => {
        const sala = salas[salaId];
        if (sala && sala.jugadores.length >= 2) {
            sala.estado = 'JUGANDO';
            sala.rondaActual = 0;
            // Creamos los folios en blanco
            sala.historias = sala.jugadores.map((_, index) => ({ id: index, segmentos: [] }));
            empezarRonda(salaId);
        }
    });

    // Evento crucial: El envío real de texto que pide el servidor al final
    socket.on('enviar_segmento_final', (datos) => {
        procesarEnvio(socket.id, datos);
    });

    socket.on('jugador_listo', (salaId) => {
        const sala = salas[salaId];
        if (!sala) return;
        const jugador = sala.jugadores.find(j => j.id === socket.id);
        if (jugador) {
            jugador.listo = true;
            // Si todos pulsan el botón, pitamos el final antes de tiempo
            if (sala.jugadores.every(j => j.listo)) {
                finalizarRonda(salaId);
            }
        }
    });

    socket.on('empezar_presentacion', (salaId) => {
        const sala = salas[salaId];
        if (sala && socket.id === sala.liderId) {
            sala.indiceHistoriaP = 0;
            sala.indiceSegmentoP = 0;
            enviarEstadoPresentacion(salaId);
        }
    });

    socket.on('siguiente_paso', (salaId) => {
        const sala = salas[salaId];
        if (sala && socket.id === sala.liderId) {
            const historiaActual = sala.historias[sala.indiceHistoriaP];
            if (sala.indiceSegmentoP < historiaActual.segmentos.length - 1) {
                sala.indiceSegmentoP++;
            } else if (sala.indiceHistoriaP < sala.historias.length - 1) {
                sala.indiceHistoriaP++;
                sala.indiceSegmentoP = 0;
            } else {
                return io.to(salaId).emit('fin_presentacion');
            }
            enviarEstadoPresentacion(salaId);
        }
    });

    socket.on('reiniciar_juego', (salaId) => {
        const sala = salas[salaId];
        if (sala) {
            sala.estado = 'LOBBY';
            sala.rondaActual = 0;
            sala.historias = [];
            sala.indiceHistoriaP = 0;
            sala.indiceSegmentoP = 0;
            sala.jugadores.forEach(j => j.listo = false);
            if (sala.timer) clearInterval(sala.timer);
            io.to(salaId).emit('vuelta_a_lobby');
        }
    });

    socket.on('disconnect', () => {
        for (const salaId in salas) {
            const sala = salas[salaId];
            const idx = sala.jugadores.findIndex(j => j.id === socket.id);
            if (idx !== -1) {
                sala.jugadores.splice(idx, 1);
                if (socket.id === sala.liderId && sala.jugadores.length > 0) {
                    sala.liderId = sala.jugadores[0].id;
                    io.to(sala.liderId).emit('es_lider', true);
                }
                io.to(salaId).emit('actualizar_lista', sala.jugadores);
            }
        }
    });
});

// --- LÓGICA GLOBAL (Fuera del bloque io.on para que funcione el timer) ---

function finalizarRonda(salaId) {
    const sala = salas[salaId];
    if (!sala) return;
    if (sala.timer) clearInterval(sala.timer);

    // 1. Grito de guerra: Pedimos los textos a los navegadores
    io.to(salaId).emit('peticion_final');

    // 2. Margen de seguridad de 1.5s para recibir los textos antes de rotar papeles
    setTimeout(() => {
        sala.rondaActual++;
        if (sala.rondaActual < sala.jugadores.length) {
            empezarRonda(salaId);
        } else {
            io.to(salaId).emit('mostrar_resultados');
        }
    }, 1500);
}

function empezarRonda(salaId) {
    const sala = salas[salaId];
    sala.jugadores.forEach(j => j.listo = false);

    enviarInfoTurno(salaId);

    const esPrimeraRonda = sala.rondaActual === 0;
    const tiempoEspera = esPrimeraRonda ? 3000 : 5000;

    io.to(salaId).emit('interludio_inicio', {
        segundos: tiempoEspera / 1000,
        esPrimera: esPrimeraRonda
    });

    if (sala.timer) clearInterval(sala.timer);

    setTimeout(() => {
        let tiempo = sala.ajustes.tiempo;
        io.to(salaId).emit('empezar_a_escribir');
        io.to(salaId).emit('timer_update', tiempo);

        sala.timer = setInterval(() => {
            tiempo--;
            io.to(salaId).emit('timer_update', tiempo);

            if (tiempo <= 0) {
                finalizarRonda(salaId); // ¡Ahora el silbato sí suena!
            }
        }, 1000);
    }, tiempoEspera);
}

function procesarEnvio(socketId, datos) {
    const { salaId, texto, personajes } = datos;
    const sala = salas[salaId];
    if (!sala) return;
    const idxJ = sala.jugadores.findIndex(j => j.id === socketId);
    if (idxJ === -1) return;

    const idxH = (idxJ + sala.rondaActual) % sala.jugadores.length;

    // Sobrescritura de seguridad por si llegaran paquetes duplicados
    const historia = sala.historias[idxH];
    if (historia.segmentos.length > sala.rondaActual) {
        historia.segmentos.pop();
    }

    historia.segmentos.push({
        autor: sala.jugadores[idxJ].nombre,
        texto: texto || "(Este payo se quedó mudo...)",
        personajes: personajes || "Ninguno"
    });

    sala.jugadores[idxJ].listo = true;
}

function enviarInfoTurno(salaId) {
    const sala = salas[salaId];
    const limite = sala.ajustes.caracteres;
    sala.jugadores.forEach((jugador, i) => {
        const idxH = (i + sala.rondaActual) % sala.jugadores.length;
        const historia = sala.historias[idxH];
        const ultimo = historia.segmentos.length > 0 ? historia.segmentos[historia.segmentos.length - 1] : null;
        let pista = "¡Forja la leyenda!";
        if (ultimo) {
            pista = ultimo.texto.length > limite ? "..." + ultimo.texto.slice(-limite) : ultimo.texto;
        }
        io.to(jugador.id).emit('nuevo_turno', {
            textoAnterior: pista,
            personajesAnteriores: ultimo ? ultimo.personajes : "Ninguno",
            ronda: sala.rondaActual + 1
        });
    });
}

function enviarEstadoPresentacion(salaId) {
    const sala = salas[salaId];
    const historia = sala.historias[sala.indiceHistoriaP];
    const segmentos = historia.segmentos.slice(0, sala.indiceSegmentoP + 1);

    let tipoSiguiente = "CAPITULO";
    if (sala.indiceSegmentoP === historia.segmentos.length - 1) {
        tipoSiguiente = (sala.indiceHistoriaP < sala.historias.length - 1) ? "HISTORIA" : "FINAL";
    }

    io.to(salaId).emit('actualizar_presentacion', {
        titulo: `Crónica ${sala.indiceHistoriaP + 1} de ${sala.historias.length}`,
        segmentos: segmentos,
        tipoSiguiente: tipoSiguiente,
        esUltimo: (tipoSiguiente === "FINAL")
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 Payo's Legend encendido en puerto ${PORT}, Guille!`));