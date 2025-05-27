CREATE DATABASE IF NOT EXISTS marvel_cards
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'norbarg'@'localhost'
  IDENTIFIED BY 'securepass';

GRANT ALL PRIVILEGES ON marvel_cards.* TO 'norbarg'@'localhost';

FLUSH PRIVILEGES;

USE marvel_cards;

CREATE TABLE IF NOT EXISTS users (
  user_id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nickname      VARCHAR(32)       NOT NULL UNIQUE,
  password_hash VARCHAR(60)       NOT NULL,
 avatar_url    VARCHAR(255)      NOT NULL
    DEFAULT '/assets/icons/dr strange icon.png'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cards (
  card_id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100)    NOT NULL UNIQUE,
  attack      INT             NOT NULL,
  defense     INT             NOT NULL,
  cost        INT             NOT NULL,
  image_url   VARCHAR(255)    DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  session_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player1_id INT UNSIGNED NOT NULL,
  player2_id INT UNSIGNED NOT NULL,
  status     ENUM('lobby','draft','battle','finished') NOT NULL,
  FOREIGN KEY (player1_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (player2_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS deck_cards (
  session_id INT UNSIGNED NOT NULL,
  player_id  INT UNSIGNED NOT NULL,
  card_id    INT UNSIGNED NOT NULL,
  pick_order TINYINT       NOT NULL,
  PRIMARY KEY (session_id, player_id, pick_order),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (player_id)  REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (card_id)    REFERENCES cards(card_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
