//js/game.js
(() => {
    const socket = io({ auth: { token: localStorage.getItem('token') } });
    let myId,
        sessionId = localStorage.getItem('sessionId');

    // — DOM-элементы —
    const handEl = document.getElementById('player-hand');
    const oppHandEl = document.getElementById('opponent-hand');
    const myFieldSlots = [
        ...document.querySelectorAll('#dropped-bottom .slot'),
    ];
    const oppFieldSlots = [...document.querySelectorAll('#dropped-top .slot')];
    const endBtn = document.querySelector('.end-turn');
    const timerEl = document.querySelector('.timer');
    const labelEl = document.querySelector('.turn-indicator .label');
    const hpMeEl = document.querySelector('.bottom-bar .health');
    const hpOppEl = document.querySelector('.top-bar .opponent-info .health');
    const crystalCountEl = document.getElementById('energy-count');
    const deckSizeEl = document.getElementById('deck-size');
    let turnTimerInt;
    let isMyTurn = false;

    socket.on('connect', () => {
        const raw = localStorage.getItem('token').split('.')[1];
        myId = JSON.parse(atob(raw)).userId;
        socket.emit('join_game', { sessionId });
    });

    // Вешаем dragover+drop на каждый слот:
    myFieldSlots.forEach((slotEl) => {
        slotEl.addEventListener('dragover', (e) => {
            if (isMyTurn) e.preventDefault();
            console.log('CLIENT drop:', e, slotEl.dataset.index);
        });
        slotEl.addEventListener('drop', (e) => {
            if (!isMyTurn) return;
            const cardId = +e.dataTransfer.getData('text/plain');
            // slot не передаём — сервер сам найдёт первый свободный
            console.log(
                'дропнули карточку',
                cardId,
                'в слот',
                slotEl.dataset.index
            );
            socket.emit('play_card', { sessionId, cardId });
        });
    });

    // инициализация игры
    socket.on('initGame', (data) => {
        // 1) руки и ресурсы
        renderHand(data.yourHand);
        hpMeEl.textContent = `${data.yourHp} PH`;
        crystalCountEl.textContent = data.yourCrystals;
        deckSizeEl.textContent = `${data.yourDeckSize} LEFT`;

        // 2) здоровье оппонента
        hpOppEl.textContent = `${data.oppHp} PH`;

        // 3) никнеймы и аватарки
        document.querySelector('.bottom-bar .nickname').textContent =
            data.yourNickname;
        document.querySelector('.bottom-bar .avatar img.icon').src =
            data.yourAvatar;

        document.querySelector('.top-bar .nickname').textContent =
            data.oppNickname;
        document.querySelector('.top-bar .avatar img.icon').src =
            data.oppAvatar;

        // 4) чей первый ход
        if (data.firstTurn === myId) startClientTurn(data.time);
        else waitOppTurn();
    });

    socket.on('yourTurn', ({ crystals, time }) => {
        startClientTurn(time);
        crystalCountEl.textContent = crystals;
    });
    function waitOppTurn(time) {
        labelEl.textContent = 'OPPONENT TURN';
        endBtn.disabled = true;
        endBtn.classList.remove('enabled');
        document.querySelector('.field-bottom').classList.remove('highlight');
        document.querySelector('.field-top').classList.add('highlight');
        isMyTurn = false;

        clearInterval(turnTimerInt);
        let t = time; // <-- теперь используем переданное время
        timerEl.textContent = t;
        turnTimerInt = setInterval(() => {
            if (--t < 0) clearInterval(turnTimerInt);
            timerEl.textContent = t;
        }, 1000);
    }

    socket.on('opponentTurn', ({ time }) => waitOppTurn(time));

    function startClientTurn(time) {
        labelEl.textContent = 'YOUR TURN';
        endBtn.disabled = false;
        endBtn.classList.add('enabled');
        document.querySelector('.field-bottom').classList.add('highlight');
        document.querySelector('.field-top').classList.remove('highlight');
        isMyTurn = true;
        clearInterval(turnTimerInt);
        let t = time;
        timerEl.textContent = t;
        turnTimerInt = setInterval(() => {
            if (--t < 0) clearInterval(turnTimerInt);
            timerEl.textContent = t;
        }, 1000);
    }

    // выкладка карты
    function renderHand(cards) {
        handEl.innerHTML = '';
        cards.forEach((c) => {
            const img = document.createElement('img');
            img.src = c.image_url;
            img.dataset.id = c.id;
            img.classList.add('hand-card');
            img.draggable = true;
            img.addEventListener('dragstart', (e) => {
                if (!isMyTurn) {
                    e.preventDefault(); // запретим даже драг, если не наш ход
                    return;
                }
                e.dataTransfer.setData('text/plain', c.id);
                document
                    .querySelector('.field-bottom')
                    .classList.add('drag-highlight');
            });
            img.addEventListener('dragend', () => {
                document
                    .querySelector('.field-bottom')
                    .classList.remove('drag-highlight');
            });
            handEl.appendChild(img);
        });
    }
    const fieldBottom = document.querySelector('.field-bottom');

    fieldBottom.addEventListener('dragover', (e) => {
        if (isMyTurn) e.preventDefault();
    });

    fieldBottom.addEventListener('drop', (e) => {
        if (!isMyTurn) return;
        const cardId = +e.dataTransfer.getData('text/plain');
        socket.emit('play_card', { sessionId, cardId });
    });

    // когда кто-то выложил карту
    socket.on('cardPlayed', ({ by, slot, card, crystals }) => {
        console.log('cardPlayed:', by, slot, card, crystals);
        const targetSlots = by === myId ? myFieldSlots : oppFieldSlots;
        // рисуем
        const img = document.createElement('img');
        img.src = by === myId ? card.image_url : '/assets/game/back card.png';
        img.classList.add('field-card');
        targetSlots[slot].appendChild(img);
        // если это мы — убираем из руки + обновляем кристаллы
        if (by === myId) {
            const our = handEl.querySelector(`img[data-id="${card.id}"]`);
            if (our) our.remove();
            // 2) обновили кристаллы, только если пришло число
            if (typeof crystals === 'number') {
                crystalCountEl.textContent = crystals;
            }
        }
    });

    socket.on('revealCards', (data) => {
        // data = { [p1]: [...], [p2]: [...] }
        const otherField = Object.entries(data).find(
            ([pid]) => pid !== String(myId)
        )[1];

        oppFieldSlots.forEach((slotEl, i) => {
            slotEl.innerHTML = '';
            if (otherField[i]) {
                const img = document.createElement('img');
                img.src = otherField[i].image_url;
                img.classList.add('field-card');
                slotEl.appendChild(img);
            }
        });
    });

    socket.on('battleResult', (res) => {
        // res = { [p1]: {hp, field}, [p2]: {hp, field} }
        Object.entries(res).forEach(([pid, { hp, field }]) => {
            const isMe = pid === String(myId);
            // обновляем HP
            if (isMe) hpMeEl.textContent = `${hp} PH`;
            else hpOppEl.textContent = `${hp} PH`;

            // затираем и рисуем новое поле
            const slots = isMe ? myFieldSlots : oppFieldSlots;
            slots.forEach((slotEl, i) => {
                slotEl.innerHTML = '';
                if (field[i]) {
                    const img = document.createElement('img');
                    img.src = field[i].image_url;
                    img.classList.add('field-card');
                    slotEl.appendChild(img);
                }
            });
        });
    });
    // новый раунд: добор карт и ресет кристаллов
    socket.on('newRound', ({ hand, crystals, deckSize, round }) => {
        renderHand(hand);
        crystalCountEl.textContent = crystals;
        deckSizeEl.textContent = `${deckSize} LEFT`;
    });

    // конец игры
    socket.on('gameOver', ({ winner }) => {
        clearInterval(turnTimerInt);
        const win = winner === myId;
        alert(win ? 'You win!' : 'You lose...');
        window.location.href = '/lobby.html';
    });

    endBtn.addEventListener('click', () => {
        socket.emit('end_turn');
        endBtn.disabled = true;
    });
})();
