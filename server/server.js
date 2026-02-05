/**
 * WebRTC P2P 信令服务器 (支持呼叫请求/拒绝 + 状态同步)
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// HTTP服务
const httpServer = http.createServer((req, res) => {
    let filePath = path.join(__dirname, '..', 'client', req.url === '/' ? 'index.html' : req.url);
    const extname = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
        '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg'
    };
    const contentType = contentTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404); res.end('404 Not Found');
            } else {
                res.writeHead(500); res.end('Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

const wss = new WebSocket.Server({ server: httpServer });

const rooms = new Map();
const clients = new Map();

// 心跳保活
function heartbeat() { this.isAlive = true; }
const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', function close() { clearInterval(interval); });

// 辅助函数
function generateId() { return Math.random().toString(36).substring(2, 15); }
function generateRoomCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

// 广播
function broadcastToRoom(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.forEach(ws => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

// 单播
function sendToPeer(roomId, targetPeerId, message) {
    const room = rooms.get(roomId);
    if (!room) return false;
    for (const ws of room) {
        const clientInfo = clients.get(ws);
        if (clientInfo && clientInfo.peerId === targetPeerId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            return true;
        }
    }
    return false;
}

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    const peerId = generateId();
    console.log(`[连接] 新客户端: ${req.socket.remoteAddress}`);

    ws.send(JSON.stringify({ type: 'welcome', peerId: peerId }));

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'create-room': {
                    const roomId = generateRoomCode();
                    const username = message.username || '匿名';
                    rooms.set(roomId, new Set([ws]));
                    clients.set(ws, { roomId, peerId, username });
                    ws.send(JSON.stringify({ type: 'room-created', roomId, peerId }));
                    break;
                }
                case 'join-room': {
                    const roomId = message.roomId?.toUpperCase();
                    const username = message.username || '匿名';
                    let room = rooms.get(roomId);
                    if (!room) { room = new Set(); rooms.set(roomId, room); }
                    if (room.size >= 2) {
                        ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
                        return;
                    }
                    room.add(ws);
                    clients.set(ws, { roomId, peerId, username });
                    
                    const users = [];
                    room.forEach(client => {
                        const info = clients.get(client);
                        if (info) users.push({ peerId: info.peerId, username: info.username });
                    });

                    ws.send(JSON.stringify({ type: 'room-joined', roomId, peerId, users }));
                    broadcastToRoom(roomId, { type: 'peer-joined', peerId, username }, ws);
                    break;
                }
                // --- 新增信令转发逻辑 ---
                case 'call-request':     // 呼叫请求
                case 'call-accepted':    // 接受呼叫
                case 'call-rejected':    // 拒绝呼叫
                case 'hang-up':          // 挂断
                case 'offer':
                case 'answer':
                case 'ice-candidate': {
                    const clientInfo = clients.get(ws);
                    if (clientInfo) {
                        // 转发给指定目标
                        sendToPeer(clientInfo.roomId, message.targetPeerId, {
                            ...message,
                            fromPeerId: peerId
                        });
                    }
                    break;
                }
                case 'chat-message': {
                    const clientInfo = clients.get(ws);
                    if (clientInfo) {
                        broadcastToRoom(clientInfo.roomId, {
                            type: 'chat-message',
                            username: clientInfo.username,
                            content: message.content,
                            timestamp: Date.now()
                        }, ws);
                    }
                    break;
                }
                case 'leave-room':
                    handleLeave(ws);
                    break;
            }
        } catch (e) { console.error('WS Error:', e); }
    });

    ws.on('close', () => handleLeave(ws));
});

function handleLeave(ws) {
    const info = clients.get(ws);
    if (!info) return;
    const { roomId, username, peerId } = info;
    const room = rooms.get(roomId);
    if (room) {
        room.delete(ws);
        broadcastToRoom(roomId, { type: 'peer-left', peerId, username });
        if (room.size === 0) rooms.delete(roomId);
    }
    clients.delete(ws);
    console.log(`[断开] ${username}`);
}

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`WebRTC Server running on port ${PORT}`);
});
