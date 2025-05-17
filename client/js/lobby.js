const modal = document.getElementById('avatarModal');
const hexes = document.querySelectorAll('.hex');
const avatarOptions = document.querySelectorAll('.avatars img');
let currentHex = null;

hexes.forEach((hex) => {
    hex.addEventListener('click', () => {
        currentHex = hex;
        modal.style.display = 'flex';
    });
});

avatarOptions.forEach((img) => {
    img.addEventListener('click', () => {
        if (currentHex) {
            const newImg = document.createElement('img');
            newImg.src = img.src;
            newImg.alt = img.alt;
            currentHex.innerHTML = ''; // clear previous
            currentHex.appendChild(newImg);
        }
        modal.style.display = 'none';
    });
});

window.addEventListener('click', (e) => {
    if (e.target === modal) {
        modal.style.display = 'none';
    }
});
