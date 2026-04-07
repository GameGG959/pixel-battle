const socket = io();
const canvas = document.getElementById('pixelCanvas');
const ctx = canvas.getContext('2d');
let currentColor = '#e67e22';
let scale = 1;
let myClan = null;
let pendingRequests = []; // для отображения заявок владельцу

// Палитра (квадратные цвета)
const COLORS = [
    '#000000', '#FFFFFF', '#e67e22', '#f39c12', '#e74c3c', '#2ecc71',
    '#3498db', '#9b59b6', '#1abc9c', '#e84393', '#7f8c8d', '#f1c40f',
    '#2c3e50', '#d35400', '#c0392b', '#16a085', '#27ae60', '#2980b9',
    '#8e44ad', '#f39c12'
];

function buildPalette() {
    const paletteDiv = document.getElementById('palette');
    paletteDiv.innerHTML = '';
    COLORS.forEach(col => {
        const btn = document.createElement('div');
        btn.className = 'color-btn';
        btn.style.backgroundColor = col;
        btn.onclick = () => {
            currentColor = col;
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
        paletteDiv.appendChild(btn);
    });
    document.querySelector('.color-btn')?.classList.add('active');
}

// Отрисовка холста
function drawGrid(gridData) {
    for (let i = 0; i < 100; i++) {
        for (let j = 0; j < 100; j++) {
            ctx.fillStyle = gridData[i][j];
            ctx.fillRect(i, j, 1, 1);
        }
    }
}

function drawPixel(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
}

// Приближение колесиком
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    let newScale = scale + delta;
    newScale = Math.min(4, Math.max(0.5, newScale));
    scale = newScale;
    canvas.style.transform = `scale(${scale})`;
});

let cooldownActive = false;
let cooldownInterval = null;

function startCooldown(secondsLeft) {
    if (cooldownInterval) clearInterval(cooldownInterval);
    cooldownActive = true;
    const fillDiv = document.getElementById('cooldownFill');
    const textSpan = document.getElementById('cooldownText');
    let remaining = secondsLeft || 20;
    const update = () => {
        if (remaining <= 0) {
            cooldownActive = false;
            textSpan.innerText = '✅ ГОТОВ';
            fillDiv.style.width = '0%';
            if (cooldownInterval) clearInterval(cooldownInterval);
        } else {
            textSpan.innerText = `⏱️ ${remaining} сек`;
            const percent = (remaining / 20) * 100;
            fillDiv.style.width = `${100 - percent}%`;
            remaining--;
        }
    };
    update();
    cooldownInterval = setInterval(update, 1000);
}

// Клик по холсту
canvas.addEventListener('mousedown', (e) => {
    if (cooldownActive) {
        showMessage('⛔ Перезарядка!', 'error');
        return;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / (rect.width / scale);
    const scaleY = canvas.height / (rect.height / scale);
    const offsetX = (e.clientX - rect.left) / scale;
    const offsetY = (e.clientY - rect.top) / scale;
    const x = Math.floor(offsetX);
    const y = Math.floor(offsetY);
    if (x >= 0 && x < 100 && y >= 0 && y < 100) {
        socket.emit('pixel', { x, y, color: currentColor });
        startCooldown(20);
    }
});

socket.on('cooldown', (seconds) => {
    startCooldown(seconds);
});

socket.on('initGrid', (grid) => drawGrid(grid));
socket.on('pixel', (data) => drawPixel(data.x, data.y, data.color));
socket.on('updateOnline', (count) => document.getElementById('onlineCount').innerText = count);

// Кланы и заявки
socket.on('clansList', (clans) => {
    const container = document.getElementById('clansListContainer');
    if (!clans || Object.keys(clans).length === 0) {
        container.innerHTML = '📭 Нет кланов';
        return;
    }
    let html = '<div style="display:flex; gap:10px; flex-wrap:wrap;">';
    for (let id in clans) {
        const c = clans[id];
        html += `<div style="background:#2c3e50; border-radius:20px; padding:5px 12px;">
                    <span style="color:${c.color}">${c.name}</span> (${c.membersCount} уч.)
                    <button class="joinClanBtn" data-id="${id}" style="padding:2px 10px; background:#e67e22;">Вступить</button>
                </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
    document.querySelectorAll('.joinClanBtn').forEach(btn => {
        btn.onclick = () => socket.emit('joinClanRequest', parseInt(btn.dataset.id));
    });
});

socket.on('myClanInfo', (clan) => {
    if (clan) {
        myClan = clan;
        document.getElementById('myClanInfo').innerHTML = `🏆 Ваш клан: <span style="color:${clan.color}">${clan.name}</span> (${clan.role})`;
    } else {
        myClan = null;
        document.getElementById('myClanInfo').innerHTML = '🔹 Вы не в клане';
    }
});

socket.on('clanRequest', ({ fromUserId, fromUsername, clanId, clanName }) => {
    if (confirm(`Пользователь ${fromUsername} хочет вступить в клан "${clanName}". Одобрить?`)) {
        socket.emit('approveRequest', { requestId: Date.now(), userIdToAdd: fromUserId, clanId });
    } else {
        socket.emit('rejectRequest', { requestId: Date.now() });
    }
});

socket.on('clanJoined', (clanInfo) => {
    myClan = clanInfo;
    document.getElementById('myClanInfo').innerHTML = `🏆 Вы в клане: ${clanInfo.name}`;
    showMessage(`Добро пожаловать в клан ${clanInfo.name}!`);
});

socket.on('clanLeft', () => {
    myClan = null;
    document.getElementById('myClanInfo').innerHTML = '🔹 Вы не в клане';
    showMessage('Вы покинули клан');
});

socket.on('message', (msg) => showMessage(msg));

function showMessage(msg, type = 'info') {
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.bottom = '20px';
    div.style.right = '20px';
    div.style.background = '#1e2a3a';
    div.style.borderLeft = `4px solid ${type === 'error' ? '#e74c3c' : '#e67e22'}`;
    div.style.padding = '10px 18px';
    div.style.borderRadius = '12px';
    div.style.zIndex = 9999;
    div.innerText = msg;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

// Кнопки кланов
document.getElementById('createClanBtn').onclick = () => {
    if (myClan) return showMessage('Сначала покиньте текущий клан');
    const name = prompt('Название клана:', 'Легион');
    const color = prompt('Цвет клана (HEX):', '#e67e22');
    if (name && color) socket.emit('createClan', { name, color });
};
document.getElementById('joinClanBtn').onclick = () => {
    if (myClan) return showMessage('Вы уже в клане');
    showMessage('Нажмите "Вступить" под любым кланом в списке');
};
document.getElementById('leaveClanBtn').onclick = () => {
    if (!myClan) return showMessage('Вы не в клане');
    if (confirm('Покинуть клан?')) socket.emit('leaveClan');
};

buildPalette();