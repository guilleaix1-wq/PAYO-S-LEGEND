const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const salas = {};

// Servir archivos estáticos (importante para los .mp3)
app.use(express.static(__dirname));

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

function empezarRonda(salaId) {
    const sala = salas[salaId];
    // Ponemos a todo el mundo en "no listo" para que tengan que enviar
    sala.jugadores.forEach(j => j.listo = false);
    
    // Enviamos la pista (en la ronda 1 será "Forja la leyenda")
    enviarInfoTurno(salaId);
    
    // Lógica de tiempos: Ronda 1 (rondaActual es 0 todavía) vs resto
    const esPrimeraRonda = sala.rondaActual === 0;
    const tiempoEspera = esPrimeraRonda ? 3000 : 5000; 

    // Avisamos al cliente para que bloquee y ponga el texto de "Prepárate" o "Lee"
    io.to(salaId).emit('interludio_inicio', {
        segundos: tiempoEspera / 1000,
        esPrimera: esPrimeraRonda
    });

    // Cancelamos cualquier timer anterior por si acaso
    if (sala.timer) clearInterval(sala.timer);

    // Esperamos el tiempo de interludio antes de dejarles escribir
    setTimeout(() => {
        let tiempo = sala.ajustes.tiempo;
        
        // El megáfono: ¡A escribir!
        io.to(salaId).emit('empezar_a_escribir');
        io.to(salaId).emit('timer_update', tiempo);

        sala.timer = setInterval(() => {
            tiempo--;
            io.to(salaId).emit('timer_update', tiempo);

            if (tiempo <= 0) {
                clearInterval(sala.timer);
                
                // Si el tiempo llega a 0, forzamos el envío de los que no han dado al botón
                sala.jugadores.forEach(jugador => {
                    if (!jugador.listo) {
                        procesarEnvio(jugador.id, { 
                            salaId: salaId, 
                            texto: "(Se quedó en blanco...)", 
                            personajes: "Ninguno" 
                        });
                    }
                });
            }
        }, 1000);
    }, tiempoEspera);
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
        texto: texto || "(Un payo se quedó mudo...)",
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
    io.to(salaId).emit('actualizar_presentacion', {
        titulo: `Crónica ${sala.indiceHistoriaP + 1} de ${sala.historias.length}`,
        segmentos: segmentos,
        esUltimo: (sala.indiceHistoriaP === sala.historias.length - 1 && sala.indiceSegmentoP === historia.segmentos.length - 1)
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 Payo's Legend en puerto ${PORT}`));