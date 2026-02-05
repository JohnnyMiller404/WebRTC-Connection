/**
 * WebRTC P2P 客户端 (V14: 大文件传输修复版)
 * 修复：解决大于50MB文件传输时进度条卡死的问题（增加强力流控）
 */
class WebRTCApp {
    constructor() {
        this.config = {
            iceTransportPolicy: 'all',
            iceCandidatePoolSize: 10,
            iceServers: [
                // 1. 国内 STUN
                { urls: 'stun:stun.qq.com:3478' },
                { urls: 'stun:stun.miwifi.com:3478' },
                
                // 2. 主力 TURN (阿里云 - 低延迟)
                {
                    urls: 'turn:39.97.44.1:3478?transport=udp',
                    username: 'admin',
                    credential: '123456'
                },
                {
                    urls: 'turn:39.97.44.1:3478?transport=tcp',
                    username: 'admin',
                    credential: '123456'
                },

                // 3. 保底 TURN (OpenRelay)
                {
                    urls: 'turn:openrelay.metered.ca:80',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                {
                    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ],
            defaultSignalingServer: `ws://${window.location.hostname}:8080`
        };

        this.ws = null;
        this.peerConnection = null;
        this.dataChannel = null;
        this.fileChannel = null;
        this.localStream = null;
        this.screenStream = null;
        
        this.myPeerId = null;
        this.remotePeerId = null;
        this.roomId = null;
        this.username = '匿名用户';
        
        this.lastVideoBytes = 0;
        this.lastAudioBytes = 0;
        this.lastCheckTime = 0;

        this.initUI();
    }

    // ==========================================
    // UI 和 信令部分保持不变
    // ==========================================

    initUI() {
        document.getElementById('createRoomBtn').onclick = () => this.createRoom();
        document.getElementById('joinRoomBtn').onclick = () => this.joinRoom();
        document.getElementById('leaveRoomBtn').onclick = () => this.leaveRoom();
        document.getElementById('copyRoomIdBtn').onclick = () => this.copyRoomId();
        
        document.getElementById('toggleVideoBtn').onclick = () => this.toggleVideo();
        document.getElementById('toggleAudioBtn').onclick = () => this.toggleAudio();
        document.getElementById('startCallBtn').onclick = () => this.initiateCallRequest();
        document.getElementById('endCallBtn').onclick = () => this.endCall(true);
        document.getElementById('sendMsgBtn').onclick = () => this.sendChatMessage();
        document.getElementById('screenShareBtn').onclick = () => this.toggleScreenShare();
        
        document.getElementById('acceptCallBtn').onclick = () => this.acceptCall();
        document.getElementById('rejectCallBtn').onclick = () => this.rejectCall();

        const imgBtn = document.getElementById('sendImgBtn');
        const imgInput = document.getElementById('imgInput');
        if(imgBtn && imgInput) {
            imgBtn.onclick = () => imgInput.click();
            imgInput.onchange = (e) => {
                if(e.target.files.length > 0) {
                    this.sendFile(e.target.files[0], true);
                    e.target.value = '';
                }
            };
        }

        const dropZone = document.getElementById('fileDropZone');
        const fileInput = document.getElementById('fileInput');
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
            document.body.addEventListener(e, (ev) => { ev.preventDefault(); ev.stopPropagation(); }, false);
        });
        ['dragenter', 'dragover'].forEach(e => {
            document.body.addEventListener(e, () => dropZone.classList.add('dragover'), false);
        });
        ['dragleave', 'drop'].forEach(e => {
            document.body.addEventListener(e, () => dropZone.classList.remove('dragover'), false);
        });
        document.body.addEventListener('drop', (e) => {
            this.switchTab('file');
            const files = e.dataTransfer.files;
            if (files.length > 0) this.sendFile(files[0]);
        });
        dropZone.onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            if (e.target.files.length > 0) this.sendFile(e.target.files[0]);
        };

        document.getElementById('chatInput').onkeypress = (e) => { if (e.key === 'Enter') this.sendChatMessage(); };
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.onclick = () => this.switchTab(btn.dataset.tab);
        });

        const savedUrl = localStorage.getItem('signalingServerUrl');
        document.getElementById('serverUrl').value = savedUrl || this.config.defaultSignalingServer;
    }

    switchTab(tabName) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
        const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
        if(btn) btn.classList.add('active');
        const content = document.getElementById(`${tabName}Tab`);
        if(content) content.style.display = 'flex';
    }

    connectToSignalingServer() {
        return new Promise((resolve, reject) => {
            const url = document.getElementById('serverUrl').value;
            localStorage.setItem('signalingServerUrl', url);
            this.ws = new WebSocket(url);
            this.ws.onopen = () => { this.updateStatus(true, '信令已连接'); resolve(); };
            this.ws.onmessage = (e) => this.handleSignal(JSON.parse(e.data));
            this.ws.onerror = (e) => { this.showNotification('无法连接信令服务器', 'error'); reject(e); };
            this.ws.onclose = () => this.updateStatus(false, '连接断开');
        });
    }

    handleSignal(msg) {
        switch(msg.type) {
            case 'welcome': this.myPeerId = msg.peerId; break;
            case 'room-created':
            case 'room-joined':
                this.roomId = msg.roomId;
                document.getElementById('loginPanel').style.display = 'none';
                document.getElementById('communicationPanel').style.display = 'flex';
                document.getElementById('currentRoomId').textContent = this.roomId;
                this.showNotification('进入房间成功', 'success');
                if (msg.users && msg.users.length > 0) {
                    const other = msg.users.find(u => u.peerId !== this.myPeerId);
                    if(other) { this.remotePeerId = other.peerId; this.updatePeerStatus(`对方: ${other.username}`); }
                }
                break;
            case 'peer-joined':
                this.remotePeerId = msg.peerId;
                this.updatePeerStatus(`对方: ${msg.username} 已加入`);
                this.showNotification(`${msg.username} 加入房间`, 'info');
                break;
            case 'peer-left':
                this.remotePeerId = null;
                this.updatePeerStatus('对方已离开');
                this.endCall(false);
                this.showNotification(`${msg.username} 离开房间`, 'warning');
                break;
            case 'call-request': this.showCallModal(); break;
            case 'call-accepted': this.showNotification('对方接受了通话', 'success'); this.startWebRTC(); break;
            case 'call-rejected': this.showNotification('对方拒绝了通话', 'error'); this.updateCallUI(false); break;
            case 'hang-up': this.showNotification('对方已挂断', 'info'); this.endCall(false); break;
            case 'offer': this.handleOffer(msg.offer, msg.fromPeerId); break;
            case 'answer': this.peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer)); break;
            case 'ice-candidate': 
                if (this.peerConnection && this.peerConnection.signalingState !== 'closed') {
                    this.peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(e => {});
                }
                break;
            case 'chat-message': this.addChatMessage(msg.username, msg.content, 'received'); break;
            case 'error': this.showNotification(msg.message, 'error'); break;
        }
    }

    initiateCallRequest() {
        if (!this.remotePeerId) return this.showNotification('没有对方用户', 'warning');
        const btn = document.getElementById('startCallBtn');
        btn.disabled = true; btn.innerHTML = '⌛ 呼叫中...';
        this.ws.send(JSON.stringify({ type: 'call-request', targetPeerId: this.remotePeerId }));
    }
    showCallModal() { document.getElementById('callModal').style.display = 'flex'; }
    acceptCall() {
        document.getElementById('callModal').style.display = 'none';
        this.ws.send(JSON.stringify({ type: 'call-accepted', targetPeerId: this.remotePeerId }));
    }
    rejectCall() {
        document.getElementById('callModal').style.display = 'none';
        this.ws.send(JSON.stringify({ type: 'call-rejected', targetPeerId: this.remotePeerId }));
    }

    async startWebRTC() {
        await this.getLocalMedia();
        this.createPeerConnection();
        this.localStream.getTracks().forEach(track => this.peerConnection.addTrack(track, this.localStream));
        this.dataChannel = this.peerConnection.createDataChannel('chat');
        this.setupDataChannel(this.dataChannel);
        this.fileChannel = this.peerConnection.createDataChannel('file');
        this.setupFileChannel(this.fileChannel);
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        this.ws.send(JSON.stringify({ type: 'offer', offer, targetPeerId: this.remotePeerId }));
        this.updateCallUI(true);
    }

    async handleOffer(offer, fromPeerId) {
        this.remotePeerId = fromPeerId;
        await this.getLocalMedia();
        this.createPeerConnection();
        this.localStream.getTracks().forEach(track => this.peerConnection.addTrack(track, this.localStream));
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.ws.send(JSON.stringify({ type: 'answer', answer, targetPeerId: this.remotePeerId }));
        this.updateCallUI(true);
    }

    createPeerConnection() {
        this.peerConnection = new RTCPeerConnection(this.config);
        this.peerConnection.onicecandidate = (e) => {
            if (e.candidate) this.ws.send(JSON.stringify({ type: 'ice-candidate', candidate: e.candidate, targetPeerId: this.remotePeerId }));
        };
        this.peerConnection.ontrack = (e) => {
            const remoteVid = document.getElementById('remoteVideo');
            remoteVid.srcObject = e.streams[0];
            document.getElementById('remotePlaceholder').style.display = 'none';
        };
        this.peerConnection.ondatachannel = (e) => {
            if (e.channel.label === 'chat') this.setupDataChannel(e.channel);
            if (e.channel.label === 'file') this.setupFileChannel(e.channel);
        };
        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection.connectionState;
            document.getElementById('connectionState').textContent = state;
            if (state === 'connected') {
                this.updateStatus(true, 'P2P已连接');
                this.showNotification('P2P加密通道已建立', 'success');
            }
        };
        this.startStatsMonitoring();
    }

    startStatsMonitoring() {
        if (this.statsInterval) clearInterval(this.statsInterval);
        this.statsInterval = setInterval(async () => {
            if (!this.peerConnection) return;
            const setText = (id, txt) => { const el = document.getElementById(id); if(el) el.textContent = txt; };
            setText('signalingState', this.peerConnection.signalingState || 'stable');
            setText('iceState', this.peerConnection.iceConnectionState);
            if (this.peerConnection.connectionState !== 'connected') return;
            try {
                const stats = await this.peerConnection.getStats();
                let videoBytes = 0, audioBytes = 0, currentRTT = 0;
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) currentRTT = report.currentRoundTripTime;
                    if (report.type === 'local-candidate' && report.candidateType) setText('localCandidateType', report.candidateType);
                    if (report.type === 'remote-candidate' && report.candidateType) setText('remoteCandidateType', report.candidateType);
                    if (report.type === 'inbound-rtp') { if (report.kind === 'video') videoBytes = report.bytesReceived; if (report.kind === 'audio') audioBytes = report.bytesReceived; }
                });
                setText('roundTripTime', `${(currentRTT * 1000).toFixed(0)} ms`);
                const now = Date.now();
                if (this.lastCheckTime) {
                    const duration = (now - this.lastCheckTime) / 1000;
                    if (duration > 0) {
                        const vBitrate = ((videoBytes - this.lastVideoBytes) * 8 / 1000 / duration).toFixed(0);
                        const aBitrate = ((audioBytes - this.lastAudioBytes) * 8 / 1000 / duration).toFixed(0);
                        setText('videoBitrate', `${vBitrate} kbps`);
                        setText('audioBitrate', `${aBitrate} kbps`);
                    }
                }
                this.lastCheckTime = now; this.lastVideoBytes = videoBytes; this.lastAudioBytes = audioBytes;
            } catch (e) {}
        }, 1000);
    }

    setupFileChannel(channel) {
        this.fileChannel = channel; channel.binaryType = 'arraybuffer';
        channel.onopen = () => this.showNotification('📁 文件传输通道已就绪', 'success');
        channel.onmessage = (event) => this.handleFileData(event.data);
    }

    // 【关键修复】大文件传输流控 (防止缓冲区溢出)
    async sendFile(file, isChatImg = false) {
        if (!this.fileChannel || this.fileChannel.readyState !== 'open') return this.showNotification('通道未就绪，请先开始通话', 'warning');
        
        if (isChatImg) this.addChatMessage('我', '', 'sent', file);

        const CHUNK_SIZE = 16384; 
        const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64KB 缓冲区阈值
        const id = Date.now().toString();
        
        this.fileChannel.send(JSON.stringify({ 
            type: 'file-info', id, name: file.name, size: file.size, mimeType: file.type, isChatImg 
        }));
        
        if (!isChatImg) this.createFileTransferItem(id, file.name, file.size, 'sending');
        
        let offset = 0;
        const reader = new FileReader();

        // 递归读取函数，只有缓冲区空了才读下一片
        const readNextChunk = () => {
            // 如果缓冲区太满，暂停发送，等待50ms后重试
            if (this.fileChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                setTimeout(readNextChunk, 50);
                return;
            }

            // 读取下一片
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        };

        reader.onload = (e) => {
            const data = e.target.result;
            // 再次检查连接状态（防止断连后报错）
            if (this.fileChannel.readyState === 'open') {
                try {
                    this.fileChannel.send(data);
                    offset += data.byteLength;
                    
                    if (!isChatImg) {
                        this.updateFileProgress(id, (offset / file.size) * 100);
                    }

                    if (offset < file.size) {
                        // 继续读下一片
                        readNextChunk(); 
                    } else {
                        // 发送结束标记
                        this.fileChannel.send(JSON.stringify({type:'file-end', id, isChatImg})); 
                        if(!isChatImg) this.showNotification('发送完成', 'success'); 
                    }
                } catch (error) {
                    console.error('发送中断:', error);
                    this.showNotification('发送中断', 'error');
                }
            }
        };

        // 启动发送循环
        readNextChunk();
    }

    handleFileData(data) {
        if(typeof data === 'string') {
            const msg = JSON.parse(data);
            if(msg.type==='file-info'){ this.receiving={...msg, buf:[], rcv:0}; if (!msg.isChatImg) { this.createFileTransferItem(msg.id, msg.name, msg.size, 'receiving'); this.showNotification(`接收文件: ${msg.name}`, 'info'); } }
            else if(msg.type==='file-end') this.saveFile(msg.isChatImg);
        } else {
            if(!this.receiving) return;
            this.receiving.buf.push(data); this.receiving.rcv += data.byteLength;
            if (!this.receiving.isChatImg) this.updateFileProgress(this.receiving.id, (this.receiving.rcv/this.receiving.size)*100);
        }
    }

    saveFile(isChatImg) {
        if(!this.receiving) return;
        const blob = new Blob(this.receiving.buf, {type:this.receiving.mimeType});
        if (isChatImg) { this.addChatMessage('对方', '', 'received', blob); } else {
            const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=this.receiving.name; a.click(); URL.revokeObjectURL(url);
            this.showNotification('接收成功', 'success'); 
        }
        this.receiving=null;
    }

    createFileTransferItem(id, name, size, type) {
        const d = document.createElement('div'); d.className='file-transfer-item'; d.id=`file-${id}`;
        d.innerHTML=`<div class="file-icon">${type==='sending'?'📤':'📥'}</div><div class="file-info"><div class="file-name">${name}</div><div class="file-progress"><div class="file-progress-bar" style="width:0%"></div></div></div>`;
        document.getElementById('fileTransferList').appendChild(d);
    }
    updateFileProgress(id, p) { const el=document.getElementById(`file-${id}`); if(el) el.querySelector('.file-progress-bar').style.width=`${p}%`; }
    async getLocalMedia() {
        try { this.localStream = await navigator.mediaDevices.getUserMedia({video:true, audio:true}); document.getElementById('localVideo').srcObject=this.localStream; }
        catch(e) { this.showNotification('无法访问摄像头', 'error'); }
    }
    toggleVideo() { if(this.localStream){ const t=this.localStream.getVideoTracks()[0]; t.enabled=!t.enabled; this.updateMediaBtn('toggleVideoBtn', t.enabled); } }
    toggleAudio() { if(this.localStream){ const t=this.localStream.getAudioTracks()[0]; t.enabled=!t.enabled; this.updateMediaBtn('toggleAudioBtn', t.enabled); } }
    updateMediaBtn(id, active) {
        const btn=document.getElementById(id); const on=btn.querySelector('.icon-on'); const off=btn.querySelector('.icon-off');
        if(active){ btn.classList.remove('disabled'); on.style.display='inline'; off.style.display='none'; }
        else{ btn.classList.add('disabled'); on.style.display='none'; off.style.display='inline'; }
    }
    async toggleScreenShare() {
        if (this.isScreenSharing) return this.stopScreenShare();
        try {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({video:true});
            const st = this.screenStream.getVideoTracks()[0];
            const sender = this.peerConnection.getSenders().find(s => s.track.kind === 'video');
            if(sender) await sender.replaceTrack(st);
            document.getElementById('localVideo').srcObject = this.screenStream;
            this.isScreenSharing = true;
            this.updateScreenBtn(true);
            st.onended = () => this.stopScreenShare();
        } catch(e) {}
    }
    async stopScreenShare() {
        const sender = this.peerConnection.getSenders().find(s => s.track.kind === 'video');
        if(sender) await sender.replaceTrack(this.localStream.getVideoTracks()[0]);
        document.getElementById('localVideo').srcObject = this.localStream;
        if(this.screenStream) this.screenStream.getTracks().forEach(t=>t.stop());
        this.isScreenSharing = false;
        this.updateScreenBtn(false);
    }
    updateScreenBtn(active) {
        const btn=document.getElementById('screenShareBtn'); const on=btn.querySelector('.icon-on'); const off=btn.querySelector('.icon-off');
        if(active){ btn.classList.add('active-share'); on.style.display='none'; off.style.display='inline'; }
        else{ btn.classList.remove('active-share'); on.style.display='inline'; off.style.display='none'; }
    }
    setupDataChannel(c) { this.dataChannel=c; c.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.type==='chat')this.addChatMessage(m.username,m.content,'received');}; }
    sendChatMessage() {
        const i=document.getElementById('chatInput'); const c=i.value.trim(); if(!c) return;
        const m={type:'chat', username:this.username, content:c};
        if(this.dataChannel?.readyState==='open') this.dataChannel.send(JSON.stringify(m)); else this.ws.send(JSON.stringify({...m, type:'chat-message'}));
        this.addChatMessage('我', c, 'sent'); i.value='';
    }
    addChatMessage(u, t, type, imageBlob = null) {
        const d=document.createElement('div'); d.className=`chat-message ${type}`; 
        let contentHtml = `<div class="content">${this.escapeHtml(t)}</div>`;
        if (imageBlob) { const url = URL.createObjectURL(imageBlob); contentHtml = `<img src="${url}" class="chat-image" onclick="window.open('${url}')">`; }
        d.innerHTML=`<div class="username">${u}</div>${contentHtml}`;
        document.getElementById('chatMessages').appendChild(d); d.scrollIntoView();
    }
    updateStatus(c, t) { const el=document.getElementById('connectionStatus'); el.querySelector('.status-dot').className=`status-dot ${c?'connected':''}`; el.querySelector('.status-text').textContent=t||(c?'已连接':'未连接'); }
    updatePeerStatus(t) { document.getElementById('peerStatus').textContent=t; }
    showNotification(m, t) { const d=document.createElement('div'); d.className=`notification ${t}`; d.textContent=m; document.getElementById('notificationContainer').appendChild(d); setTimeout(()=>d.remove(), 3000); }
    escapeHtml(t) { const d=document.createElement('div'); d.textContent=t; return d.innerHTML; }
    async createRoom() { this.username=document.getElementById('usernameInput').value||'用户'; await this.connectToSignalingServer(); this.ws.send(JSON.stringify({type:'create-room', username:this.username})); }
    async joinRoom() { 
        this.username=document.getElementById('usernameInput').value||'用户'; const r=document.getElementById('roomIdInput').value; 
        if(!r) return; await this.connectToSignalingServer(); this.ws.send(JSON.stringify({type:'join-room', roomId:r, username:this.username})); 
    }
    leaveRoom() { if(this.ws) this.ws.send(JSON.stringify({type:'leave-room'})); location.reload(); }
    copyRoomId() { if(this.roomId) { navigator.clipboard.writeText(this.roomId); this.showNotification('房间号已复制', 'success'); } }
    endCall(init=false) {
        if(init && this.ws && this.remotePeerId) this.ws.send(JSON.stringify({type:'hang-up', targetPeerId:this.remotePeerId}));
        if(this.peerConnection) this.peerConnection.close();
        if(this.localStream) this.localStream.getTracks().forEach(t=>t.stop());
        if(this.screenStream) this.screenStream.getTracks().forEach(t=>t.stop());
        const remoteVideo = document.getElementById('remoteVideo');
        remoteVideo.srcObject = null;
        remoteVideo.load();
        document.getElementById('localVideo').srcObject = null;
        document.getElementById('remotePlaceholder').style.display = 'flex';
        this.updateCallUI(false); this.updateStatus(true, '信令在线'); clearInterval(this.statsInterval);
        const btn = document.getElementById('startCallBtn');
        btn.disabled = false; btn.innerHTML = '📞 开始通话';
    }
    updateCallUI(active) {
        document.getElementById('startCallBtn').style.display=active?'none':'flex'; 
        document.getElementById('endCallBtn').style.display=active?'flex':'none';
    }
}
const app = new WebRTCApp();
