// client/js/lobby.js

// — 1. Проверяем авторизацию —
const token = localStorage.getItem('token');
const nickname = localStorage.getItem('nickname');
const avatar =
    localStorage.getItem('avatar') || '/assets/icons/dr strange icon.png';
const raw = token.split('.')[1];
const { userId: myUserId } = JSON.parse(atob(raw)); // теперь у нас есть myUserId

if (!token || !nickname) {
    window.location.href = '/';
}

// — 3. UI элементы —
const youHex = document.querySelector('.avatar.hex.you img');
const youNickEl = document.querySelector('.player-1 .nickname-wrapper span');
const oppHex = document.querySelector('.avatar.hex.empty img');
const oppNickEl = document.querySelector('.player-2 .nickname-wrapper span');
const inviteInput = document.getElementById('inviteInput');
const inviteBtn = document.querySelector('.invite-button');
const readyBtn = document.querySelector('.ready-button');
const backBtn = document.querySelector('.back-button');
const modal = document.getElementById('avatarModal');
const hexes = document.querySelectorAll('.hex.you');
const avatarOptions = document.querySelectorAll('.avatars img');
const emptyAvatar = document.querySelector('.avatar.hex.empty');
let currentHex = null;
// Новые переменные:
const inviteModal = document.getElementById('inviteModal');
const inviteTextEl = document.getElementById('inviteText');
const acceptBtn = document.getElementById('acceptInvite');
const declineBtn = document.getElementById('declineInvite');
let pendingInvite = null; // { fromUserId, fromNickname }
let isMyTurn = false;
let draftTimer = null;

// Читаем из localStorage, если были
let sessionId = localStorage.getItem('sessionId');
let inRoom = !!sessionId;
const storedOpp = localStorage.getItem('opponent');
if (inRoom && storedOpp) {
    const { nickname: oNick, avatar: oAv } = JSON.parse(storedOpp);
    oppHex.src = oAv;
    oppNickEl.textContent = oNick;
    readyBtn.disabled = false;
}

// — 2. Подключаемся к серверу до любого emit —
console.log(`Connecting socket as ${nickname}`);
const socket = io({
    auth: { token },
});

socket.on('connect', () => {
    console.log('Socket.IO connect, id=', socket.id);
    // если остались в комнате после перезагрузки — снова join
    if (sessionId) {
        socket.emit('join_room', { sessionId });
    }
});
socket.on('connect_error', (err) => {
    console.error('Socket.IO connection error:', err.message);
});
// Показываем свои данные:
youHex.src = avatar;
youNickEl.textContent = nickname;

// — 4. Храним состояние —
let currentOpponent = null; // { nickname, avatar, userId }

// сброс UI лобби (очищаем оппонента, кнопки)
function cleanupLobby() {
    // очистить слот оппонента
    oppHex.src = '/assets/icons/empty icon.png';
    oppNickEl.textContent = '';

    // заблокировать READY
    readyBtn.disabled = true;
    readyBtn.classList.remove('enabled');

    // сбросить кнопку INVITE
    inviteBtn.textContent = 'INVITE';

    // очистить
    inviteInput.value = '';
    localStorage.removeItem('sessionId');
    localStorage.removeItem('opponent');
}
function disableBackButton() {
    backBtn.disabled = true;
    backBtn.classList.add('disabled'); // для CSS-стилей, если нужно
}

// BACK-кнопка
backBtn.addEventListener('click', () => {
    if (backBtn.disabled) return;

    if (inRoom && sessionId) {
        socket.emit('leave_room', { sessionId });
        cleanupLobby(); // <-- Ваша функция, сбрасывающая UI (очистить oppHex, oppNickEl, скрыть драфт-сетку)
        inRoom = false;
        sessionId = null;
        localStorage.removeItem('sessionId');
    } else {
        window.location.href = '/';
    }
});
// Клик по INVITE
inviteBtn.addEventListener('click', () => {
    const target = inviteInput.value.trim();
    if (!target || target.toLowerCase() === nickname.toLowerCase()) return;
    console.log(`▶ Emitting invite → "${target}"`);
    socket.emit('invite', { targetNickname: target });
    inviteBtn.textContent = 'Inviting...';
    inviteInput.value = '';
});

hexes.forEach((hex) => {
    hex.addEventListener('click', () => {
        currentHex = hex;
        modal.style.display = 'flex';
    });
});

avatarOptions.forEach((img) => {
    img.addEventListener('click', () => {
        if (currentHex) {
            // Обновляем UI
            currentHex.innerHTML = '';
            const newImg = document.createElement('img');
            newImg.src = img.src;
            newImg.alt = img.alt;
            currentHex.appendChild(newImg);

            // Сохраняем локально
            localStorage.setItem('avatar', img.src);

            // Шлём на сервер, чтобы обновить в БД
            socket.emit('change_avatar', { avatar_url: img.src });
        }
        // Скрываем модал сразу, не дожидаясь ответа
        modal.style.display = 'none';
    });
});

// Добавляем обработчик на клик по пустому аватару
emptyAvatar.addEventListener('click', () => {
    inviteInput.focus();
});

// К нам пришло приглашение — открываем модал
socket.on('invite_received', ({ fromUserId, fromNickname, fromAvatar }) => {
    // сохраняем все в pendingInvite, включая avatar
    pendingInvite = { fromUserId, fromNickname, fromAvatar };

    // Покажем модал:
    inviteTextEl.textContent = `${fromNickname} invites you to the game. Accept?`;
    inviteModal.classList.add('show');
});

// ==== в обработчике ACCEPT ====
acceptBtn.addEventListener('click', () => {
    if (!pendingInvite) return;
    const { fromUserId, fromNickname, fromAvatar } = pendingInvite;

    // сообщаем серверу
    socket.emit('invite_response', { fromUserId, accept: true });

    // сразу же показываем оппонента и сохраняем его, как у того, кто приглашал
    currentOpponent = {
        userId: fromUserId,
        nickname: fromNickname,
        avatar: fromAvatar,
    };
    localStorage.setItem('opponent', JSON.stringify(currentOpponent));
    oppHex.src = fromAvatar;
    oppNickEl.textContent = fromNickname;
    // разблокируем READY
    readyBtn.disabled = false;
    readyBtn.classList.add('enabled');

    // прячем модал и сбрасываем pending
    inviteModal.classList.remove('show');
    pendingInvite = null;
});

// При клике «DECLINE»
declineBtn.addEventListener('click', () => {
    if (!pendingInvite) return;
    const { fromUserId } = pendingInvite;
    socket.emit('invite_response', { fromUserId, accept: false });

    inviteModal.classList.remove('show');
    // очищаем UI лобби, так как мы отказались
    cleanupLobby();
    inRoom = false;
    sessionId = null;
    pendingInvite = null;
    localStorage.removeItem('sessionId');
    localStorage.removeItem('opponent');
});

// Клик вне модала — закрыть
window.addEventListener('click', (e) => {
    if (e.target === modal) {
        modal.style.display = 'none';
    }
    if (e.target === inviteModal) {
        inviteModal.classList.remove('show');
        cleanupLobby();
        inRoom = false;
        sessionId = null;
        pendingInvite = null;
        localStorage.removeItem('sessionId');
        localStorage.removeItem('opponent');
    }
});

// Ответ на наше приглашение
// 1) Обработка ответа
socket.on(
    'invite_response',
    ({ fromUserId, fromNickname, fromAvatar, accept }) => {
        inviteBtn.textContent = 'INVITE';
        if (!accept) return;
        // запомним оппонента и сохраним в localStorage
        currentOpponent = {
            userId: fromUserId,
            nickname: fromNickname,
            avatar: fromAvatar,
        };
        localStorage.setItem('opponent', JSON.stringify(currentOpponent));
        oppHex.src = fromAvatar;
        oppNickEl.textContent = fromNickname;
        // НЕ сохраняем sessionId — ждём session_joined
    }
);

// 2) Получили канонический числовой ключ комнаты
socket.on('session_joined', ({ sessionId: sid }) => {
    sessionId = sid;
    inRoom = true;
    // теперь точно записываем в localStorage
    localStorage.setItem('sessionId', sessionId);
    // разблокируем READY
    readyBtn.disabled = false;
    readyBtn.classList.add('enabled');
});

// Когда оппонент вышел
socket.on('opponent_left', ({ userId }) => {
    cleanupLobby();
    inRoom = false;
    sessionId = null;
    localStorage.removeItem('sessionId');
});

let amReady = false;

// 1) Клик по READY
readyBtn.addEventListener('click', () => {
    if (!inRoom || amReady) return;

    amReady = true;
    readyBtn.disabled = true;
    readyBtn.classList.add('ready-on'); // перекрасим стили

    // говорим серверу, что готовы
    socket.emit('player_ready', { sessionId });
});
function startDraftTimer() {
    clearInterval(draftTimer);
    const timerEl = document.querySelector('.timer');
    let time = 30;
    timerEl.textContent = time;
    draftTimer = setInterval(() => {
        time -= 1;
        timerEl.textContent = time;
        if (time <= 0) {
            clearInterval(draftTimer);
            if (isMyTurn) autoPick();
        }
    }, 1000);
}

function autoPick() {
    // Ищем только картинки
    const cards = [...document.querySelectorAll('.draft-card:not(.picked)')];
    if (!cards.length) return;

    // Случайно выбираем одну
    const choice = cards[Math.floor(Math.random() * cards.length)];
    const pickedId = Number(choice.dataset.id);

    // Локально отмечаем ход
    isMyTurn = false;
    document.querySelector('.turn-indicator').textContent = 'OPPONENT TURN';
    clearInterval(draftTimer);

    // Помечаем её отмеченной
    choice.classList.add('picked');

    // И шлём на сервер
    console.log('auto emitting draft_pick', pickedId);
    socket.emit('draft_pick', { sessionId, cardId: pickedId });
}

socket.on('start_draft', ({ sessionId: sid, cardPool, firstPlayerId }) => {
    console.log('start_draft for', nickname, 'sessionId=', sid);

    sessionId = sid;
    showDraftPanel(cardPool);
    disableBackButton();
    // выставляем ход:
    isMyTurn = myUserId === firstPlayerId;
    document.querySelector('.turn-indicator').textContent = isMyTurn
        ? 'YOUR TURN'
        : 'OPPONENT TURN';

    startDraftTimer();
});

/**
 * @param {Array} cardPool — массив объектов { id, name, image_url, cost, attack, defense }
 */
function showDraftPanel(cardPool) {
    const panel = document.querySelector('.draft-panel');
    const grid = panel.querySelector('.card-grid');
    const countEl = panel.querySelector('.picked-count');
    const turnEl = panel.querySelector('.turn-indicator');
    const timerEl = panel.querySelector('.timer');

    // Сброс UI
    grid.innerHTML = '';
    countEl.textContent = '0/15';
    turnEl.textContent = 'YOUR TURN';
    timerEl.textContent = '30';

    cardPool.forEach((card) => {
        // создаём <img>
        const img = document.createElement('img');
        img.classList.add('draft-card');
        img.dataset.id = card.id;
        img.src = card.image_url;
        img.alt = card.name;

        img.addEventListener('click', () => {
            if (!isMyTurn || img.classList.contains('picked')) return;

            // локально блокируем ход
            isMyTurn = false;
            document.querySelector('.turn-indicator').textContent =
                'OPPONENT TURN';
            clearInterval(draftTimer);

            // отмечаем как выбранную
            img.classList.add('picked');

            socket.emit('draft_pick', {
                sessionId,
                cardId: Number(img.dataset.id),
            });
        });

        grid.appendChild(img);
    });

    panel.classList.remove('hidden');
}

socket.on('draft_update', ({ pickedBy, cardId, nextPlayerId }) => {
    console.log('[draft_update]', {
        pickedBy,
        cardId,
        nextPlayerId,
        myUserId,
        isMyTurn,
    });

    // 1) помечаем на обоих
    const img = document.querySelector(`.draft-card[data-id="${cardId}"]`);
    console.log('→ found img?', img);
    if (img) img.classList.add('picked');

    // 2) обновляем счётчик:
    const countEl = document.querySelector('.picked-count');
    const current =
        +countEl.textContent.split('/')[0] + (pickedBy === myUserId ? 1 : 0);
    countEl.textContent = `${current}/15`;

    // 3) чей ход
    isMyTurn = nextPlayerId === myUserId;
    document.querySelector('.turn-indicator').textContent = isMyTurn
        ? 'YOUR TURN'
        : 'OPPONENT TURN';

    // 4) обязательно перезапускаем таймер
    clearInterval(draftTimer);
    startDraftTimer();
});

/**
 * Восстановление драфта после перезагрузки
 */
socket.on(
    'resume_draft',
    ({ sessionId: sid, cardPool, firstPlayerId, picks, nextPlayerId }) => {
        sessionId = sid;
        showDraftPanel(cardPool);
        disableBackButton();

        // Промаркируем уже выбранные карты
        picks.forEach(({ pickedBy, cardId }) => {
            const img = document.querySelector(
                `.draft-card[data-id="${cardId}"]`
            );
            if (img) img.classList.add('picked');
        });

        // Обновим счётчик «моих» picks
        const myCount = picks.filter((p) => p.pickedBy === myUserId).length;
        document.querySelector('.picked-count').textContent = `${myCount}/15`;

        // Чей ход
        isMyTurn = nextPlayerId === myUserId;
        document.querySelector('.turn-indicator').textContent = isMyTurn
            ? 'YOUR TURN'
            : 'OPPONENT TURN';

        // Запускаем таймер
        startDraftTimer();
    }
);

socket.on('draft_complete', () => {
    clearInterval(draftTimer);
    // перенаправляем на страницу игры
    window.location.href = '/game.html';
});
// если сервер посылает, что сессия невалидна — чистим и уходим в корень
socket.on('invalid_session', () => {
    console.warn('Session is no longer valid, cleaning up…');
    cleanupLobby();
    // сбросим флаг, чтобы READY и INVITE снова заработали
    inRoom = false;
    sessionId = null;
    // опционально: перенаправим на стартовую
    // window.location.href = '/lobby.html';
});
