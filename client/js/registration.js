const signInTab = document.getElementById('sign-in-tab');
const signUpTab = document.getElementById('sign-up-tab');
const confirmGroup = document.getElementById('confirm-group');
const enterBtn = document.querySelector('.enter-btn');
const nicknameEl = document.getElementById('nickname');
const passwordEl = document.getElementById('password');
const confirmPasswordEl = document.getElementById('confirm-password');

const errorEl = document.createElement('div');
errorEl.id = 'auth-error';
document.body.appendChild(errorEl);

function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add('show');

    setTimeout(() => {
        errorEl.classList.remove('show');
    }, 3000);
}

signInTab.addEventListener('click', () => {
    signInTab.classList.add('active');
    signUpTab.classList.remove('active');
    confirmGroup.classList.add('hidden');
    enterBtn.textContent = 'ENTER';
});

signUpTab.addEventListener('click', () => {
    signUpTab.classList.add('active');
    signInTab.classList.remove('active');
    confirmGroup.classList.remove('hidden');
    enterBtn.textContent = 'ENTER';
});

const API_BASE = '';

enterBtn.addEventListener('click', async () => {
    const nickname = nicknameEl.value.trim();
    const password = passwordEl.value;
    const isRegister = signUpTab.classList.contains('active');

    if (!nickname || !password) {
        showError('Enter nickname and password');
        return;
    }
    if (isRegister && password !== confirmPasswordEl.value) {
        showError('The passwords do not match');
        return;
    }

    try {
        const url = isRegister ? '/auth/register' : '/auth/login';
        const resp = await fetch(API_BASE + url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname, password }),
        });
        const result = await resp.json();

        if (!resp.ok) {
            showError(result.error || 'Something wrong');
            return;
        }

        localStorage.setItem('token', result.token);
        localStorage.setItem('nickname', result.user.nickname);
        localStorage.setItem('avatar', result.user.avatar_url);
        window.location.href = 'lobby.html';
    } catch (err) {
        console.error(err);
        showError('Server error when logging in');
    }
});
