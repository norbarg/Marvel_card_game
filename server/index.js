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
const readyMap = new Map(); // sessionId -> Set<userId>
const sessionPlayers = new Map(); // sessionId → [player1_id, player2_id]
const sessionDraftData = new Map(); //  sessionId → { cardPool, firstPlayerId }

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
            // Обновляем на лету в памяти:
            socket.user.avatar_url = avatar_url;

            // Подтверждаем клиенту
            socket.emit('avatar_updated', { avatar_url });
        } catch (err) {
            console.error('Error when changing avatar:', err);
            socket.emit('avatar_update_error', {
                error: 'Failed to update avatar',
            });
        }
    });

    // Приглашение
    socket.on('invite', async ({ targetNickname }) => {
        const tkey = targetNickname.trim().toLowerCase();
        const targetSocketId = socketsByNickname.get(tkey);
        console.log(
            `Invite attempt: ${nickname} → ${targetNickname} (key="${tkey}") → targetSocketId=${targetSocketId}`
        );

        if (!targetSocketId) {
            socket.emit('invite_error', 'User not online');
            return;
        }
        // подгружаем актуальный аватар текущего юзера
        const [[{ avatar_url }]] = await dbPool.query(
            'SELECT avatar_url FROM users WHERE user_id = ?',
            [socket.user.userId]
        );
        io.to(targetSocketId).emit('invite_received', {
            fromUserId: userId,
            fromNickname: nickname,
            fromAvatar: avatar_url,
        });
    });

    socket.on('invite_response', async ({ fromUserId, accept }) => {
        const inviterSocketId = socketsByUserId.get(fromUserId);
        if (!inviterSocketId) return;

        // Сообщаем вызывающему пользователю об ответе
        io.to(inviterSocketId).emit('invite_response', {
            fromUserId: socket.user.userId,
            fromNickname: socket.user.nickname,
            fromAvatar: socket.user.avatar_url,
            accept,
        });

        if (!accept) return;

        // 1) Создаём новую запись в sessions и получаем её числовой ID
        const [res] = await dbPool.query(
            'INSERT INTO sessions (player1_id, player2_id, status) VALUES (?, ?, ?)',
            [fromUserId, socket.user.userId, 'lobby']
        );
        const dbSessionId = res.insertId.toString();

        // 2) Подписываем обоих в комнату с именем = этот ID
        const room = dbSessionId.toString();
        sessionPlayers.set(room, [fromUserId, socket.user.userId]);

        socket.join(room);
        io.sockets.sockets.get(inviterSocketId).join(room);
        io.to(room).emit('session_joined', { sessionId: room });
    });

    // когда игрок нажал READY
    socket.on('player_ready', async ({ sessionId }) => {
        if (!readyMap.has(sessionId)) {
            readyMap.set(sessionId, new Set());
        }
        const set = readyMap.get(sessionId);
        set.add(userId);

        if (set.size === 2) {
            // 1) обновляем статус
            await dbPool.query(
                'UPDATE sessions SET status = ? WHERE session_id = ?',
                ['draft', sessionId]
            );

            // 2) тащим 30 карточек
            const [cards] = await dbPool.query(`
            SELECT card_id AS id, name, image_url, cost, attack, defense
            FROM cards
            ORDER BY RAND()
            LIMIT 30
          `);

            // 3) достаём из map игроков этой сессии
            const [p1, p2] = sessionPlayers.get(sessionId);

            // 4) случайный первый ход
            const firstPlayerId = Math.random() < 0.5 ? p1 : p2;
            console.log(
                `Emitting draft_update to room ${sessionId} → players:`,
                sessionPlayers.get(sessionId)
            );

            // 5) эмитим уже по правильному room = sessionId
            io.to(sessionId).emit('start_draft', {
                sessionId,
                cardPool: cards,
                firstPlayerId,
            });
            // сохраним драфт-стейт
            sessionDraftData.set(sessionId, {
                cardPool: cards,
                firstPlayerId,
            });
        }
    });
    socket.on('join_room', async ({ sessionId }) => {
        // проверяем, что в БД такая сессия ещё актуальна
        const [rows] = await dbPool.query(
            'SELECT status FROM sessions WHERE session_id = ?',
            [sessionId]
        );
        if (rows.length === 0 || !['lobby', 'draft'].includes(rows[0].status)) {
            // сессия не найдена или уже завершена/не в лобби
            socket.emit('invalid_session');
            return;
        }
        socket.join(sessionId);
        console.log(`→ ${socket.user.nickname} re-joined room ${sessionId}`);

        // если драфт уже идёт — «резюме»
        const data = sessionDraftData.get(sessionId);
        if (data) {
            const { cardPool, firstPlayerId } = data;

            // загрузим уже сделанные picks из БД
            const [rows] = await dbPool.query(
                'SELECT player_id AS pickedBy, card_id AS cardId, pick_order FROM deck_cards WHERE session_id = ? ORDER BY pick_order',
                [sessionId]
            );

            // вычислим, кто следующий
            const turnCount = rows.length;
            const [p1, p2] = sessionPlayers.get(sessionId);
            const nextPlayerId = turnCount % 2 === 0 ? p1 : p2;

            // отдадим этому сокету полный «резюме»
            socket.emit('resume_draft', {
                sessionId,
                cardPool,
                firstPlayerId,
                picks: rows.map((r) => ({
                    pickedBy: r.pickedBy,
                    cardId: r.cardId,
                })),
                nextPlayerId,
            });
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

    socket.on('disconnect', () => {
        socketsByNickname.delete(key);
        console.log(`← ${nickname} disconnected`);
    });
    socket.on('draft_pick', async ({ sessionId, cardId }) => {
        const me = socket.user.userId;
        const [p1, p2] = sessionPlayers.get(sessionId);
        // 1) Проверка очереди
        const turnCount = await dbPool
            .query(
                'SELECT COUNT(*) AS cnt FROM deck_cards WHERE session_id = ?',
                [sessionId]
            )
            .then((r) => r[0][0].cnt);
        // Определяем, кому ход: если turnCount чётно — первый игрок, иначе второй
        const isFirstTurn = turnCount % 2 === 0;
        const expectedPlayer = isFirstTurn ? p1 : p2;
        if (me !== expectedPlayer) return;

        // 2) Вычисляем pick_order для этого игрока
        const myCnt = await dbPool
            .query(
                'SELECT COUNT(*) AS cnt FROM deck_cards WHERE session_id = ? AND player_id = ?',
                [sessionId, me]
            )
            .then((r) => r[0][0].cnt);
        const pickOrder = myCnt + 1;

        // 3) Сохраняем в БД
        await dbPool.query(
            'INSERT INTO deck_cards (session_id, player_id, card_id, pick_order) VALUES (?, ?, ?, ?)',
            [sessionId, me, cardId, pickOrder]
        );

        // 4) Определяем следующего
        const nextPlayer = isFirstTurn ? p2 : p1;

        // 5) Рассылаем всем в комнате обновление
        io.to(sessionId).emit('draft_update', {
            pickedBy: me,
            cardId,
            nextPlayerId: nextPlayer,
        });

        // 6) Если оба набрали по 15 — завершаем
        const totalP1 = await dbPool
            .query(
                'SELECT COUNT(*) AS cnt FROM deck_cards WHERE session_id = ? AND player_id = ?',
                [sessionId, p1]
            )
            .then((r) => r[0][0].cnt);
        const totalP2 = await dbPool
            .query(
                'SELECT COUNT(*) AS cnt FROM deck_cards WHERE session_id = ? AND player_id = ?',
                [sessionId, p2]
            )
            .then((r) => r[0][0].cnt);
        if (totalP1 === 15 && totalP2 === 15) {
            io.to(sessionId).emit('draft_complete');
        }
    });
});

// стартуем
const PORT = process.env.PORT || config.server.port;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
