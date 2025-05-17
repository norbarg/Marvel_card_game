const signInTab = document.getElementById('sign-in-tab');
const signUpTab = document.getElementById('sign-up-tab');
const confirmGroup = document.getElementById('confirm-group');

signInTab.onclick = () => {
    signInTab.classList.add('active');
    signUpTab.classList.remove('active');
    confirmGroup.classList.add('hidden');
};

signUpTab.onclick = () => {
    signUpTab.classList.add('active');
    signInTab.classList.remove('active');
    confirmGroup.classList.remove('hidden');
};
