const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const salas = {};

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

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
            sala.historias = sala.jugadores.map((_, index) => ({ id: index, segmentos: [] }));
            empezarRonda(salaId);
        }
    });

    socket.on('enviar_segmento', (datos) => {
        procesarEnvio(socket.id, datos);
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

function empezarRonda(salaId) {
    const sala = salas[salaId];
    sala.jugadores.forEach(j => j.listo = false);
    enviarInfoTurno(salaId);
    let tiempo = sala.ajustes.tiempo;
    io.to(salaId).emit('timer_update', tiempo);
    if (sala.timer) clearInterval(sala.timer);
    sala.timer = setInterval(() => {
        tiempo--;
        io.to(salaId).emit('timer_update', tiempo);
        if (tiempo <= 0) {
            clearInterval(sala.timer);
            io.to(salaId).emit('tiempo_agotado');
        }
    }, 1000);
}

function procesarEnvio(socketId, datos) {
    const { salaId, texto, personajes } = datos;
    const sala = salas[salaId];
    if (!sala) return;
    const idxJ = sala.jugadores.findIndex(j => j.id === socketId);
    if (idxJ === -1 || sala.jugadores[idxJ].listo) return;
    const idxH = (idxJ + sala.rondaActual) % sala.jugadores.length;
    sala.historias[idxH].segmentos.push({
        autor: sala.jugadores[idxJ].nombre,
        texto: texto || "(Este payo se ha quedado en blanco...)",
        personajes: personajes || "Ninguno"
    });
    sala.jugadores[idxJ].listo = true;
    if (sala.jugadores.every(j => j.listo)) {
        clearInterval(sala.timer);
        sala.rondaActual++;
        if (sala.rondaActual < sala.jugadores.length) empezarRonda(salaId);
        else io.to(salaId).emit('mostrar_resultados');
    }
}

function enviarInfoTurno(salaId) {
    const sala = salas[salaId];
    const limite = sala.ajustes.caracteres;
    sala.jugadores.forEach((jugador, i) => {
        const idxH = (i + sala.rondaActual) % sala.jugadores.length;
        const historia = sala.historias[idxH];
        const ultimo = historia.segmentos.length > 0 ? historia.segmentos[historia.segmentos.length - 1] : null;
        let pista = "¡Que comience la leyenda!";
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
    io.to(salaId).emit('actualizar_presentacion', {
        titulo: `Leyenda ${sala.indiceHistoriaP + 1} de ${sala.historias.length}`,
        segmentos: segmentos,
        esUltimo: (sala.indiceHistoriaP === sala.historias.length - 1 && sala.indiceSegmentoP === historia.segmentos.length - 1)
    });
}

// Configuración para el despliegue en internet
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 Payo's Legend corriendo en el puerto ${PORT}`));