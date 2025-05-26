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
    let lastRevealFields = null;

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
    function revealFadeOutLosers() {
        if (!lastRevealFields) return;

        // "fake" battleResult, вызываем fadeOut анимацию как раньше
        const youField = lastRevealFields[myId];
        const oppId = Object.keys(lastRevealFields).find(
            (pid) => pid !== String(myId)
        );
        const oppField = lastRevealFields[oppId];

        // Снимай классы "reveal", чтобы потом CSS-анимация проигравших работала
        myFieldSlots.forEach((slot, i) => {
            const img = slot.querySelector('img.field-card');
            if (img) img.classList.remove('reveal');
        });
        oppFieldSlots.forEach((slot, i) => {
            const img = slot.querySelector('img.field-card');
            if (img) img.classList.remove('reveal');
        });

        // "эмулируем" battleResult — на самом деле, сервер через 3 сек сам пришлёт это событие
        // Можно не делать тут ничего, а просто ждать on('battleResult')
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

    let battleResultPending = null; // чтобы не было повторов
    let lastRevealTime = 0;

    socket.on('revealCards', (data) => {
        lastRevealFields = data;
        lastRevealTime = Date.now();

        // --- ОТКРЫВАЕМ КАРТЫ ЛИЦОМ ---
        const youField = data[myId];
        const oppId = Object.keys(data).find((pid) => pid !== String(myId));
        const oppField = data[oppId];

        myFieldSlots.forEach((slotEl, i) => {
            slotEl.innerHTML = '';
            if (youField[i]) {
                const img = document.createElement('img');
                img.src = youField[i].image_url;
                img.classList.add('field-card', 'reveal');
                slotEl.appendChild(img);
            }
        });
        oppFieldSlots.forEach((slotEl, i) => {
            slotEl.innerHTML = '';
            if (oppField[i]) {
                const img = document.createElement('img');
                img.src = oppField[i].image_url;
                img.classList.add('field-card', 'reveal');
                slotEl.appendChild(img);
            }
        });
    });

    socket.on('battleResult', (res) => {
        const timeSinceReveal = Date.now() - lastRevealTime;
        const wait = Math.max(0, 3000 - timeSinceReveal);

        setTimeout(() => {
            // 1) Обновляем HP
            Object.entries(res).forEach(([pid, { hp }]) => {
                const isMe = pid === String(myId);
                if (isMe) hpMeEl.textContent = `${hp} PH`;
                else hpOppEl.textContent = `${hp} PH`;
            });

            // 2) Анимация проигравших и победителей
            const oldMy = myFieldSlots.map((s) =>
                s.querySelector('img.field-card')
            );
            const oldOpp = oppFieldSlots.map((s) =>
                s.querySelector('img.field-card')
            );

            const youField = res[myId].field;
            const oppId = Object.keys(res).find((pid) => pid !== String(myId));
            const oppField = res[oppId].field;

            // Сначала проигравшие — делаем тусклыми и убираем через 1с
            function fadeOutLosers(oldEls, newField) {
                oldEls.forEach((oldEl, i) => {
                    if (!oldEl) return;
                    if (!newField[i]) {
                        oldEl.classList.add('loser-fade');
                        setTimeout(() => oldEl.remove(), 1000);
                    }
                });
            }

            // Потом (через 1с) победители — делаем прозрачными и убираем через еще 1с
            function fadeOutWinners(oldEls, newField) {
                oldEls.forEach((oldEl, i) => {
                    if (!oldEl) return;
                    if (newField[i]) {
                        setTimeout(() => {
                            oldEl.classList.add('winner-fade');
                            setTimeout(() => oldEl.remove(), 1000);
                        }, 1000); // Через 1 секунду после анимации проигравших
                    }
                });
            }

            fadeOutLosers(oldMy, youField);
            fadeOutLosers(oldOpp, oppField);
            fadeOutWinners(oldMy, youField);
            fadeOutWinners(oldOpp, oppField);

            // Через 2 секунды всё подчистить (страховка)
            setTimeout(() => {
                myFieldSlots.forEach((s) => (s.innerHTML = ''));
                oppFieldSlots.forEach((s) => (s.innerHTML = ''));
            }, 2000);
        }, wait);
    });

    // новый раунд: добор карт и ресет кристаллов
    socket.on('newRound', ({ hand, crystals, deckSize, round }) => {
        renderHand(hand);
        crystalCountEl.textContent = crystals;
        deckSizeEl.textContent = `${deckSize} LEFT`;
    });

    endBtn.addEventListener('click', () => {
        socket.emit('end_turn', { sessionId }); // <-- Передаём sessionId!
        endBtn.disabled = true;
    });

    socket.on('resumeGame', (state) => {
        // Твой id — myId, получаем oppId
        const myState = state.players[myId];
        const oppId = Object.keys(state.players).find(
            (id) => id !== String(myId)
        );
        const oppState = state.players[oppId];

        hpMeEl.textContent = `${myState.hp} PH`;
        hpOppEl.textContent = `${oppState.hp} PH`;
        crystalCountEl.textContent = myState.crystals;
        deckSizeEl.textContent = `${myState.deck.length} LEFT`;

        renderHand(myState.hand);

        myFieldSlots.forEach((s, i) => {
            s.innerHTML = '';
            if (myState.field[i]) {
                const img = document.createElement('img');
                img.src = myState.field[i].image_url;
                img.classList.add('field-card');
                s.appendChild(img);
            }
        });
        oppFieldSlots.forEach((s, i) => {
            s.innerHTML = '';
            if (oppState.field[i]) {
                const img = document.createElement('img');
                img.src = '/assets/game/back card.png';
                img.classList.add('field-card');
                s.appendChild(img);
            }
        });

        // Никнеймы, аватарки
        document.querySelector('.bottom-bar .nickname').textContent =
            state.playersInfo[myId].nickname;
        document.querySelector('.bottom-bar .avatar img.icon').src =
            state.playersInfo[myId].avatar;
        document.querySelector('.top-bar .nickname').textContent =
            state.playersInfo[oppId].nickname;
        document.querySelector('.top-bar .avatar img.icon').src =
            state.playersInfo[oppId].avatar;

        if (state.currentTurn === Number(myId)) {
            startClientTurn(30);
        } else {
            waitOppTurn(30);
        }
    });

    socket.on('gameOver', async ({ winner }) => {
        clearInterval(turnTimerInt);
        // Меняем статус сессии на finished (см. ниже)
        await fetch('/finish_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
        });

        const win = winner === myId;
        // Показываем оверлей
        const overlay = document.getElementById('game-over-overlay');
        const img = overlay.querySelector('.game-over-img');
        img.src = win ? '/assets/game/victory.png' : '/assets/game/defeat.png';
        overlay.style.display = 'flex';

        // Возврат по клику
        overlay.onclick = () => {
            window.location.href = '/lobby.html';
        };
    });
    socket.on('session_finished', () => {
        // Можно показывать алерт или сразу редиректить
        window.location.href = '/lobby.html';
    });
})();
