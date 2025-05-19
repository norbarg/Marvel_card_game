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

    // сбросить кнопку INVITE
    inviteBtn.textContent = 'INVITE';

    // очистить
    inviteInput.value = '';
    localStorage.removeItem('sessionId');
    localStorage.removeItem('opponent');
}

// BACK-кнопка
backBtn.addEventListener('click', () => {
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

window.addEventListener('click', (e) => {
    if (e.target === modal) {
        modal.style.display = 'none';
    }
});

// Добавляем обработчик на клик по пустому аватару
emptyAvatar.addEventListener('click', () => {
    inviteInput.focus();
});
// function showDraftGrid() {
//   // здесь позже отрисуем драфтовую сетку
// }

// К нам пришло приглашение — открываем модал
socket.on('invite_received', ({ fromUserId, fromNickname, fromAvatar }) => {
    // сохраняем все в pendingInvite, включая avatar
    pendingInvite = { fromUserId, fromNickname, fromAvatar };

    // Покажем модал:
    inviteTextEl.textContent = `${fromNickname} приглашает вас в игру. Принять?`;
    inviteModal.style.display = 'flex';
});

// ==== в обработчике ACCEPT ====
acceptBtn.addEventListener('click', () => {
    if (!pendingInvite) return;
    const { fromUserId, fromNickname, fromAvatar } = pendingInvite;

    // сообщаем серверу
    socket.emit('invite_response', { fromUserId, accept: true });

    // сразу обновляем своё состояние
    sessionId = `battle_${fromUserId}_${myUserId}`;
    inRoom = true;

    // обновляем UI
    oppHex.src = fromAvatar;
    oppNickEl.textContent = fromNickname;
    readyBtn.disabled = false;

    // сохраняем, чтобы пережить перезагрузку
    localStorage.setItem('sessionId', sessionId);
    localStorage.setItem(
        'opponent',
        JSON.stringify({
            userId: fromUserId,
            nickname: fromNickname,
            avatar: fromAvatar,
        })
    );

    // прячем модал и сбрасываем pending
    inviteModal.style.display = 'none';
    pendingInvite = null;
});

// При клике «DECLINE»
declineBtn.addEventListener('click', () => {
    if (!pendingInvite) return;
    const { fromUserId } = pendingInvite;
    socket.emit('invite_response', { fromUserId, accept: false });
    inviteModal.style.display = 'none';
    // очищаем UI лобби, так как мы отказались
    cleanupLobby();
    inRoom = false;
    sessionId = null;
    pendingInvite = null;
});

// Клик вне модала — закрыть
window.addEventListener('click', (e) => {
    if (e.target === inviteModal) {
        inviteModal.style.display = 'none';
        cleanupLobby();
        inRoom = false;
        sessionId = null;
        pendingInvite = null;
    }
});

// Ответ на наше приглашение
socket.on(
    'invite_response',
    ({ fromUserId, fromNickname, fromAvatar, accept }) => {
        inviteBtn.textContent = 'INVITE';
        if (accept) {
            oppHex.src = fromAvatar;
            oppNickEl.textContent = fromNickname;
            readyBtn.disabled = false;
            sessionId = `battle_${fromUserId}_${myUserId}`;
            inRoom = true;
            // сохраняем, чтобы пережить перезагрузку
            localStorage.setItem('sessionId', sessionId);
            // Сохраняем данные оппонента
            localStorage.setItem(
                'opponent',
                JSON.stringify({
                    userId: fromUserId,
                    nickname: fromNickname,
                    avatar: fromAvatar,
                })
            );
        }
    }
);
// Когда оппонент вышел
socket.on('opponent_left', ({ userId }) => {
    cleanupLobby();
    inRoom = false;
    sessionId = null;
    localStorage.removeItem('sessionId');
});

// Вместо window.location.href в start_draft:
socket.on('start_draft', ({ sessionId: sid }) => {
    sessionId = sid;
    inRoom = true;
    localStorage.setItem('sessionId', sessionId);
    //   showDraftGrid();
});
