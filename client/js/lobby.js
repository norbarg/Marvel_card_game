const token = localStorage.getItem('token');
const nickname = localStorage.getItem('nickname');
const avatar =
    localStorage.getItem('avatar') || '/assets/icons/dr strange icon.png';
const raw = token.split('.')[1];
const { userId: myUserId } = JSON.parse(atob(raw));

if (!token || !nickname) {
    window.location.href = '/';
}

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
const inviteModal = document.getElementById('inviteModal');
const inviteTextEl = document.getElementById('inviteText');
const acceptBtn = document.getElementById('acceptInvite');
const declineBtn = document.getElementById('declineInvite');
let pendingInvite = null;
let isMyTurn = false;
let draftTimer = null;

let sessionId = localStorage.getItem('sessionId');
let inRoom = !!sessionId;
const storedOpp = localStorage.getItem('opponent');
if (inRoom && storedOpp) {
    const { nickname: oNick, avatar: oAv } = JSON.parse(storedOpp);
    oppHex.src = oAv;
    oppNickEl.textContent = oNick;
    readyBtn.disabled = false;
}

console.log(`Connecting socket as ${nickname}`);
const socket = io({
    auth: { token },
});

socket.on('connect', () => {
    console.log('Socket.IO connect, id=', socket.id);
    if (sessionId) {
        socket.emit('join_room', { sessionId });
    }
});
socket.on('connect_error', (err) => {
    console.error('Socket.IO connection error:', err.message);
});
youHex.src = avatar;
youNickEl.textContent = nickname;

let currentOpponent = null;

function cleanupLobby() {
    oppHex.src = '/assets/icons/empty icon.png';
    oppNickEl.textContent = '';

    readyBtn.disabled = true;
    readyBtn.classList.remove('enabled');

    inviteBtn.textContent = 'INVITE';

    inviteInput.value = '';
    localStorage.removeItem('sessionId');
    localStorage.removeItem('opponent');
}
function disableBackButton() {
    backBtn.disabled = true;
    backBtn.classList.add('disabled');
}

backBtn.addEventListener('click', () => {
    if (backBtn.disabled) return;

    if (inRoom && sessionId) {
        socket.emit('leave_room', { sessionId });
        cleanupLobby();
        inRoom = false;
        sessionId = null;
        localStorage.removeItem('sessionId');
    } else {
        window.location.href = '/';
    }
});
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
            currentHex.innerHTML = '';
            const newImg = document.createElement('img');
            newImg.src = img.src;
            newImg.alt = img.alt;
            currentHex.appendChild(newImg);

            localStorage.setItem('avatar', img.src);

            socket.emit('change_avatar', { avatar_url: img.src });
        }
        modal.style.display = 'none';
    });
});

emptyAvatar.addEventListener('click', () => {
    inviteInput.focus();
});

socket.on('invite_received', ({ fromUserId, fromNickname, fromAvatar }) => {
    pendingInvite = { fromUserId, fromNickname, fromAvatar };

    inviteTextEl.textContent = `${fromNickname} invites you to the game. Accept?`;
    inviteModal.classList.add('show');
});

acceptBtn.addEventListener('click', () => {
    if (!pendingInvite) return;
    const { fromUserId, fromNickname, fromAvatar } = pendingInvite;

    socket.emit('invite_response', { fromUserId, accept: true });

    currentOpponent = {
        userId: fromUserId,
        nickname: fromNickname,
        avatar: fromAvatar,
    };
    localStorage.setItem('opponent', JSON.stringify(currentOpponent));
    oppHex.src = fromAvatar;
    oppNickEl.textContent = fromNickname;
    readyBtn.disabled = false;
    readyBtn.classList.add('enabled');

    inviteModal.classList.remove('show');
    pendingInvite = null;
});
const helpButton = document.querySelector('.help-button');
const helpModal = document.getElementById('helpModal');
const helpModalClose = document.getElementById('helpModalCloseBtn');

helpButton.addEventListener('click', () => {
    helpModal.classList.add('active');
    document.body.style.overflow = 'hidden';
});

helpModalClose.addEventListener('click', () => {
    helpModal.classList.remove('active');
    document.body.style.overflow = '';
});

helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) {
        helpModal.classList.remove('active');
        document.body.style.overflow = '';
    }
});

declineBtn.addEventListener('click', () => {
    if (!pendingInvite) return;
    const { fromUserId } = pendingInvite;
    socket.emit('invite_response', { fromUserId, accept: false });

    inviteModal.classList.remove('show');
    cleanupLobby();
    inRoom = false;
    sessionId = null;
    pendingInvite = null;
    localStorage.removeItem('sessionId');
    localStorage.removeItem('opponent');
});

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

socket.on(
    'invite_response',
    ({ fromUserId, fromNickname, fromAvatar, accept }) => {
        inviteBtn.textContent = 'INVITE';
        if (!accept) return;
        currentOpponent = {
            userId: fromUserId,
            nickname: fromNickname,
            avatar: fromAvatar,
        };
        localStorage.setItem('opponent', JSON.stringify(currentOpponent));
        oppHex.src = fromAvatar;
        oppNickEl.textContent = fromNickname;
    }
);

socket.on('session_joined', ({ sessionId: sid }) => {
    sessionId = sid;
    inRoom = true;
    localStorage.setItem('sessionId', sessionId);
    readyBtn.disabled = false;
    readyBtn.classList.add('enabled');
});

socket.on('opponent_left', ({ userId }) => {
    cleanupLobby();
    inRoom = false;
    sessionId = null;
    localStorage.removeItem('sessionId');
});

let amReady = false;

readyBtn.addEventListener('click', () => {
    if (!inRoom || amReady) return;

    amReady = true;
    readyBtn.disabled = true;
    readyBtn.classList.add('ready-on');

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
    const cards = [...document.querySelectorAll('.draft-card:not(.picked)')];
    if (!cards.length) return;

    const choice = cards[Math.floor(Math.random() * cards.length)];
    const pickedId = Number(choice.dataset.id);

    isMyTurn = false;
    document.querySelector('.turn-indicator').textContent = 'OPPONENT TURN';
    clearInterval(draftTimer);

    choice.classList.add('picked');

    console.log('auto emitting draft_pick', pickedId);
    socket.emit('draft_pick', { sessionId, cardId: pickedId });
}

socket.on('start_draft', ({ sessionId: sid, cardPool, firstPlayerId }) => {
    console.log('start_draft for', nickname, 'sessionId=', sid);

    sessionId = sid;
    showDraftPanel(cardPool);
    disableBackButton();
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

    grid.innerHTML = '';
    countEl.textContent = '0/15';
    turnEl.textContent = 'YOUR TURN';
    timerEl.textContent = '30';

    cardPool.forEach((card) => {
        const img = document.createElement('img');
        img.classList.add('draft-card');
        img.dataset.id = card.id;
        img.src = card.image_url;
        img.alt = card.name;

        img.addEventListener('click', () => {
            if (!isMyTurn || img.classList.contains('picked')) return;

            isMyTurn = false;
            document.querySelector('.turn-indicator').textContent =
                'OPPONENT TURN';
            clearInterval(draftTimer);

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

    const img = document.querySelector(`.draft-card[data-id="${cardId}"]`);
    console.log('→ found img?', img);
    if (img) img.classList.add('picked');

    const countEl = document.querySelector('.picked-count');
    const current =
        +countEl.textContent.split('/')[0] + (pickedBy === myUserId ? 1 : 0);
    countEl.textContent = `${current}/15`;

    isMyTurn = nextPlayerId === myUserId;
    document.querySelector('.turn-indicator').textContent = isMyTurn
        ? 'YOUR TURN'
        : 'OPPONENT TURN';

    clearInterval(draftTimer);
    startDraftTimer();
});

socket.on(
    'resume_draft',
    ({ sessionId: sid, cardPool, firstPlayerId, picks, nextPlayerId }) => {
        sessionId = sid;
        showDraftPanel(cardPool);
        disableBackButton();

        picks.forEach(({ pickedBy, cardId }) => {
            const img = document.querySelector(
                `.draft-card[data-id="${cardId}"]`
            );
            if (img) img.classList.add('picked');
        });

        const myCount = picks.filter((p) => p.pickedBy === myUserId).length;
        document.querySelector('.picked-count').textContent = `${myCount}/15`;

        isMyTurn = nextPlayerId === myUserId;
        document.querySelector('.turn-indicator').textContent = isMyTurn
            ? 'YOUR TURN'
            : 'OPPONENT TURN';

        startDraftTimer();
    }
);

socket.on('draft_complete', () => {
    clearInterval(draftTimer);
    window.location.href = '/game.html';
});
socket.on('invalid_session', () => {
    console.warn('Session is no longer valid, cleaning up…');
    cleanupLobby();

    inRoom = false;
    sessionId = null;
});
