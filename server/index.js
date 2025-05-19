// server/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const dbPool = require('./config/db');
const config = require('./config/config.json');
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: config.server.corsOrigin, methods: ['GET', 'POST'] },
});

// статические и обычные маршруты
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));
app.get('/', (req, res) =>
    res.sendFile(path.join(__dirname, '../client/pages/registration.html'))
);
app.get('/lobby.html', (req, res) =>
    res.sendFile(path.join(__dirname, '../client/pages/lobby.html'))
);
app.use('/auth', authRoutes);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// мапы для быстрого поиска по нику и по userId
const socketsByNickname = new Map(); // nickname -> socket.id
const socketsByUserId = new Map(); // userId   -> socket.id

io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
        const payload = jwt.verify(token, config.server.jwtSecret);
        // Предварительно подгружаем avatar_url
        const [[{ avatar_url }]] = await dbPool.query(
            'SELECT avatar_url FROM users WHERE user_id = ?',
            [payload.userId]
        );
        socket.user = {
            userId: payload.userId,
            nickname: payload.nickname,
            avatar_url,
        };
        next();
    } catch (err) {
        next(new Error('Unauthorized'));
    }
});

// обрабатываем подключения
io.on('connection', (socket) => {
    const { userId, nickname } = socket.user;
    const key = nickname.toLowerCase();
    socketsByNickname.set(key, socket.id);
    // 👉 Сохраним и по userId
    socketsByUserId.set(userId, socket.id);

    // изменение аватара (оставим как есть)
    socket.on('change_avatar', async ({ avatar_url }) => {
        try {
            await dbPool.query(
                'UPDATE users SET avatar_url = ? WHERE user_id = ?',
                [avatar_url, userId]
            );
            socket.emit('avatar_updated', { avatar_url });
        } catch (err) {
            console.error('Error when changing avatar:', err);
            socket.emit('avatar_update_error', {
                error: 'Failed to update avatar',
            });
        }
    });

    // Приглашение
    socket.on('invite', ({ targetNickname }) => {
        const tkey = targetNickname.trim().toLowerCase();
        const targetSocketId = socketsByNickname.get(tkey);
        console.log(
            `Invite attempt: ${nickname} → ${targetNickname} (key="${tkey}") → targetSocketId=${targetSocketId}`
        );

        if (!targetSocketId) {
            socket.emit('invite_error', 'User not online');
            return;
        }
        io.to(targetSocketId).emit('invite_received', {
            fromUserId: userId,
            fromNickname: nickname,
            fromAvatar: socket.user.avatar_url,
        });
    });

    // Ответ на приглашение
    socket.on('invite_response', ({ fromUserId, accept }) => {
        const inviterSocketId = socketsByUserId.get(fromUserId);
        console.log(
            `Invite response from ${nickname} to userId=${fromUserId}: accept=${accept}`
        );
        if (!inviterSocketId) return;
        io.to(inviterSocketId).emit('invite_response', {
            fromUserId: socket.user.userId,
            fromNickname: nickname,
            fromAvatar: socket.user.avatar_url,
            accept,
        });
        if (accept) {
            const room = `battle_${fromUserId}_${socket.user.userId}`;
            socket.join(room);
            io.sockets.sockets.get(inviterSocketId).join(room);
            io.to(room).emit('start_draft', { sessionId: room });
        }
    });
    // Выход из комнаты по имени sessionId
    socket.on('leave_room', ({ sessionId }) => {
        // выходим из комнаты
        socket.leave(sessionId);
        // говорим остальным в комнате, что мы вышли
        socket
            .to(sessionId)
            .emit('opponent_left', { userId: socket.user.userId });
    });
    // Клиент хочет присоединиться к уже созданной комнате (после перезагрузки)
    socket.on('join_room', ({ sessionId }) => {
        socket.join(sessionId);
        console.log(`→ ${socket.user.nickname} re-joined room ${sessionId}`);
    });

    socket.on('disconnect', () => {
        socketsByNickname.delete(key);
        console.log(`← ${nickname} disconnected`);
    });
});

// стартуем
const PORT = process.env.PORT || config.server.port;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
