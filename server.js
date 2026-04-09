const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

const PORT = 3269;
const SIZE = 93;            // 93×93 клетки → холст 1023×1023
const COOLDOWN = 20000;     // 20 секунд

// ========== БАЗА ДАННЫХ ==========
const db = new sqlite3.Database('./pixelbattle.db');
db.serialize(() => {
    // Пользователи
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password_hash TEXT,
        last_seen INTEGER,
        avatar_data TEXT DEFAULT '',
        bio TEXT DEFAULT ''
    )`);
    // Кланы
    db.run(`CREATE TABLE IF NOT EXISTS clans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        color TEXT,
        owner_id INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS clan_members (
        user_id INTEGER,
        clan_id INTEGER,
        role TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS clan_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        clan_id INTEGER,
        status TEXT,
        created_at INTEGER
    )`);
    // Личные сообщения
    db.run(`CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER,
        to_user_id INTEGER,
        message TEXT,
        timestamp INTEGER,
        is_read INTEGER DEFAULT 0
    )`);
    // Пиксели (сохранение холста)
    db.run(`CREATE TABLE IF NOT EXISTS pixels (
        x INTEGER,
        y INTEGER,
        color TEXT,
        owner_id INTEGER,
        owner_username TEXT,
        owner_avatar TEXT,
        PRIMARY KEY (x, y)
    )`);
    // Добавление колонок, если их нет (для совместимости)
    db.run(`ALTER TABLE users ADD COLUMN avatar_data TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`, () => {});
});

// Инициализация холста из БД
let grid = Array(SIZE).fill().map(() => Array(SIZE).fill('#FFFFFF'));
let pixelOwners = Array(SIZE).fill().map(() => Array(SIZE).fill(null));

// Загружаем сохранённые пиксели из БД
db.all(`SELECT * FROM pixels`, (err, rows) => {
    if (err) {
        console.error('Ошибка загрузки пикселей:', err);
        return;
    }
    rows.forEach(row => {
        if (row.x >= 0 && row.x < SIZE && row.y >= 0 && row.y < SIZE) {
            grid[row.x][row.y] = row.color;
            pixelOwners[row.x][row.y] = {
                userId: row.owner_id,
                username: row.owner_username,
                avatarData: row.owner_avatar || ''
            };
        }
    });
    console.log(`Загружено ${rows.length} пикселей из БД.`);
});

let onlineUsers = new Map();
let onlineCount = 0;

function isSessionValid(lastSeen) {
    return (Date.now() - lastSeen) < 2 * 24 * 60 * 60 * 1000;
}

function savePrivateMessage(fromUserId, toUserId, message) {
    db.run(`INSERT INTO private_messages (from_user_id, to_user_id, message, timestamp) VALUES (?, ?, ?, ?)`,
        [fromUserId, toUserId, message, Date.now()]);
}

function getUnreadMessages(userId, callback) {
    db.all(`SELECT pm.*, u.username as from_username, u.avatar_data as from_avatar 
            FROM private_messages pm
            JOIN users u ON pm.from_user_id = u.id
            WHERE pm.to_user_id = ? AND pm.is_read = 0
            ORDER BY pm.timestamp ASC`, [userId], (err, rows) => {
        if (err) callback([]);
        else callback(rows);
    });
}

// ========== API ==========
app.get('/', (req, res) => {
    const userId = req.cookies.userId;
    if (!userId) return res.redirect('/login');
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user || !isSessionValid(user.last_seen)) {
            res.clearCookie('userId');
            return res.redirect('/login');
        }
        db.run('UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), userId]);
        res.send(generateGameHTML());
    });
});

app.get('/login', (req, res) => {
    res.send(generateLoginHTML());
});

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
    db.get('SELECT id FROM users WHERE username = ?', [username], (err, existing) => {
        if (existing) return res.status(400).json({ error: 'Никнейм уже занят' });
        const hash = bcrypt.hashSync(password, 10);
        db.run('INSERT INTO users (username, password_hash, last_seen, avatar_data, bio) VALUES (?, ?, ?, ?, ?)',
            [username, hash, Date.now(), '', ''], (err) => {
                if (err) return res.status(500).json({ error: 'Ошибка БД' });
                res.json({ success: true });
            });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Неверный логин' });
        if (!bcrypt.compareSync(password, user.password_hash))
            return res.status(401).json({ error: 'Неверный пароль' });
        db.run('UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), user.id]);
        res.cookie('userId', user.id, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ success: true });
    });
});

app.get('/api/profile/me', (req, res) => {
    const userId = req.cookies.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    db.get(`SELECT id, username, avatar_data, bio FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'Not found' });
        res.json(user);
    });
});

app.post('/api/profile', (req, res) => {
    const userId = req.cookies.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { avatar_data, bio } = req.body;
    db.run(`UPDATE users SET avatar_data = ?, bio = ? WHERE id = ?`, [avatar_data, bio, userId], (err) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ success: true });
    });
});

app.get('/api/allUsers', (req, res) => {
    const currentUserId = req.cookies.userId;
    if (!currentUserId) return res.status(401).json([]);
    db.all(`SELECT id, username, avatar_data FROM users WHERE id != ? ORDER BY username`, [currentUserId], (err, rows) => {
        if (err) return res.json([]);
        res.json(rows);
    });
});

app.get('/api/messages/:userId', (req, res) => {
    const currentUserId = req.cookies.userId;
    if (!currentUserId) return res.status(401).json({ error: 'Unauthorized' });
    const otherId = parseInt(req.params.userId);
    db.all(`SELECT pm.*, u.username as from_username, u2.username as to_username
            FROM private_messages pm
            JOIN users u ON pm.from_user_id = u.id
            JOIN users u2 ON pm.to_user_id = u2.id
            WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
            ORDER BY pm.timestamp ASC`, 
            [currentUserId, otherId, otherId, currentUserId], (err, rows) => {
        if (err) return res.json([]);
        db.run(`UPDATE private_messages SET is_read = 1 WHERE from_user_id = ? AND to_user_id = ?`, [otherId, currentUserId]);
        res.json(rows);
    });
});

// ========== SOCKET.IO ==========
io.use((socket, next) => {
    const cookie = socket.handshake.headers.cookie;
    const match = cookie && cookie.match(/userId=([^;]+)/);
    if (!match) return next(new Error('Not authenticated'));
    const userId = parseInt(match[1]);
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user || !isSessionValid(user.last_seen)) return next(new Error('Session expired'));
        socket.userId = userId;
        socket.username = user.username;
        socket.avatarData = user.avatar_data || '';
        next();
    });
});

io.on('connection', (socket) => {
    onlineUsers.set(socket.userId, socket.id);
    onlineCount++;
    io.emit('updateOnline', onlineCount);
    
    const ownersForClient = pixelOwners.map(row => row.map(cell => cell ? { username: cell.username, userId: cell.userId, avatarData: cell.avatarData } : null));
    socket.emit('initGrid', { grid, pixelOwners: ownersForClient });

    getUnreadMessages(socket.userId, (messages) => {
        messages.forEach(msg => {
            socket.emit('privateMessage', { from: msg.from_username, fromAvatar: msg.from_avatar, message: msg.message, timestamp: msg.timestamp });
        });
    });

    db.get(`SELECT clan_id, role FROM clan_members WHERE user_id = ?`, [socket.userId], (err, membership) => {
        if (membership) {
            db.get('SELECT * FROM clans WHERE id = ?', [membership.clan_id], (err, clan) => {
                if (clan) socket.emit('myClan', { id: clan.id, name: clan.name, color: clan.color, role: membership.role });
            });
        } else {
            socket.emit('myClan', null);
        }
    });

    function sendClansList() {
        db.all(`SELECT c.id, c.name, c.color, c.owner_id, COUNT(cm.user_id) as members_count
                FROM clans c LEFT JOIN clan_members cm ON c.id = cm.clan_id GROUP BY c.id`, (err, clans) => {
            io.emit('clansList', clans || []);
        });
    }
    sendClansList();

    socket.on('pixel', (data) => {
        const now = Date.now();
        if (socket.lastPixel && (now - socket.lastPixel) < COOLDOWN) {
            const remain = Math.ceil((COOLDOWN - (now - socket.lastPixel)) / 1000);
            socket.emit('cooldown', remain);
            return;
        }
        const { x, y, color } = data;
        if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) {
            grid[x][y] = color;
            const ownerInfo = { userId: socket.userId, username: socket.username, avatarData: socket.avatarData };
            pixelOwners[x][y] = ownerInfo;
            socket.lastPixel = now;
            
            // Сохраняем пиксель в БД (перезаписываем, если уже был)
            db.run(`INSERT OR REPLACE INTO pixels (x, y, color, owner_id, owner_username, owner_avatar) VALUES (?, ?, ?, ?, ?, ?)`,
                [x, y, color, socket.userId, socket.username, socket.avatarData],
                (err) => { if (err) console.error('Ошибка сохранения пикселя:', err); }
            );
            
            io.emit('pixel', { x, y, color, owner: ownerInfo });
        }
    });

    socket.on('privateMessage', ({ toUsername, message }) => {
        if (!message || message.trim() === '') return;
        db.get('SELECT id, avatar_data FROM users WHERE username = ?', [toUsername], (err, toUser) => {
            if (err || !toUser) return socket.emit('error', 'Пользователь не найден');
            savePrivateMessage(socket.userId, toUser.id, message);
            const recipientSocketId = onlineUsers.get(toUser.id);
            const messageData = { from: socket.username, fromAvatar: socket.avatarData, message: message.slice(0, 200), timestamp: Date.now() };
            if (recipientSocketId) io.to(recipientSocketId).emit('privateMessage', messageData);
            socket.emit('privateMessageSent', { to: toUsername, message: messageData.message });
        });
    });

    socket.on('createClan', ({ name, color }) => {
        if (!name || name.length < 2) return socket.emit('error', 'Название слишком короткое');
        db.get(`SELECT * FROM clan_members WHERE user_id = ?`, [socket.userId], (err, existing) => {
            if (existing) return socket.emit('error', 'Вы уже в клане');
            db.run(`INSERT INTO clans (name, color, owner_id) VALUES (?, ?, ?)`, [name, color, socket.userId], function(err) {
                if (err) return socket.emit('error', 'Клан с таким именем существует');
                const clanId = this.lastID;
                db.run(`INSERT INTO clan_members (user_id, clan_id, role) VALUES (?, ?, 'owner')`, [socket.userId, clanId]);
                sendClansList();
                socket.emit('myClan', { id: clanId, name, color, role: 'owner' });
                socket.emit('message', 'Клан создан');
            });
        });
    });

    socket.on('joinClanRequest', (clanId) => {
        db.get(`SELECT * FROM clan_members WHERE user_id = ?`, [socket.userId], (err, member) => {
            if (member) return socket.emit('error', 'Вы уже в клане');
            db.get(`SELECT owner_id, name FROM clans WHERE id = ?`, [clanId], (err, clan) => {
                if (!clan) return socket.emit('error', 'Клан не найден');
                db.run(`INSERT INTO clan_requests (user_id, clan_id, status, created_at) VALUES (?, ?, 'pending', ?)`, [socket.userId, clanId, Date.now()]);
                const ownerSocketId = onlineUsers.get(clan.owner_id);
                if (ownerSocketId) {
                    io.to(ownerSocketId).emit('clanRequest', { fromUserId: socket.userId, fromUsername: socket.username, clanId, clanName: clan.name });
                }
                socket.emit('message', 'Заявка отправлена');
            });
        });
    });

    socket.on('approveRequest', ({ userIdToAdd, clanId }) => {
        db.get(`SELECT owner_id FROM clans WHERE id = ?`, [clanId], (err, clan) => {
            if (!clan || clan.owner_id !== socket.userId) return socket.emit('error', 'Недостаточно прав');
            db.run(`INSERT OR IGNORE INTO clan_members (user_id, clan_id, role) VALUES (?, ?, 'member')`, [userIdToAdd, clanId]);
            sendClansList();
            const userSocketId = onlineUsers.get(userIdToAdd);
            if (userSocketId) {
                db.get(`SELECT name, color FROM clans WHERE id = ?`, [clanId], (err, clanInfo) => {
                    io.to(userSocketId).emit('clanJoined', clanInfo);
                });
            }
        });
    });

    socket.on('leaveClan', () => {
        db.run(`DELETE FROM clan_members WHERE user_id = ?`, [socket.userId], () => {
            sendClansList();
            socket.emit('myClan', null);
        });
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.userId);
        onlineCount--;
        io.emit('updateOnline', onlineCount);
    });
});

// ========== ГЕНЕРАЦИЯ HTML (без изменений) ==========
const clientScript = `
    const canvas = document.getElementById('pixelCanvas');
    const ctx = canvas.getContext('2d');
    const SIZE = ${SIZE};
    const CELL_SIZE = 11;   // 1023 / 93 = 11
    let grid = Array(SIZE).fill().map(() => Array(SIZE).fill('#FFFFFF'));
    let pixelOwners = Array(SIZE).fill().map(() => Array(SIZE).fill(null));
    let selectedColor = '#FF0055';
    let socket = io();
    let currentDMUser = null;
    let scale = 1;
    let translateX = 0, translateY = 0;
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    const wrapper = document.getElementById('canvasWrapper');

    // Палитра 200+ цветов
    const allColors = (() => {
        const base = ['#FF0000','#00FF00','#0000FF','#FFFF00','#FF00FF','#00FFFF','#FFA500','#FFFFFF','#000000','#888888','#800080','#008080','#FF6347','#40E0D0','#EE82EE','#F5DEB3','#7CFC00','#DC143C','#00CED1','#8A2BE2'];
        const colors = [...base];
        for(let h=0; h<360; h+=12) {
            for(let s=30; s<=100; s+=35) {
                for(let l=35; l<=75; l+=20) {
                    colors.push("hsl("+h+","+s+"%,"+l+"%)");
                }
            }
        }
        for(let g=10; g<=240; g+=15) colors.push("rgb("+g+","+g+","+g+")");
        return [...new Set(colors)];
    })();

    function buildColorPaletteUI() {
        const gridDiv = document.getElementById('colorPaletteGrid');
        gridDiv.innerHTML = '';
        allColors.forEach(c => {
            const swatch = document.createElement('div');
            swatch.className = 'palette-swatch';
            swatch.style.backgroundColor = c;
            swatch.onclick = (e) => {
                e.stopPropagation();
                selectedColor = c;
                document.getElementById('selectedColorBtn').style.backgroundColor = c;
                document.querySelectorAll('.palette-swatch').forEach(el => el.classList.remove('active'));
                swatch.classList.add('active');
                closePalette();
            };
            gridDiv.appendChild(swatch);
        });
        document.getElementById('selectedColorBtn').style.backgroundColor = selectedColor;
    }

    function closePalette() {
        document.getElementById('palettePopup').classList.remove('show');
    }

    document.getElementById('selectedColorBtn').onclick = (e) => {
        e.stopPropagation();
        const popup = document.getElementById('palettePopup');
        // Позиционируем попап прямо над кнопкой
        const btnRect = e.target.getBoundingClientRect();
        popup.style.left = btnRect.left + 'px';
        popup.style.top = (btnRect.top - popup.offsetHeight - 8) + 'px';
        popup.classList.toggle('show');
    };
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#palettePopup') && !e.target.closest('#selectedColorBtn')) {
            closePalette();
        }
    });
    window.addEventListener('resize', closePalette);

    function drawGridFull() {
        for(let i=0; i<SIZE; i++) {
            for(let j=0; j<SIZE; j++) {
                ctx.fillStyle = grid[i][j];
                ctx.fillRect(j*CELL_SIZE, i*CELL_SIZE, CELL_SIZE, CELL_SIZE);
            }
        }
        applyTransform();
    }

    function applyTransform() {
        wrapper.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')';
        document.getElementById('zoomLevel').innerText = Math.round(scale * 100) + '%';
    }

    function screenToCell(clientX, clientY) {
        const canvasRect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / canvasRect.width;
        const scaleY = canvas.height / canvasRect.height;
        const canvasX = (clientX - canvasRect.left) * scaleX;
        const canvasY = (clientY - canvasRect.top) * scaleY;
        const cellX = Math.floor(canvasY / CELL_SIZE);
        const cellY = Math.floor(canvasX / CELL_SIZE);
        if(cellX >=0 && cellX<SIZE && cellY>=0 && cellY<SIZE) return {x: cellX, y: cellY};
        return null;
    }

    function handleWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const oldScale = scale;
        let newScale = scale * delta;
        newScale = Math.min(8, Math.max(0.5, newScale));
        if(newScale === scale) return;
        const rect = wrapper.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const newX = mouseX - (mouseX - translateX) * (newScale / oldScale);
        const newY = mouseY - (mouseY - translateY) * (newScale / oldScale);
        translateX = newX;
        translateY = newY;
        scale = newScale;
        applyTransform();
    }

    function onMouseDown(e) {
        isDragging = true;
        dragStart.x = e.clientX - translateX;
        dragStart.y = e.clientY - translateY;
        wrapper.style.cursor = 'grabbing';
        e.preventDefault();
    }
    function onMouseMove(e) {
        if(!isDragging) return;
        translateX = e.clientX - dragStart.x;
        translateY = e.clientY - dragStart.y;
        applyTransform();
    }
    function onMouseUp() {
        isDragging = false;
        wrapper.style.cursor = 'grab';
    }

    function onCanvasClick(e) {
        const cell = screenToCell(e.clientX, e.clientY);
        if(cell) socket.emit('pixel', { x: cell.x, y: cell.y, color: selectedColor });
    }

    let tooltipDiv = null;
    function onCanvasMouseMove(e) {
        const cell = screenToCell(e.clientX, e.clientY);
        if(cell) {
            const owner = pixelOwners[cell.x]?.[cell.y];
            if(owner && owner.username) {
                if(!tooltipDiv) {
                    tooltipDiv = document.createElement('div');
                    tooltipDiv.className = 'pixel-tooltip';
                    document.body.appendChild(tooltipDiv);
                }
                tooltipDiv.innerHTML = '<div class="tooltip-avatar" style="background-image:url(\\'' + (owner.avatarData||'') + '\\')"></div>' +
                                        '<div class="tooltip-info"><strong>' + escapeHtml(owner.username) + '</strong><br>(' + cell.x + ',' + cell.y + ')</div>' +
                                        '<button class="tooltip-write" data-username="' + escapeHtml(owner.username) + '">💬</button>';
                tooltipDiv.style.left = (e.clientX + 20) + 'px';
                tooltipDiv.style.top = (e.clientY - 40) + 'px';
                tooltipDiv.style.display = 'flex';
                tooltipDiv.querySelector('.tooltip-write').onclick = (ev) => {
                    ev.stopPropagation();
                    setDMUser(ev.target.dataset.username);
                    showTab('chat');
                };
                return;
            }
        }
        if(tooltipDiv) tooltipDiv.style.display = 'none';
    }

    function escapeHtml(s) { return s.replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[m]); }

    socket.on('initGrid', (data) => { grid = data.grid; pixelOwners = data.pixelOwners; drawGridFull(); });
    socket.on('pixel', (data) => { grid[data.x][data.y] = data.color; pixelOwners[data.x][data.y] = data.owner; drawGridFull(); });
    socket.on('updateOnline', (count) => { document.getElementById('onlineCount').innerText = count; });
    socket.on('cooldown', (sec) => {
        let remaining = sec;
        const fillDiv = document.getElementById('cooldownFill');
        const textSpan = document.getElementById('cooldownText');
        const interval = setInterval(() => {
            if(remaining <= 0) { textSpan.innerText = '✅'; fillDiv.style.width = '0%'; clearInterval(interval); }
            else { textSpan.innerText = remaining + 'с'; fillDiv.style.width = ((sec-remaining)/sec*100) + '%'; remaining--; }
        }, 1000);
    });

    socket.on('privateMessage', (data) => { addChatMessage(data.from, data.message, false); });
    socket.on('privateMessageSent', (data) => { addChatMessage('Вы', data.message, true); });

    function addChatMessage(sender, text, isOwn) {
        const container = document.getElementById('chatMessages');
        const div = document.createElement('div');
        div.className = 'chat-message ' + (isOwn ? 'own' : '');
        div.innerHTML = '<span class="msg-sender">' + escapeHtml(sender) + '</span> ' + escapeHtml(text);
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    document.getElementById('sendMsgBtn').onclick = () => {
        const input = document.getElementById('chatInput');
        const msg = input.value.trim();
        if(!msg || !currentDMUser) return;
        socket.emit('privateMessage', { toUsername: currentDMUser, message: msg });
        addChatMessage('Вы', msg, true);
        input.value = '';
    };

    function setDMUser(username) {
        currentDMUser = username;
        document.getElementById('chatHeader').innerHTML = '💬 ' + (username || 'Выберите собеседника');
        if(username) loadMessages(username);
    }

    async function loadMessages(username) {
        const res = await fetch('/api/allUsers');
        const users = await res.json();
        const user = users.find(u => u.username === username);
        if(!user) return;
        const msgRes = await fetch('/api/messages/' + user.id);
        const msgs = await msgRes.json();
        const container = document.getElementById('chatMessages');
        container.innerHTML = '';
        const myUsername = (await (await fetch('/api/profile/me')).json()).username;
        msgs.forEach(m => addChatMessage(m.from_username, m.message, m.from_username === myUsername));
    }

    async function loadUsersList() {
        const res = await fetch('/api/allUsers');
        const users = await res.json();
        const container = document.getElementById('usersList');
        container.innerHTML = '';
        users.forEach(u => {
            const div = document.createElement('div');
            div.className = 'user-item';
            div.innerHTML = '<div class="user-avatar" style="background-image:url(' + (u.avatar_data||'') + ')"></div><span>' + escapeHtml(u.username) + '</span>';
            div.onclick = () => setDMUser(u.username);
            container.appendChild(div);
        });
    }

    socket.on('clansList', (clans) => {
        const container = document.getElementById('clansList');
        container.innerHTML = '';
        clans.forEach(c => {
            const div = document.createElement('div');
            div.className = 'clan-item';
            div.style.borderLeftColor = c.color;
            div.innerHTML = '<span>' + escapeHtml(c.name) + ' (' + c.members_count + ')</span><button>Вступить</button>';
            div.querySelector('button').onclick = () => socket.emit('joinClanRequest', c.id);
            container.appendChild(div);
        });
    });
    socket.on('myClan', (clan) => {
        const block = document.getElementById('myClanInfo');
        if(clan) block.innerHTML = '🏰 ' + escapeHtml(clan.name) + ' (' + clan.role + ')';
        else block.innerHTML = '🏰 Не в клане';
    });

    document.getElementById('createClanBtn').onclick = () => {
        const name = prompt('Название клана:');
        const color = prompt('Цвет (HEX):');
        if(name && color) socket.emit('createClan', { name, color });
    };
    document.getElementById('leaveClanBtn').onclick = () => { if(confirm('Покинуть клан?')) socket.emit('leaveClan'); };

    async function loadProfile() {
        const res = await fetch('/api/profile/me');
        const me = await res.json();
        document.getElementById('profileAvatar').src = me.avatar_data || 'https://via.placeholder.com/80';
        document.getElementById('avatarUrl').value = me.avatar_data || '';
        document.getElementById('profileBio').value = me.bio || '';
    }
    document.getElementById('saveProfileBtn').onclick = async () => {
        await fetch('/api/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ avatar_data: document.getElementById('avatarUrl').value, bio: document.getElementById('profileBio').value }) });
        alert('Сохранено');
    };
    document.getElementById('logoutBtn').onclick = () => { document.cookie = 'userId=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'; location.href='/login'; };

    function showTab(tabId) {
        document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
        document.getElementById(tabId).style.display = 'flex';
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.nav-btn[data-tab="' + tabId + '"]').classList.add('active');
        if(tabId === 'chat') { loadUsersList(); setDMUser(null); }
        if(tabId === 'profile') loadProfile();
    }
    document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => showTab(b.dataset.tab));

    document.getElementById('zoomIn').onclick = () => { scale = Math.min(8, scale*1.2); applyTransform(); };
    document.getElementById('zoomOut').onclick = () => { scale = Math.max(0.5, scale/1.2); applyTransform(); };
    document.getElementById('resetView').onclick = () => { scale=1; translateX=0; translateY=0; applyTransform(); };

    wrapper.addEventListener('wheel', handleWheel, { passive: false });
    wrapper.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    wrapper.style.cursor = 'grab';

    buildColorPaletteUI();
    drawGridFull();
    showTab('battle');
`;

function generateGameHTML() {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>PIXEL • Pixel Battle</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif;}
body{background:#f5f7fa;display:flex;height:100vh;overflow:hidden;}
/* САЙДБАР */
.sidebar{width:340px;background:#fff;display:flex;flex-direction:column;border-right:1px solid #e0e0e0;box-shadow:2px 0 12px rgba(0,0,0,0.02);}
.logo{padding:24px 20px;font-size:24px;font-weight:700;color:#1a1a1a;border-bottom:1px solid #eee;}
.nav{display:flex;padding:12px;gap:8px;}
.nav-btn{flex:1;padding:12px;background:#f5f5f5;border:none;border-radius:14px;font-weight:600;cursor:pointer;color:#444;transition:0.15s;}
.nav-btn.active{background:#1a1a1a;color:#fff;}
.content{flex:1;overflow-y:auto;padding:20px;}
.tab-pane{display:flex;flex-direction:column;gap:20px;}
/* ИНСТРУМЕНТЫ */
.toolbar{display:flex;align-items:center;gap:16px;margin-bottom:16px;position:relative;}
.color-btn{width:64px;height:64px;border-radius:18px;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,0.08);cursor:pointer;transition:0.1s;}
.color-btn:hover{transform:scale(1.02);}
.palette-popup{display:none;position:fixed;background:#fff;border-radius:24px;box-shadow:0 12px 30px rgba(0,0,0,0.12);padding:16px;z-index:200;width:320px;border:1px solid #eee;}
.palette-popup.show{display:block;}
.palette-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;max-height:280px;overflow-y:auto;}
.palette-swatch{aspect-ratio:1;border-radius:12px;cursor:pointer;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.05);transition:0.1s;}
.palette-swatch.active{border-color:#1a1a1a;box-shadow:0 0 0 2px #1a1a1a;}
.cooldown-bar{background:#e9ecef;height:10px;border-radius:10px;margin:12px 0;}
.cooldown-fill{height:100%;width:0;background:#1a1a1a;border-radius:10px;transition:width 0.2s;}
/* ЧАТ */
.chat-header{font-weight:700;margin-bottom:16px;font-size:1.1rem;}
.chat-messages{flex:1;background:#fafafa;border-radius:20px;padding:16px;overflow-y:auto;min-height:280px;max-height:400px;}
.chat-message{margin:8px 0;padding:10px 16px;background:#fff;border-radius:18px;max-width:85%;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,0.03);}
.chat-message.own{background:#1a1a1a;color:#fff;margin-left:auto;}
.msg-sender{font-weight:700;margin-right:8px;}
.chat-input-area{display:flex;gap:10px;margin-top:16px;}
.chat-input-area input{flex:1;padding:14px 16px;border:1px solid #ddd;border-radius:30px;font-size:0.95rem;}
.chat-input-area button{background:#1a1a1a;color:#fff;border:none;padding:0 24px;border-radius:30px;font-weight:600;cursor:pointer;}
/* ЮЗЕРЫ */
.user-item{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#fafafa;border-radius:16px;margin:6px 0;cursor:pointer;transition:0.1s;}
.user-item:hover{background:#f0f0f0;}
.user-avatar{width:40px;height:40px;border-radius:50%;background:#ddd;background-size:cover;}
/* КЛАНЫ */
.clan-item{display:flex;justify-content:space-between;align-items:center;padding:16px;background:#fafafa;border-radius:18px;margin:8px 0;border-left:6px solid;}
.clan-item button{background:#1a1a1a;color:#fff;border:none;padding:8px 16px;border-radius:30px;cursor:pointer;}
/* ПРОФИЛЬ */
.profile-avatar{width:100px;height:100px;border-radius:50%;object-fit:cover;margin:0 auto 20px;display:block;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,0.05);}
.profile-input{width:100%;padding:14px;border:1px solid #ddd;border-radius:30px;margin:10px 0;font-size:0.95rem;}
.profile-btn{width:100%;padding:14px;border:none;border-radius:30px;background:#1a1a1a;color:#fff;font-weight:600;margin:8px 0;cursor:pointer;}
.profile-btn.secondary{background:#f0f0f0;color:#1a1a1a;}
/* ХОЛСТ */
.canvas-area{flex:1;position:relative;background:#e9ecef;overflow:hidden;display:flex;align-items:center;justify-content:center;}
.canvas-wrapper{transform-origin:0 0;box-shadow:0 12px 30px rgba(0,0,0,0.15);border-radius:4px;}
canvas{display:block;image-rendering:crisp-edges;image-rendering:pixelated;border-radius:4px;}
.online-indicator{position:absolute;top:24px;left:24px;display:flex;align-items:center;gap:8px;background:#fff;padding:8px 18px;border-radius:60px;box-shadow:0 4px 12px rgba(0,0,0,0.05);}
.pulse{width:12px;height:12px;background:#2ecc71;border-radius:50%;animation:pulse 1.8s infinite;}
@keyframes pulse{0%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(1.15)}100%{opacity:1;transform:scale(1)}}
.zoom-controls{position:absolute;bottom:24px;right:24px;background:#fff;padding:8px 16px;border-radius:60px;box-shadow:0 4px 12px rgba(0,0,0,0.05);display:flex;gap:12px;}
.zoom-btn{background:none;border:none;font-size:22px;font-weight:600;cursor:pointer;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#1a1a1a;}
.zoom-btn:hover{background:#f0f0f0;}
/* ТУЛТИП */
.pixel-tooltip{position:fixed;background:#fff;border-radius:30px;padding:12px 18px;box-shadow:0 12px 28px rgba(0,0,0,0.12);display:flex;align-items:center;gap:14px;z-index:1000;border:1px solid #eee;}
.tooltip-avatar{width:42px;height:42px;border-radius:50%;background-size:cover;}
.tooltip-write{background:#1a1a1a;color:#fff;border:none;padding:8px 18px;border-radius:30px;font-weight:500;cursor:pointer;}
</style>
</head>
<body>
<div class="sidebar">
    <div class="logo">PIXEL BATTLE</div>
    <div class="nav">
        <button class="nav-btn active" data-tab="battle">🎨 Битва</button>
        <button class="nav-btn" data-tab="chat">💬 Чат</button>
        <button class="nav-btn" data-tab="clans">🏰 Кланы</button>
        <button class="nav-btn" data-tab="profile">👤 Профиль</button>
    </div>
    <div class="content">
        <div id="battle" class="tab-pane">
            <div class="toolbar">
                <div id="selectedColorBtn" class="color-btn"></div>
                <span style="color:#555;font-weight:500;">Выберите цвет</span>
            </div>
            <div id="palettePopup" class="palette-popup">
                <div id="colorPaletteGrid" class="palette-grid"></div>
            </div>
            <div class="cooldown-bar"><div id="cooldownFill" class="cooldown-fill"></div></div>
            <div id="cooldownText" style="text-align:center;font-weight:500;">✅ Готов</div>
            <div style="margin-top:12px;color:#777;font-size:0.85rem;">Колёсико — зум, зажать ЛКМ — двигать</div>
        </div>
        <div id="chat" class="tab-pane" style="display:none;">
            <div id="chatHeader" class="chat-header">💬 Выберите собеседника</div>
            <div id="chatMessages" class="chat-messages"></div>
            <div class="chat-input-area">
                <input type="text" id="chatInput" placeholder="Сообщение...">
                <button id="sendMsgBtn">➤</button>
            </div>
            <div style="margin-top:24px;"><strong>👥 Пользователи</strong></div>
            <div id="usersList" style="max-height:220px;overflow-y:auto;"></div>
        </div>
        <div id="clans" class="tab-pane" style="display:none;">
            <div id="myClanInfo" style="padding:16px;background:#fafafa;border-radius:18px;margin-bottom:16px;">🏰 Не в клане</div>
            <button id="createClanBtn" style="width:100%;padding:14px;border:none;border-radius:30px;background:#1a1a1a;color:#fff;font-weight:600;margin-bottom:10px;cursor:pointer;">➕ Создать клан</button>
            <button id="leaveClanBtn" style="width:100%;padding:14px;border:none;border-radius:30px;background:#f0f0f0;color:#1a1a1a;font-weight:600;cursor:pointer;">🚪 Покинуть клан</button>
            <div style="margin-top:24px;"><strong>🌍 Все кланы</strong></div>
            <div id="clansList"></div>
        </div>
        <div id="profile" class="tab-pane" style="display:none;">
            <img id="profileAvatar" class="profile-avatar" src="" alt="аватар">
            <input id="avatarUrl" class="profile-input" placeholder="Ссылка на аватар">
            <textarea id="profileBio" class="profile-input" rows="3" placeholder="О себе..."></textarea>
            <button id="saveProfileBtn" class="profile-btn">💾 Сохранить</button>
            <button id="logoutBtn" class="profile-btn secondary">🚪 Выйти</button>
        </div>
    </div>
</div>
<div class="canvas-area">
    <div class="online-indicator">
        <div class="pulse"></div>
        <span>Онлайн: <span id="onlineCount">0</span></span>
    </div>
    <div class="canvas-wrapper" id="canvasWrapper">
        <canvas id="pixelCanvas" width="1023" height="1023"></canvas>
    </div>
    <div class="zoom-controls">
        <button class="zoom-btn" id="zoomOut">−</button>
        <span id="zoomLevel" style="min-width:50px;text-align:center;">100%</span>
        <button class="zoom-btn" id="zoomIn">+</button>
        <button class="zoom-btn" id="resetView">⟲</button>
    </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>${clientScript}</script>
</body>
</html>`;
}

function generateLoginHTML() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>PIXEL • Вход</title>
<style>body{background:#f5f7fa;display:flex;justify-content:center;align-items:center;height:100vh;font-family:'Segoe UI',sans-serif;}.box{background:#fff;padding:40px;border-radius:40px;width:360px;box-shadow:0 20px 40px rgba(0,0,0,0.05);}input{width:100%;padding:16px;margin:12px 0;border:1px solid #ddd;border-radius:30px;font-size:1rem;}button{width:100%;padding:16px;border:none;border-radius:30px;background:#1a1a1a;color:#fff;font-weight:600;margin:10px 0;cursor:pointer;}.error{color:#e74c3c;margin-top:10px;}</style>
</head><body><div class="box"><h1 style="margin-bottom:20px;">PIXEL BATTLE</h1><div id="error" class="error"></div>
<input id="username" placeholder="Логин"><input id="password" type="password" placeholder="Пароль">
<button onclick="login()">Войти</button><button onclick="register()" style="background:#f0f0f0;color:#1a1a1a;">Регистрация</button></div>
<script>
async function login(){const u=username.value,p=password.value;const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const d=await r.json();if(d.success)location.href='/';else error.innerText=d.error;}
async function register(){const u=username.value,p=password.value;const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const d=await r.json();if(d.success)alert('Успешно! Теперь войдите.');else error.innerText=d.error;}
</script></body></html>`;
}

server.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║        PIXEL BATTLE v2.0 (SAVE)         ║`);
    console.log(`║        http://localhost:${PORT}           ║`);
    console.log(`║    Холст 1023x1023 | Сохранение в БД     ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
});
