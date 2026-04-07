const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const usersFile = path.join(__dirname, 'users.json');

// Инициализация файла, если его нет
if (!fs.existsSync(usersFile)) {
  fs.writeFileSync(usersFile, JSON.stringify({ users: [] }, null, 2));
}

function readUsers() {
  const data = fs.readFileSync(usersFile, 'utf8');
  return JSON.parse(data).users;
}

function writeUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify({ users }, null, 2));
}

// Простое хеширование пароля (для демонстрации, лучше использовать bcrypt, но это работает без модулей)
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Получить пользователя по имени
function getUserByUsername(username) {
  const users = readUsers();
  return users.find(u => u.username === username);
}

// Создать пользователя
function createUser(username, password, callback) {
  const users = readUsers();
  if (users.find(u => u.username === username)) {
    return callback(new Error('USER_EXISTS'));
  }
  const newUser = {
    id: Date.now(),
    username,
    password_hash: hashPassword(password),
    last_seen: Date.now()
  };
  users.push(newUser);
  writeUsers(users);
  callback(null, newUser);
}

// Аутентификация
function authenticateUser(username, password, callback) {
  const user = getUserByUsername(username);
  if (!user) return callback(null, false);
  if (user.password_hash === hashPassword(password)) {
    user.last_seen = Date.now();
    // обновим время в файле
    const users = readUsers();
    const index = users.findIndex(u => u.id === user.id);
    if (index !== -1) {
      users[index].last_seen = Date.now();
      writeUsers(users);
    }
    callback(null, user);
  } else {
    callback(null, false);
  }
}

function updateLastSeen(userId) {
  const users = readUsers();
  const user = users.find(u => u.id === userId);
  if (user) {
    user.last_seen = Date.now();
    writeUsers(users);
  }
}

function isSessionValid(lastSeen) {
  const twoDays = 2 * 24 * 60 * 60 * 1000;
  return (Date.now() - lastSeen) < twoDays;
}

module.exports = {
  getUserByUsername,
  createUser,
  authenticateUser,
  updateLastSeen,
  isSessionValid
};