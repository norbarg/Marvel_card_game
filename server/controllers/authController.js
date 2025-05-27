const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { server: serverConfig } = require('../config/config.json');

const JWT_SECRET = serverConfig.jwtSecret;

async function register(req, res) {
    const { nickname, password } = req.body;
    if (!nickname || !password) {
        return res.status(400).json({ error: 'Enter nickname and password' });
    }

    try {
        const [exists] = await db.query(
            'SELECT user_id FROM users WHERE nickname = ?',
            [nickname]
        );
        if (exists.length) {
            return res
                .status(400)
                .json({ error: 'This nickname is already taken' });
        }

        const hash = await bcrypt.hash(password, 12);
        const [result] = await db.query(
            'INSERT INTO users (nickname, password_hash) VALUES (?, ?)',
            [nickname, hash]
        );
        const userId = result.insertId;

        const [[{ avatar_url }]] = await db.query(
            'SELECT avatar_url FROM users WHERE user_id = ?',
            [userId]
        );

        const token = jwt.sign({ userId, nickname }, JWT_SECRET, {
            expiresIn: '24h',
        });

        res.json({
            message: 'Пользователь зарегистрирован',
            token,
            user: { userId, nickname, avatar_url },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error during registration' });
    }
}

async function login(req, res) {
    const { nickname, password } = req.body;
    if (!nickname || !password) {
        return res.status(400).json({ error: 'Enter nickname and password' });
    }

    try {
        const [rows] = await db.query(
            'SELECT user_id, password_hash, avatar_url FROM users WHERE nickname = ?',
            [nickname]
        );
        if (!rows.length) {
            return res.status(400).json({ error: 'Invalid login' });
        }
        const user = rows[0];

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
            return res.status(400).json({ error: 'Invalid password' });
        }

        const token = jwt.sign({ userId: user.user_id, nickname }, JWT_SECRET, {
            expiresIn: '24h',
        });

        res.json({
            message: 'Успешный вход',
            token,
            user: {
                userId: user.user_id,
                nickname,
                avatar_url: user.avatar_url,
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error when logging in' });
    }
}

module.exports = { register, login };
