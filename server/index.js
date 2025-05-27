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
app.post('/finish_session', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'No sessionId' });
    await dbPool.query('UPDATE sessions SET status = ? WHERE session_id = ?', [
        'finished',
        sessionId,
    ]);
    res.json({ ok: true });
});

const socketsByNickname = new Map();
const socketsByUserId = new Map();
const readyMap = new Map();
const sessionPlayers = new Map();
const sessionDraftData = new Map();
const gameStates = new Map();

io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
        const payload = jwt.verify(token, config.server.jwtSecret);
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

    clearTimeout(state.turnTimeout);
    state.turnTimeout = null;

    if (!state.moves) state.moves = new Set();
    state.moves.add(playerId);

    const [p1, p2] = sessionPlayers.get(sessionId);

    if (state.moves.size === 2) {
        state.moves.clear();
        resolveBattle(sessionId);
    } else {
        state.currentTurn = playerId === p1 ? p2 : p1;
        startTurn(sessionId);
    }
}
function makeResumeData(state, myId) {
    const oppId = Object.keys(state.players).find((id) => id != myId);
    return {
        players: {
            [myId]: {
                hp: state.players[myId].hp,
                crystals: state.players[myId].crystals,
                deck: state.players[myId].deck,
                hand: state.players[myId].hand,
                field: state.players[myId].field,
            },
            [oppId]: {
                hp: state.players[oppId].hp,
                crystals: state.players[oppId].crystals,
                deck: state.players[oppId].deck.length,
                hand: state.players[oppId].hand.length,
                field: state.players[oppId].field,
            },
        },
        playersInfo: state.playersInfo,
        currentTurn: state.currentTurn,
        round: state.round,
    };
}

function startTurn(sessionId) {
    const state = gameStates.get(sessionId);
    if (!state) return;
    const turnPlayer = state.currentTurn;
    const socketId = socketsByUserId.get(turnPlayer);
    io.to(socketId).emit('yourTurn', {
        crystals: state.players[turnPlayer].crystals,
        time: 30,
    });
    const other = Object.keys(state.players).find((id) => id != turnPlayer);
    const otherSocketId = socketsByUserId.get(+other);
    io.to(otherSocketId).emit('opponentTurn', { time: 30 });

    if (state.turnTimeout) clearTimeout(state.turnTimeout);
    state.turnTimeout = setTimeout(() => {
        endTurn(sessionId, turnPlayer);
    }, 30_000);
}
function resolveBattle(sessionId) {
    const state = gameStates.get(sessionId);
    const [p1, p2] = sessionPlayers.get(sessionId);
    const A = state.players[p1];
    const B = state.players[p2];

    if (A.field.every((c) => c === null) && B.field.every((c) => c === null)) {
        const empty = [null, null, null, null, null];
        while (A.field.length < 5) A.field.push(null);
        while (B.field.length < 5) B.field.push(null);
        A.field = A.field.slice(0, 5);
        B.field = B.field.slice(0, 5);

        io.to(sessionId).emit('battleResult', {
            [p1]: { hp: A.hp, field: empty },
            [p2]: { hp: B.hp, field: empty },
        });
        A.field = empty.slice();
        B.field = empty.slice();
        if (A.hp <= 0 || B.hp <= 0) {
            const winner = A.hp > B.hp ? p1 : B.hp > A.hp ? p2 : null;
            io.to(sessionId).emit('gameOver', { winner });
            gameStates.delete(sessionId);
            return;
        }
        state.round++;
        [p1, p2].forEach((pid) => {
            const pl = state.players[pid];
            pl.crystals += 5;
            while (pl.hand.length < 5 && pl.deck.length) {
                pl.hand.push(pl.deck.shift());
            }
            io.to(socketsByUserId.get(pid)).emit('newRound', {
                hand: pl.hand,
                crystals: pl.crystals,
                deckSize: pl.deck.length,
                round: state.round,
            });
        });
        startTurn(sessionId);
        return;
    }

    io.to(sessionId).emit('revealCards', {
        [p1]: A.field,
        [p2]: B.field,
    });

    let queueA = A.field.filter((c) => c).map((c) => ({ ...c }));
    let queueB = B.field.filter((c) => c).map((c) => ({ ...c }));
    A.field = [];
    B.field = [];

    let overA = 0;
    let overB = 0;

    if (queueA.length === 1 && queueB.length === 1) {
        const cardA = queueA.shift();
        const cardB = queueB.shift();
        let defA = cardA.defense;
        let defB = cardB.defense;
        const atkA = cardA.attack;
        const atkB = cardB.attack;

        while (defA > 0 && defB > 0) {
            defA -= atkB;
            defB -= atkA;
        }

        if (defA > 0 && defB <= 0) {
            A.field.push({ ...cardA, defense: defA });
            overB += Math.abs(defB);
        } else if (defB > 0 && defA <= 0) {
            B.field.push({ ...cardB, defense: defB });
            overA += Math.abs(defA);
        } else if (defA <= 0 && defB <= 0) {
            if (defA < defB) {
                overA += defB - defA;
            } else if (defB < defA) {
                overB += defA - defB;
            }
        }
    } else if (queueA.length > 1 && queueB.length > 1) {
        while (queueA.length && queueB.length) {
            const cardA = queueA.shift();
            const cardB = queueB.shift();
            let defA = cardA.defense,
                defB = cardB.defense;
            const atkA = cardA.attack,
                atkB = cardB.attack;
            while (defA > 0 && defB > 0) {
                defB -= atkA;
                defA -= atkB;
            }
            if (defA > 0) {
                A.field.push({ ...cardA, defense: defA });
                overB += Math.max(0, -defB);
            } else if (defB > 0) {
                B.field.push({ ...cardB, defense: defB });
                overA += Math.max(0, -defA);
            }
        }
        queueA.forEach((c) => (overB += c.attack));
        queueB.forEach((c) => (overA += c.attack));
    } else if (queueA.length > 0 && queueB.length === 0) {
        queueA.forEach((c) => (overB += c.attack));
    } else if (queueB.length > 0 && queueA.length === 0) {
        queueB.forEach((c) => (overA += c.attack));
    } else if (
        (queueA.length === 1 && queueB.length > 1) ||
        (queueB.length === 1 && queueA.length > 1)
    ) {
        const isASolo = queueA.length === 1;
        let soloCard = { ...(isASolo ? queueA[0] : queueB[0]) };
        let multi = (isASolo ? queueB : queueA).map((c) => ({ ...c }));
        const soloOwner = isASolo ? A : B;
        const multiOwner = isASolo ? B : A;

        let overSolo = 0,
            overMulti = 0;

        while (soloCard.defense > 0 && multi.length > 0) {
            for (let i = 0; i < multi.length; ++i) {
                soloCard.defense -= multi[i].attack;
                if (soloCard.defense <= 0) {
                    overSolo += -soloCard.defense;
                    break;
                }
            }
            if (soloCard.defense <= 0) break;

            let remainingAtk = soloCard.attack;
            let idx = 0;
            while (remainingAtk > 0 && idx < multi.length) {
                multi[idx].defense -= remainingAtk;
                if (multi[idx].defense <= 0) {
                    let overflow = -multi[idx].defense;
                    multi.splice(idx, 1);
                    remainingAtk = overflow;
                } else {
                    remainingAtk = 0;
                }
            }
            if (remainingAtk > 0) {
                overMulti += remainingAtk;
            }
        }

        if (soloCard.defense > 0) {
            soloOwner.field.push(soloCard);
        }

        if (isASolo) {
            overA += overSolo;
            overB += overMulti;
        } else {
            overA += overMulti;
            overB += overSolo;
        }
    }

    A.hp = Math.max(A.hp - overA, 0);
    B.hp = Math.max(B.hp - overB, 0);

    while (A.field.length < 5) A.field.push(null);
    while (B.field.length < 5) B.field.push(null);

    io.to(sessionId).emit('battleResult', {
        [p1]: { hp: A.hp, field: A.field },
        [p2]: { hp: B.hp, field: B.field },
    });
    A.field = [null, null, null, null, null];
    B.field = [null, null, null, null, null];
    if (A.hp <= 0 || B.hp <= 0) {
        const winner = A.hp > B.hp ? p1 : B.hp > A.hp ? p2 : null;
        io.to(sessionId).emit('gameOver', { winner });
        gameStates.delete(sessionId);
        return;
    }

    state.round++;
    [p1, p2].forEach((pid) => {
        const pl = state.players[pid];
        pl.crystals += 5;
        while (pl.hand.length < 5 && pl.deck.length) {
            pl.hand.push(pl.deck.shift());
        }
        const sid = socketsByUserId.get(+pid);
        io.to(sid).emit('newRound', {
            hand: pl.hand,
            crystals: pl.crystals,
            deckSize: pl.deck.length,
            round: state.round,
        });
    });

    let bothEmpty =
        A.hand.length === 0 &&
        B.hand.length === 0 &&
        A.deck.length === 0 &&
        B.deck.length === 0 &&
        A.field.every((c) => c === null) &&
        B.field.every((c) => c === null);

    if (bothEmpty) {
        let winner = null;
        if (A.hp > B.hp) winner = p1;
        else if (B.hp > A.hp) winner = p2;
        io.to(sessionId).emit('gameOver', { winner });
        gameStates.delete(sessionId);
        return;
    }

    startTurn(sessionId);
}

io.on('connection', (socket) => {
    const { userId, nickname } = socket.user;
    const key = nickname.toLowerCase();
    socketsByNickname.set(key, socket.id);
    socketsByUserId.set(userId, socket.id);

    socket.on('change_avatar', async ({ avatar_url }) => {
        try {
            await dbPool.query(
                'UPDATE users SET avatar_url = ? WHERE user_id = ?',
                [avatar_url, userId]
            );
            socket.user.avatar_url = avatar_url;

            socket.emit('avatar_updated', { avatar_url });
        } catch (err) {
            console.error('Error when changing avatar:', err);
            socket.emit('avatar_update_error', {
                error: 'Failed to update avatar',
            });
        }
    });

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

        io.to(inviterSocketId).emit('invite_response', {
            fromUserId: socket.user.userId,
            fromNickname: socket.user.nickname,
            fromAvatar: socket.user.avatar_url,
            accept,
        });

        if (!accept) return;

        const [res] = await dbPool.query(
            'INSERT INTO sessions (player1_id, player2_id, status) VALUES (?, ?, ?)',
            [fromUserId, socket.user.userId, 'lobby']
        );
        const dbSessionId = res.insertId.toString();

        const room = dbSessionId.toString();
        sessionPlayers.set(room, [fromUserId, socket.user.userId]);

        socket.join(room);
        io.sockets.sockets.get(inviterSocketId).join(room);
        io.to(room).emit('session_joined', { sessionId: room });
    });

    socket.on('player_ready', async ({ sessionId }) => {
        if (!readyMap.has(sessionId)) {
            readyMap.set(sessionId, new Set());
        }
        const set = readyMap.get(sessionId);
        set.add(userId);

        if (set.size === 2) {
            await dbPool.query(
                'UPDATE sessions SET status = ? WHERE session_id = ?',
                ['draft', sessionId]
            );

            const [cards] = await dbPool.query(`
            SELECT card_id AS id, name, image_url, cost, attack, defense
            FROM cards
            ORDER BY RAND()
            LIMIT 30
          `);

            const [p1, p2] = sessionPlayers.get(sessionId);

            const firstPlayerId = Math.random() < 0.5 ? p1 : p2;
            console.log(
                `Emitting draft_update to room ${sessionId} → players:`,
                sessionPlayers.get(sessionId)
            );

            io.to(sessionId).emit('start_draft', {
                sessionId,
                cardPool: cards,
                firstPlayerId,
            });
            sessionDraftData.set(sessionId, {
                cardPool: cards,
                firstPlayerId,
            });
        }
    });
    socket.on('join_room', async ({ sessionId }) => {
        const [rows] = await dbPool.query(
            'SELECT status FROM sessions WHERE session_id = ?',
            [sessionId]
        );
        if (rows.length === 0 || !['lobby', 'draft'].includes(rows[0].status)) {
            socket.emit('invalid_session');
            return;
        }
        socket.join(sessionId);
        console.log(`→ ${socket.user.nickname} re-joined room ${sessionId}`);

        const data = sessionDraftData.get(sessionId);
        if (data) {
            const { cardPool, firstPlayerId } = data;

            const [rows] = await dbPool.query(
                'SELECT player_id AS pickedBy, card_id AS cardId, pick_order FROM deck_cards WHERE session_id = ? ORDER BY pick_order',
                [sessionId]
            );

            const turnCount = rows.length;
            const [p1, p2] = sessionPlayers.get(sessionId);
            const nextPlayerId = turnCount % 2 === 0 ? p1 : p2;

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

    socket.on('leave_room', ({ sessionId }) => {
        socket.leave(sessionId);
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
        const turnCount = await dbPool
            .query(
                'SELECT COUNT(*) AS cnt FROM deck_cards WHERE session_id = ?',
                [sessionId]
            )
            .then((r) => r[0][0].cnt);
        const isFirstTurn = turnCount % 2 === 0;
        const expectedPlayer = isFirstTurn ? p1 : p2;
        if (me !== expectedPlayer) return;

        const myCnt = await dbPool
            .query(
                'SELECT COUNT(*) AS cnt FROM deck_cards WHERE session_id = ? AND player_id = ?',
                [sessionId, me]
            )
            .then((r) => r[0][0].cnt);
        const pickOrder = myCnt + 1;

        await dbPool.query(
            'INSERT INTO deck_cards (session_id, player_id, card_id, pick_order) VALUES (?, ?, ?, ?)',
            [sessionId, me, cardId, pickOrder]
        );

        const nextPlayer = isFirstTurn ? p2 : p1;

        io.to(sessionId).emit('draft_update', {
            pickedBy: me,
            cardId,
            nextPlayerId: nextPlayer,
        });

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
            await dbPool.query(
                'UPDATE sessions SET status = ? WHERE session_id = ?',
                ['battle', sessionId]
            );

            io.to(sessionId).emit('draft_complete');
        }
    });
    socket.on('join_game', async ({ sessionId }) => {
        if (!gameStates.has(sessionId)) {
            const [[sess]] = await dbPool.query(
                'SELECT status FROM sessions WHERE session_id = ?',
                [sessionId]
            );
            if (!sess || sess.status === 'finished') {
                return socket.emit('session_finished');
            }
        }

        socket.join(sessionId);

        socketsByUserId.set(socket.user.userId, socket.id);
        socketsByNickname.set(socket.user.nickname.toLowerCase(), socket.id);
        if (gameStates.has(sessionId)) {
            socket.emit(
                'resumeGame',
                makeResumeData(gameStates.get(sessionId), socket.user.userId)
            );
            return;
        }

        const [[sess]] = await dbPool.query(
            'SELECT status, player1_id, player2_id FROM sessions WHERE session_id = ?',
            [sessionId]
        );
        if (!sess || sess.status !== 'battle') {
            return socket.emit('invalid_game');
        }
        socket.join(sessionId);

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

        const oppSocketId = socketsByUserId.get(oppId);
        const oppSock = oppSocketId
            ? io.sockets.sockets.get(oppSocketId)
            : null;

        let oppNickname = 'Opponent';
        let oppAvatar = '/assets/game/default_avatar.png';
        if (oppSock && oppSock.user) {
            oppNickname = oppSock.user.nickname;
            oppAvatar = oppSock.user.avatar_url;
        } else {
            const [[{ nickname, avatar_url } = {}]] = await dbPool.query(
                'SELECT nickname, avatar_url FROM users WHERE user_id = ?',
                [oppId]
            );
            if (nickname) oppNickname = nickname;
            if (avatar_url) oppAvatar = avatar_url;
        }

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
                    nickname: oppNickname,
                    avatar: oppAvatar,
                },
            },
            currentTurn: Math.random() < 0.5 ? youId : oppId,
            round: 1,
            turnTimeout: null,
        };

        gameStates.set(sessionId, initState);

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
        const safeData = makeInitData(youId, oppId);
        try {
            JSON.stringify(safeData);
        } catch (e) {
            console.error('Cannot stringify safeData!', e);
        }
        socket.emit('initGame', safeData);

        if (oppSock && oppSock.connected) {
            oppSock.emit('initGame', makeInitData(oppId, youId));
        }

        startTurn(sessionId);
    });

    socket.on('play_card', ({ sessionId, cardId }) => {
        const state = gameStates.get(sessionId);
        if (!state || state.currentTurn !== socket.user.userId) return;
        const me = state.players[socket.user.userId];
        const handIdx = me.hand.findIndex((c) => c.id === cardId);
        if (handIdx < 0 || me.crystals < me.hand[handIdx].cost) return;
        me.crystals -= me.hand[handIdx].cost;
        const card = me.hand.splice(handIdx, 1)[0];
        const slot = me.field.findIndex((f) => f === null);
        me.field[slot] = { ...card };

        io.to(sessionId).emit('cardPlayed', {
            by: socket.user.userId,
            slot,
            card: { id: card.id, image_url: card.image_url },
            crystals: me.crystals,
        });
    });

    socket.on('end_turn', ({ sessionId }) => {
        endTurn(sessionId, socket.user.userId);
    });
});

const PORT = process.env.PORT || config.server.port;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
