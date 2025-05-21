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
app.get('/game.html', (req, res) =>
    res.sendFile(path.join(__dirname, '../client/pages/game.html'))
);

app.use('/auth', authRoutes);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// мапы для быстрого поиска по нику и по userId
const socketsByNickname = new Map(); // nickname -> socket.id
const socketsByUserId = new Map(); // userId   -> socket.id
const readyMap = new Map(); // sessionId -> Set<userId>
const sessionPlayers = new Map(); // sessionId → [player1_id, player2_id]
const sessionDraftData = new Map(); //  sessionId → { cardPool, firstPlayerId }
const gameStates = new Map();

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
function endTurn(sessionId, playerId) {
    const state = gameStates.get(sessionId);
    if (!state || state.currentTurn !== playerId) return;

    // 1) Сброс таймаута
    clearTimeout(state.turnTimeout);
    state.turnTimeout = null;

    // 2) Берём игроков из sessionPlayers
    const playersArr = sessionPlayers.get(sessionId);
    if (!playersArr) {
        console.warn(`No sessionPlayers for session ${sessionId}`);
        return;
    }
    const [p1, p2] = playersArr;

    // 3) Переключаем очередь
    state.currentTurn = state.currentTurn === p1 ? p2 : p1;

    // 4) Проверяем, оба ли сходили (тогда битва) или просто ход следующего
    const firstMover = state.round % 2 === 1 ? p1 : p2;
    if (state.currentTurn === firstMover) {
        resolveBattle(sessionId);
    } else {
        startTurn(sessionId);
    }
}

function startTurn(sessionId) {
    const state = gameStates.get(sessionId);
    if (!state) return;
    const turnPlayer = state.currentTurn;
    // шлём событие startTurn тому, чей ход:
    const socketId = socketsByUserId.get(turnPlayer);
    io.to(socketId).emit('yourTurn', {
        crystals: state.players[turnPlayer].crystals,
        time: 30,
    });
    // остальным – opponentTurn
    const other = Object.keys(state.players).find((id) => id != turnPlayer);
    const otherSocketId = socketsByUserId.get(+other);
    io.to(otherSocketId).emit('opponentTurn', { time: 30 });

    // сбрасываем, если был старый таймаут
    if (state.turnTimeout) clearTimeout(state.turnTimeout);
    state.turnTimeout = setTimeout(() => {
        // если игрок не успел – принудительно заканчиваем ход
        endTurn(sessionId, turnPlayer);
    }, 30_000);
}
function resolveBattle(sessionId) {
    const state = gameStates.get(sessionId);
    const [p1, p2] = sessionPlayers.get(sessionId);
    const A = state.players[p1],
        B = state.players[p2];
    // сначала шлём всем reveal карт
    io.to(sessionId).emit('revealCards', {
        [p1]: A.field,
        [p2]: B.field,
    });
    // по каждому из 5 слотов
    for (let i = 0; i < 5; i++) {
        let cardA = A.field[i],
            cardB = B.field[i];
        if (cardA && cardB) {
            // бой карт
            while (cardA && cardB) {
                cardB.defense -= cardA.attack;
                if (cardB.defense <= 0) {
                    const over = -cardB.defense;
                    B.hp = Math.max(B.hp - over, 0);
                    B.field[i] = null;
                    cardB = null;
                    break;
                }
                cardA.defense -= cardB.attack;
                if (cardA.defense <= 0) {
                    const over = -cardA.defense;
                    A.hp = Math.max(A.hp - over, 0);
                    A.field[i] = null;
                    cardA = null;
                    break;
                }
            }
        } else if (cardA && !cardB) {
            B.hp = Math.max(B.hp - cardA.attack, 0);
        } else if (!cardA && cardB) {
            A.hp = Math.max(A.hp - cardB.attack, 0);
        }
    }

    // после боя
    io.to(sessionId).emit('battleResult', {
        [p1]: { hp: A.hp, field: A.field },
        [p2]: { hp: B.hp, field: B.field },
    });
    // проверяем конец игры
    if (A.hp <= 0 || B.hp <= 0) {
        const winner = A.hp > B.hp ? p1 : B.hp > A.hp ? p2 : null;
        io.to(sessionId).emit('gameOver', { winner });
        gameStates.delete(sessionId);
        return;
    }
    // иначе – новый раунд
    state.round++;
    // +5 кристаллов и сброс поля на руку/доупаковка, добор карт…
    [p1, p2].forEach((pid) => {
        const pl = state.players[pid];
        pl.crystals += 5;
        // добираем до 5 карт
        while (pl.hand.length < 5 && pl.deck.length) {
            pl.hand.push(pl.deck.shift());
        }
        // уведомляем каждого о новой руке и ресурсах
        const sid = socketsByUserId.get(+pid);
        io.to(sid).emit('newRound', {
            hand: pl.hand,
            crystals: pl.crystals,
            deckSize: pl.deck.length,
            round: state.round,
        });
    });
    // старт хода нового раунда
    startTurn(sessionId);
}

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
            // 1) переводим сессию в этап "battle"
            await dbPool.query(
                'UPDATE sessions SET status = ? WHERE session_id = ?',
                ['battle', sessionId]
            );

            // 2) оповещаем клиентов о завершении драфта
            io.to(sessionId).emit('draft_complete');
        }
    });
    socket.on('join_game', async ({ sessionId }) => {
        // 1) проверяем, что сессия в статусе battle
        const [[sess]] = await dbPool.query(
            'SELECT status, player1_id, player2_id FROM sessions WHERE session_id = ?',
            [sessionId]
        );
        if (!sess || sess.status !== 'battle') {
            return socket.emit('invalid_game');
        }
        // **1.5) подписываем текущий сокет в комнату**
        socket.join(sessionId);

        // 2) вытягиваем picks и разделяем на два массива
        const [rows] = await dbPool.query(
            `
            SELECT dc.player_id AS playerId,
                   c.card_id    AS id,
                   c.image_url,
                   c.cost,
                   c.attack,
                   c.defense
            FROM deck_cards dc
              JOIN cards c ON dc.card_id = c.card_id
            WHERE dc.session_id = ?
            ORDER BY dc.pick_order
          `,
            [sessionId]
        );
        const youId = socket.user.userId;
        const oppId =
            sess.player1_id === youId ? sess.player2_id : sess.player1_id;
        const youCards = rows
            .filter((r) => r.playerId === youId)
            .map((r) => ({
                id: r.id,
                image_url: r.image_url,
                cost: r.cost,
                attack: r.attack,
                defense: r.defense,
            }));
        const oppCards = rows
            .filter((r) => r.playerId !== youId)
            .map((r) => ({
                id: r.id,
                image_url: r.image_url,
                cost: r.cost,
                attack: r.attack,
                defense: r.defense,
            }));

        // 3) найдём сокет оппонента (чтобы подхватить его nickname/avatar)
        const oppSocketId = socketsByUserId.get(oppId);
        const oppSock = oppSocketId
            ? io.sockets.sockets.get(oppSocketId)
            : null;

        // 1.6) и подписываем оппонента (если он на линии) в ту же комнату
        if (oppSock) {
            oppSock.join(sessionId);
        }
        // 4) Формируем initState и сохраняем
        const initState = {
            players: {
                [youId]: {
                    hp: 20,
                    crystals: 8,
                    deck: youCards.slice(5),
                    hand: youCards.slice(0, 5),
                    field: [null, null, null, null, null],
                },
                [oppId]: {
                    hp: 20,
                    crystals: 8,
                    deck: oppCards.slice(5),
                    hand: oppCards.slice(0, 5),
                    field: [null, null, null, null, null],
                },
            },
            playersInfo: {
                [youId]: {
                    nickname: socket.user.nickname,
                    avatar: socket.user.avatar_url,
                },
                [oppId]: {
                    nickname: oppSock?.user.nickname,
                    avatar: oppSock?.user.avatar_url,
                },
            },
            currentTurn: Math.random() < 0.5 ? youId : oppId,
            round: 1,
            turnTimeout: null,
        };
        gameStates.set(sessionId, initState);

        // 5) Вспомогательная функция для отправки
        function makeInitData(you, opp) {
            const { players, playersInfo, round, currentTurn } = initState;
            return {
                yourHand: players[you].hand,
                yourHp: players[you].hp,
                yourCrystals: players[you].crystals,
                yourDeckSize: players[you].deck.length,

                oppHp: players[opp].hp,
                oppHandSize: players[opp].hand.length,
                oppDeckSize: players[opp].deck.length,

                yourNickname: playersInfo[you].nickname,
                yourAvatar: playersInfo[you].avatar,
                oppNickname: playersInfo[opp].nickname,
                oppAvatar: playersInfo[opp].avatar,

                round,
                firstTurn: currentTurn,
            };
        }

        // 6) Отправляем initGame обоим игрокам
        socket.emit('initGame', makeInitData(youId, oppId));
        if (oppSock) {
            oppSock.emit('initGame', makeInitData(oppId, youId));
        }

        // 7) Запускаем первый ход
        startTurn(sessionId);
    });

    socket.on('play_card', ({ sessionId, cardId }) => {
        const state = gameStates.get(sessionId);
        if (!state || state.currentTurn !== socket.user.userId) return;
        const me = state.players[socket.user.userId];
        const handIdx = me.hand.findIndex((c) => c.id === cardId);
        if (handIdx < 0 || me.crystals < me.hand[handIdx].cost) return;
        // снимаем кристаллы и убираем из руки
        me.crystals -= me.hand[handIdx].cost;
        const card = me.hand.splice(handIdx, 1)[0];
        // находим первый свободный слот
        const slot = me.field.findIndex((f) => f === null);
        me.field[slot] = { ...card };
        // И вот это ОЧЕНЬ важно:

        io.to(sessionId).emit('cardPlayed', {
            by: socket.user.userId,
            slot,
            card: { id: card.id, image_url: card.image_url },
            crystals: me.crystals,
        });
    });

    // игрок завершает ход
    socket.on('end_turn', () => {
        endTurn(socket.handshake.query.sessionId, socket.user.userId);
    });
});

// стартуем
const PORT = process.env.PORT || config.server.port;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
