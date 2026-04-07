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

const PORT = 3211;
const SIZE = 100;          // 100×100 пикселей
const COOLDOWN = 20000;    // 20 секунд

// ========== БАЗА ДАННЫХ ==========
const db = new sqlite3.Database('./pixelbattle.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password_hash TEXT,
        last_seen INTEGER,
        avatar_data TEXT DEFAULT '',
        bio TEXT DEFAULT ''
    )`);
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
    db.run(`CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER,
        to_user_id INTEGER,
        message TEXT,
        timestamp INTEGER,
        is_read INTEGER DEFAULT 0
    )`);
    db.run(`ALTER TABLE users ADD COLUMN avatar_data TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`, () => {});
});

let grid = Array(SIZE).fill().map(() => Array(SIZE).fill('#FFFFFF'));
let pixelOwners = Array(SIZE).fill().map(() => Array(SIZE).fill(null));
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
            pixelOwners[x][y] = { userId: socket.userId, username: socket.username, avatarData: socket.avatarData };
            socket.lastPixel = now;
            io.emit('pixel', { x, y, color, owner: { username: socket.username, userId: socket.userId, avatarData: socket.avatarData } });
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

// ========== ГЕНЕРАЦИЯ HTML (клиентский скрипт вынесен в строку) ==========
const clientScript = `
    const canvas = document.getElementById('pixelCanvas');
    const ctx = canvas.getContext('2d');
    const SIZE = ${SIZE};
    const CELL_SIZE = 10;
    let grid = Array(SIZE).fill().map(() => Array(SIZE).fill('#FFFFFF'));
    let pixelOwners = Array(SIZE).fill().map(() => Array(SIZE).fill(null));
    let selectedColor = '#FF0000';
    let socket = io();
    let currentDMUser = null;
    let scale = 1;
    let translateX = 0, translateY = 0;
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    const wrapper = document.getElementById('canvasWrapper');

    function generateMegaPalette() {
        const colors = [];
        const basic = ['#FF0000','#00FF00','#0000FF','#FFFF00','#FF00FF','#00FFFF','#FFA500','#FFFFFF','#000000','#888888','#800080','#008080','#FF6347','#40E0D0','#EE82EE','#F5DEB3','#7CFC00','#DC143C','#00CED1','#8A2BE2'];
        basic.forEach(c => colors.push(c));
        for(let h=0; h<360; h+=15) {
            for(let s=30; s<=100; s+=35) {
                for(let l=35; l<=75; l+=20) {
                    let col = "hsl("+h+","+s+"%,"+l+"%)";
                    if(!colors.includes(col)) colors.push(col);
                }
            }
        }
        for(let g=10; g<=240; g+=15) colors.push("rgb("+g+","+g+","+g+")");
        return colors;
    }
    const allColors = generateMegaPalette();

    function buildColorPaletteUI() {
        const container = document.getElementById('colorPaletteGrid');
        container.innerHTML = '';
        allColors.forEach(c => {
            const swatch = document.createElement('div');
            swatch.className = 'palette-swatch';
            swatch.style.backgroundColor = c;
            swatch.onclick = () => {
                selectedColor = c;
                document.querySelectorAll('.palette-swatch').forEach(el => el.classList.remove('active'));
                swatch.classList.add('active');
            };
            if(c === selectedColor) swatch.classList.add('active');
            container.appendChild(swatch);
        });
    }

    function drawGridFull() {
        for(let i=0; i<SIZE; i++) {
            for(let j=0; j<SIZE; j++) {
                ctx.fillStyle = grid[i][j];
                ctx.fillRect(j*CELL_SIZE, i*CELL_SIZE, CELL_SIZE, CELL_SIZE);
                ctx.strokeStyle = '#1a1a2e';
                ctx.strokeRect(j*CELL_SIZE, i*CELL_SIZE, CELL_SIZE, CELL_SIZE);
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
        if(cell) {
            socket.emit('pixel', { x: cell.x, y: cell.y, color: selectedColor });
        }
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
                tooltipDiv.innerHTML = '<div style=\"width:28px;height:28px;border-radius:50%;background:url(\\'' + (owner.avatarData||'') + '\\') center/cover;\"></div>' +
                                        '<div><strong>' + escapeHtml(owner.username) + '</strong><br>(' + cell.x + ',' + cell.y + ')</div>' +
                                        '<button class=\"writeBtn\" data-username=\"' + escapeHtml(owner.username) + '\" style=\"background:#ff3300;border:none;border-radius:20px;padding:2px 8px;\">💬</button>';
                tooltipDiv.style.position = 'fixed';
                tooltipDiv.style.left = (e.clientX + 15) + 'px';
                tooltipDiv.style.top = (e.clientY - 40) + 'px';
                tooltipDiv.style.background = '#1e1a2f';
                tooltipDiv.style.padding = '8px';
                tooltipDiv.style.borderRadius = '20px';
                tooltipDiv.style.borderLeft = '4px solid #ff3300';
                tooltipDiv.style.display = 'flex';
                tooltipDiv.style.gap = '8px';
                tooltipDiv.style.zIndex = 9999;
                const btn = tooltipDiv.querySelector('.writeBtn');
                btn.onclick = (ev) => {
                    ev.stopPropagation();
                    const username = btn.getAttribute('data-username');
                    setDMUser(username);
                    showTab('chat');
                };
                return;
            }
        }
        if(tooltipDiv) tooltipDiv.style.display = 'none';
    }

    function escapeHtml(str) { return str.replace(/[&<>]/g, function(m){if(m==='&')return '&amp;';if(m==='<')return '&lt;';return '&gt;';}); }

    socket.on('initGrid', (data) => {
        grid = data.grid;
        pixelOwners = data.pixelOwners;
        drawGridFull();
    });
    socket.on('pixel', (data) => {
        grid[data.x][data.y] = data.color;
        pixelOwners[data.x][data.y] = data.owner;
        drawGridFull();
    });
    socket.on('updateOnline', (count) => { document.getElementById('onlineCount').innerText = count; });
    socket.on('cooldown', (sec) => {
        let remaining = sec;
        const fillDiv = document.getElementById('cooldownFill');
        const textSpan = document.getElementById('cooldownText');
        const interval = setInterval(() => {
            if(remaining <= 0) {
                textSpan.innerText = '✅ ГОТОВ';
                fillDiv.style.width = '0%';
                clearInterval(interval);
            } else {
                textSpan.innerText = '⏳ ' + remaining + ' сек';
                fillDiv.style.width = ((sec-remaining)/sec*100) + '%';
                remaining--;
            }
        }, 1000);
    });

    socket.on('privateMessage', (data) => {
        addChatMessage('💬 [ЛС] ' + data.from + ': ' + data.message);
    });
    socket.on('privateMessageSent', (data) => {
        addChatMessage('✉️ Вы -> ' + data.to + ': ' + data.message, true);
    });

    function addChatMessage(text, isOwn=false) {
        const container = document.getElementById('chatMessagesList');
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message-item';
        msgDiv.style.color = isOwn ? '#ffaa66' : '#ccc';
        msgDiv.innerText = text;
        container.appendChild(msgDiv);
        container.scrollTop = container.scrollHeight;
    }

    document.getElementById('chatInput').addEventListener('keypress', (e) => {
        if(e.key === 'Enter') {
            const msg = e.target.value.trim();
            if(!msg) return;
            if(currentDMUser) {
                socket.emit('privateMessage', { toUsername: currentDMUser, message: msg });
                addChatMessage('✉️ Вы -> ' + currentDMUser + ': ' + msg, true);
            } else {
                addChatMessage('💬 Вы: ' + msg, true);
            }
            e.target.value = '';
        }
    });

    function setDMUser(username) {
        currentDMUser = username;
        document.getElementById('dmTargetDisplay').innerHTML = currentDMUser ? '💬 ЛС с ' + currentDMUser + ' <span style=\"color:#ff3300;cursor:pointer;\" onclick=\"setDMUser(null)\">[X]</span>' : '⚡ Личный чат ни с кем';
    }

    async function loadUsersList() {
        const res = await fetch('/api/allUsers');
        const users = await res.json();
        const container = document.getElementById('usersListContainer');
        container.innerHTML = '';
        users.forEach(u => {
            const div = document.createElement('div');
            div.className = 'user-item';
            div.innerHTML = '<div class=\"avatar-mini\" style=\"background-image:url(\\'' + (u.avatar_data||'') + '\\'); background-size:cover;\"></div>' + escapeHtml(u.username);
            div.onclick = () => { setDMUser(u.username); addChatMessage('💬 Начат приват с ' + u.username, false, true); showTab('chat'); };
            container.appendChild(div);
        });
    }

    socket.on('clansList', (clans) => {
        const container = document.getElementById('allClansList');
        if(!clans.length) { container.innerHTML = 'Нет кланов'; return; }
        container.innerHTML = '';
        clans.forEach(c => {
            const btn = document.createElement('button');
            btn.style.background = c.color;
            btn.style.margin = '5px';
            btn.innerText = c.name + ' (' + c.members_count + ')';
            btn.onclick = () => socket.emit('joinClanRequest', c.id);
            container.appendChild(btn);
        });
    });
    socket.on('myClan', (clan) => {
        const block = document.getElementById('myClanBlock');
        if(clan) block.innerHTML = '🏰 Ваш клан: <span style=\"color:' + clan.color + '\">' + clan.name + '</span> (' + clan.role + ')';
        else block.innerHTML = '🏰 Вы не в клане';
    });
    document.getElementById('createClanButton').onclick = () => {
        const name = prompt('Название клана:');
        const color = prompt('Цвет HEX:');
        if(name && color) socket.emit('createClan', { name, color });
    };
    document.getElementById('leaveClanButton').onclick = () => { if(confirm('Покинуть клан?')) socket.emit('leaveClan'); };

    async function loadMyProfile() {
        const res = await fetch('/api/profile/me');
        const me = await res.json();
        document.getElementById('profileAvatar').src = me.avatar_data || 'https://via.placeholder.com/80';
        document.getElementById('avatarUrlInput').value = me.avatar_data || '';
        document.getElementById('profileBioInput').value = me.bio || '';
    }
    document.getElementById('saveProfileButton').onclick = async () => {
        const avatar_data = document.getElementById('avatarUrlInput').value;
        const bio = document.getElementById('profileBioInput').value;
        await fetch('/api/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ avatar_data, bio }) });
        alert('Сохранено');
        loadMyProfile();
    };
    document.getElementById('logoutButton').onclick = () => { document.cookie = 'userId=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'; location.href='/login'; };

    function showTab(tabName) {
        document.querySelectorAll('.tab-pane').forEach(pane => pane.style.display = 'none');
        document.getElementById(tabName + 'Tab').style.display = 'flex';
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelector('.tab-btn[data-tab=\"' + tabName + '\"]').classList.add('active');
        if(tabName === 'chat') loadUsersList();
        if(tabName === 'profile') loadMyProfile();
    }
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => showTab(btn.getAttribute('data-tab'));
    });

    document.getElementById('zoomInBtn').onclick = () => {
        scale = Math.min(8, scale * 1.2);
        applyTransform();
    };
    document.getElementById('zoomOutBtn').onclick = () => {
        scale = Math.max(0.5, scale / 1.2);
        applyTransform();
    };
    document.getElementById('resetViewBtn').onclick = () => {
        scale = 1;
        translateX = 0;
        translateY = 0;
        applyTransform();
    };

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
    setInterval(() => { if(document.querySelector('.tab-btn.active').getAttribute('data-tab') === 'chat') loadUsersList(); }, 10000);
`;

function generateGameHTML() {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>PIXEL BATTLE — HARDCORE EDITION</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            user-select: none;
        }
        body {
            background: radial-gradient(circle at 20% 30%, #0a050f, #000000);
            font-family: 'Segoe UI', 'Orbitron', 'Impact', system-ui;
            color: #eee;
            overflow: hidden;
            height: 100vh;
            width: 100vw;
        }
        .app {
            display: flex;
            height: 100%;
            width: 100%;
        }
        .canvas-area {
            flex: 1;
            position: relative;
            background: #00000066;
            backdrop-filter: blur(4px);
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: hidden;
            border-right: 3px solid #ff3300;
            box-shadow: 0 0 20px rgba(255, 51, 0, 0.3);
        }
        .canvas-wrapper {
            position: relative;
            cursor: grab;
            transform-origin: 0 0;
        }
        .canvas-wrapper:active {
            cursor: grabbing;
        }
        canvas {
            display: block;
            box-shadow: 0 0 40px rgba(255, 68, 0, 0.5);
            border-radius: 0px;
            image-rendering: crisp-edges;
            image-rendering: pixelated;
        }
        .zoom-controls {
            position: absolute;
            bottom: 20px;
            right: 20px;
            background: #1e1a2fcc;
            backdrop-filter: blur(8px);
            padding: 8px 12px;
            border-radius: 40px;
            display: flex;
            gap: 12px;
            z-index: 50;
            border: 1px solid #ff4400;
        }
        .zoom-btn {
            background: #ff3300;
            border: none;
            font-size: 20px;
            font-weight: bold;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            color: white;
            cursor: pointer;
            transition: 0.1s linear;
        }
        .zoom-btn:hover {
            background: #ff6600;
            transform: scale(1.05);
        }
        .right-panel {
            width: 360px;
            background: rgba(10, 5, 20, 0.9);
            backdrop-filter: blur(16px);
            display: flex;
            flex-direction: column;
            border-left: 2px solid #ff3300;
            box-shadow: -10px 0 30px rgba(0,0,0,0.8);
        }
        .panel-header {
            background: #ff3300;
            padding: 12px;
            text-align: center;
            font-weight: 900;
            font-size: 1.3rem;
            letter-spacing: 2px;
            text-shadow: 0 0 5px black;
            clip-path: polygon(0 0, 100% 0, 96% 100%, 4% 100%);
        }
        .tab-strip {
            display: flex;
            background: #1a1124;
            border-bottom: 2px solid #ff3300;
        }
        .tab-btn {
            flex: 1;
            text-align: center;
            padding: 12px 0;
            font-weight: bold;
            background: #0a0510;
            color: #aaa;
            cursor: pointer;
            transition: 0.1s;
            font-size: 1.1rem;
            border-right: 1px solid #ff330055;
        }
        .tab-btn.active {
            background: #ff3300;
            color: white;
            text-shadow: 0 0 3px black;
            box-shadow: inset 0 -2px 0 white;
        }
        .tab-content {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .panel-section {
            background: #0f0b18cc;
            border-radius: 20px;
            padding: 12px;
            border: 1px solid #ff330055;
        }
        .color-palette-grid {
            display: grid;
            grid-template-columns: repeat(8, 1fr);
            gap: 8px;
            max-height: 240px;
            overflow-y: auto;
            padding: 5px;
        }
        .palette-swatch {
            aspect-ratio: 1 / 1;
            border-radius: 12px;
            cursor: pointer;
            border: 2px solid #2a2a2a;
            transition: 0.05s linear;
        }
        .palette-swatch.active {
            border: 3px solid white;
            box-shadow: 0 0 12px cyan;
            transform: scale(1.05);
        }
        .cooldown-bar-big {
            background: #222;
            height: 12px;
            border-radius: 20px;
            overflow: hidden;
            margin: 10px 0;
        }
        .cooldown-fill-big {
            width: 0%;
            height: 100%;
            background: linear-gradient(90deg, #ff3300, #ff8800);
        }
        .online-badge {
            background: #00aa33;
            padding: 5px 12px;
            border-radius: 30px;
            font-weight: bold;
            text-align: center;
        }
        .chat-messages-list {
            background: #00000066;
            border-radius: 16px;
            height: 220px;
            overflow-y: auto;
            padding: 8px;
            font-size: 0.85rem;
        }
        .message-item {
            margin: 6px 0;
            border-bottom: 1px solid #ff330033;
            padding: 4px;
        }
        .dm-target {
            font-size: 0.7rem;
            color: #ffaa00;
            cursor: pointer;
        }
        button, .btn-style {
            background: #ff3300;
            border: none;
            padding: 8px 12px;
            border-radius: 40px;
            font-weight: bold;
            color: white;
            cursor: pointer;
            transition: 0.05s linear;
        }
        button:active {
            transform: scale(0.96);
        }
        input, textarea {
            background: #221c33;
            border: 1px solid #ff3300;
            padding: 8px;
            border-radius: 20px;
            color: white;
            width: 100%;
        }
        .user-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px;
            background: #1e172e;
            margin: 6px 0;
            border-radius: 40px;
            cursor: pointer;
        }
        .avatar-mini {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background-size: cover;
        }
        ::-webkit-scrollbar {
            width: 5px;
        }
        ::-webkit-scrollbar-track {
            background: #111;
        }
        ::-webkit-scrollbar-thumb {
            background: #ff3300;
        }
    </style>
</head>
<body>
<div class="app">
    <div class="canvas-area">
        <div class="canvas-wrapper" id="canvasWrapper">
            <canvas id="pixelCanvas" width="1000" height="1000"></canvas>
        </div>
        <div class="zoom-controls">
            <button class="zoom-btn" id="zoomOutBtn">−</button>
            <span id="zoomLevel" style="color:white; font-weight:bold;">100%</span>
            <button class="zoom-btn" id="zoomInBtn">+</button>
            <button class="zoom-btn" id="resetViewBtn">⟳</button>
        </div>
    </div>
    <div class="right-panel">
        <div class="panel-header">⚡ PIXEL BATTLE ⚡</div>
        <div class="tab-strip">
            <div class="tab-btn active" data-tab="battle">🎨 БИТВА</div>
            <div class="tab-btn" data-tab="chat">💬 ЧАТ</div>
            <div class="tab-btn" data-tab="clans">🏰 КЛАНЫ</div>
            <div class="tab-btn" data-tab="profile">👤 ПРОФИЛЬ</div>
        </div>
        <div class="tab-content">
            <div id="battleTab" class="tab-pane active">
                <div class="panel-section">
                    <div style="display:flex; justify-content:space-between;">
                        <span>🎨 ПАЛИТРА</span>
                        <span>👥 <span id="onlineCount">0</span></span>
                    </div>
                    <div id="colorPaletteGrid" class="color-palette-grid"></div>
                    <div class="cooldown-bar-big"><div id="cooldownFill" class="cooldown-fill-big"></div></div>
                    <div id="cooldownText" style="text-align:center; font-size:0.8rem;">✅ ГОТОВ</div>
                </div>
                <div class="panel-section">
                    <div>🔫 КУРСОР ПОКАЖЕТ ВЛАДЕЛЬЦА</div>
                    <div style="font-size:0.7rem; color:#aaa;">Колесико мыши — зум | Зажми ЛКМ — таскай</div>
                </div>
            </div>
            <div id="chatTab" class="tab-pane" style="display:none;">
                <div class="panel-section">
                    <div>💬 ОБЩИЙ ЧАТ (ЛС)</div>
                    <div class="chat-messages-list" id="chatMessagesList"></div>
                    <div class="dm-target" id="dmTargetDisplay">⚡ Личный чат ни с кем</div>
                    <input type="text" id="chatInput" placeholder="Введите сообщение...">
                </div>
                <div class="panel-section">
                    <div>👥 ПОЛЬЗОВАТЕЛИ</div>
                    <div id="usersListContainer" style="max-height:200px; overflow-y:auto;"></div>
                </div>
            </div>
            <div id="clansTab" class="tab-pane" style="display:none;">
                <div class="panel-section">
                    <div id="myClanBlock">🏰 Вы не в клане</div>
                    <button id="createClanButton">⚔️ СОЗДАТЬ КЛАН</button>
                    <button id="leaveClanButton">🚪 ПОКИНУТЬ КЛАН</button>
                </div>
                <div class="panel-section">
                    <div>🌍 ВСЕ КЛАНЫ</div>
                    <div id="allClansList"></div>
                </div>
            </div>
            <div id="profileTab" class="tab-pane" style="display:none;">
                <div class="panel-section">
                    <img id="profileAvatar" width="80" height="80" style="border-radius:50%; margin:0 auto; display:block; border:2px solid #ff3300;">
                    <input type="text" id="avatarUrlInput" placeholder="URL аватара">
                    <textarea id="profileBioInput" rows="3" placeholder="О себе..."></textarea>
                    <button id="saveProfileButton">💾 СОХРАНИТЬ</button>
                    <button id="logoutButton" style="background:#990000;">🚪 ВЫЙТИ</button>
                </div>
            </div>
        </div>
    </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>${clientScript}</script>
</body>
</html>`;
}

function generateLoginHTML() {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Вход в Pixel Battle</title>
<style>
body{margin:0;background:#0a0f1e;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif}
.box{background:#1e2a3a;padding:40px;border-radius:30px;text-align:center;width:320px}
input{width:90%;padding:12px;margin:10px 0;border-radius:50px;border:none;background:#2c3e50;color:white}
button{background:#e67e22;border:none;padding:12px;border-radius:40px;color:white;font-weight:bold;width:100%;margin-top:10px;cursor:pointer}
.error{color:#ff6b6b;margin-top:10px}
h1{color:white}
</style>
</head>
<body>
<div class="box">
<h1>⚔️ PIXEL BATTLE ⚔️</h1>
<div id="error" class="error"></div>
<input type="text" id="username" placeholder="Никнейм">
<input type="password" id="password" placeholder="Пароль">
<button onclick="login()">Войти</button>
<button onclick="register()" style="background:#2c3e50;">Регистрация</button>
</div>
<script>
async function login(){
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data=await res.json();
    if(data.success) location.href='/';
    else error.innerText=data.error;
}
async function register(){
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const res=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data=await res.json();
    if(data.success) alert('Регистрация успешна! Теперь войдите.');
    else error.innerText=data.error;
}
</script>
</body>
</html>`;
}

server.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   💀 PIXEL BATTLE HARDCORE EDITION 💀  ║`);
    console.log(`║   http://localhost:${PORT}               ║`);
    console.log(`║   ЗУМ КОЛЕСИКОМ | 1000x1000 | 100+ ЦВЕТОВ ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
});