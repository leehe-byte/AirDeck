/**
 * Scrcpy 远程控制模块 - 补全断开连接接口与目标信息显示
 */

(function() {
    'use strict';

    const CONTROL_TYPE = { INJECT_KEYCODE: 0, INJECT_TOUCH_EVENT: 2, INJECT_SCROLL_EVENT: 3 };
    const ACTION = { DOWN: 0, UP: 1, MOVE: 2 };
    const KEYCODE = { HOME: 3, BACK: 4, APP_SWITCH: 187 };

    class ScrcpyRemote {
        constructor() {
            this.socket = null;
            this.canvas = null;
            this.ctx = null;
            this.decoder = null;
            this.isConnected = false;
            this.isConnecting = false;
            this.frameBuffer = new Uint8Array(0);
            this.decoderConfigured = false;
            this.onStatusChange = null;
            this.onFpsUpdate = null;
            this.framesInWindow = 0;
            this.lastStatsTime = 0;
            this.sps = null;
            this.pps = null;
            this.startTime = 0;
            this.isMouseDown = false;
        }

        async connect() {
            if (this.isConnected || this.isConnecting) return;
            this.isConnecting = true;
            this._updateStatus('connecting');

            try {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const token = sessionStorage.getItem('authToken') || '';
                const wsUrl = `${protocol}//${window.location.host}/ws/scrcpy?token=${encodeURIComponent(token)}`;
                this.socket = new WebSocket(wsUrl);
                this.socket.binaryType = 'arraybuffer';

                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('连接超时')), 10000);
                    this.socket.onopen = () => { clearTimeout(timeout); resolve(); };
                    this.socket.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket 握手失败')); };
                });

                this.socket.onmessage = (e) => this._handleMessage(e);
                this.socket.onclose = () => this._handleDisconnect();

                await this._initDecoder();
                this.isConnected = true;
                this.isConnecting = false;
                this._updateStatus('connected');
                this.startTime = performance.now();
            } catch (err) {
                this.isConnecting = false;
                this._updateStatus('error', err.message);
                this._cleanup();
                throw err;
            }
        }

        disconnect() {
            console.log('[Scrcpy] Disconnecting...');
            this._cleanup();
            this._updateStatus('disconnected');
        }

        _handleMessage(e) {
            if (typeof e.data === 'string') return;
            this._processStream(new Uint8Array(e.data));
        }

        async _initDecoder() {
            if (typeof VideoDecoder === 'undefined') throw new Error('浏览器不支持 WebCodecs');
            this.decoder = new VideoDecoder({
                output: (frame) => this._renderFrame(frame),
                error: (e) => console.error('Decoder Error:', e)
            });
        }

        _processStream(newData) {
            const combined = new Uint8Array(this.frameBuffer.length + newData.length);
            combined.set(this.frameBuffer); combined.set(newData, this.frameBuffer.length);
            this.frameBuffer = combined;

            let offset = 0;
            while (offset < this.frameBuffer.length - 4) {
                if (this.frameBuffer[offset] === 0 && this.frameBuffer[offset+1] === 0 &&
                   (this.frameBuffer[offset+2] === 1 || (this.frameBuffer[offset+2] === 0 && this.frameBuffer[offset+3] === 1))) {
                    const scLen = this.frameBuffer[offset+2] === 1 ? 3 : 4;
                    let nextStart = -1;
                    for (let j = offset + scLen; j < this.frameBuffer.length - 3; j++) {
                        if (this.frameBuffer[j] === 0 && this.frameBuffer[j+1] === 0 &&
                           (this.frameBuffer[j+2] === 1 || (this.frameBuffer[j+2] === 0 && this.frameBuffer[j+3] === 1))) {
                            nextStart = j; break;
                        }
                    }
                    if (nextStart !== -1) {
                        this._handleNAL(this.frameBuffer.slice(offset, nextStart));
                        offset = nextStart;
                    } else break;
                } else offset++;
            }
            this.frameBuffer = this.frameBuffer.slice(offset);
        }

        _handleNAL(nal) {
            let scLen = (nal[2] === 1) ? 3 : 4;
            const type = nal[scLen] & 0x1F;
            if (type === 7) this.sps = nal;
            else if (type === 8) this.pps = nal;
            if (!this.decoderConfigured && this.sps && this.pps) {
                this.decoder.configure({ codec: 'avc1.42001e', hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
                this.decoderConfigured = true;
            }
            if (this.decoderConfigured && (type === 1 || type === 5)) {
                let data = nal;
                if (type === 5 && this.sps && this.pps) {
                    data = new Uint8Array(this.sps.length + this.pps.length + nal.length);
                    data.set(this.sps, 0); data.set(this.pps, this.sps.length); data.set(nal, this.sps.length + this.pps.length);
                }
                try {
                    this.decoder.decode(new EncodedVideoChunk({
                        type: type === 5 ? 'key' : 'delta',
                        timestamp: Math.round((performance.now() - this.startTime) * 1000),
                        data: data
                    }));
                } catch (e) {}
            }
        }

        _renderFrame(frame) {
            this.framesInWindow++;
            if (this.canvas && this.ctx) {
                if (this.canvas.width !== frame.displayWidth) {
                    this.canvas.width = frame.displayWidth; this.canvas.height = frame.displayHeight;
                }
                this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
            }
            frame.close(); this._updateFps();
        }

        _updateFps() {
            const now = performance.now();
            if (now - this.lastStatsTime > 1000) {
                if (this.onFpsUpdate) this.onFpsUpdate(this.framesInWindow);
                this.framesInWindow = 0; this.lastStatsTime = now;
            }
        }

        _updateStatus(status, error) { if (this.onStatusChange) this.onStatusChange(status, error); }
        _handleDisconnect() { this._cleanup(); this._updateStatus('disconnected'); }
        _cleanup() {
            this.isConnected = false;
            try { this.socket?.close(); } catch(e) {}
            try { this.decoder?.close(); } catch(e) {}
            this.socket = null;
            this.decoder = null;
            this.decoderConfigured = false;
            this.frameBuffer = new Uint8Array(0);
        }

        setCanvas(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this._setupEvents(); }

        _setupEvents() {
            const handleEvent = (e, action) => {
                if (!this.isConnected) return;
                e.preventDefault();
                let clientX, clientY;
                if (e.touches && e.touches.length > 0) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
                else if (e.changedTouches && e.changedTouches.length > 0) { clientX = e.changedTouches[0].clientX; clientY = e.changedTouches[0].clientY; }
                else { clientX = e.clientX; clientY = e.clientY; }
                const rect = this.canvas.getBoundingClientRect();
                const x = Math.round((clientX - rect.left) / rect.width * this.canvas.width);
                const y = Math.round((clientY - rect.top) / rect.height * this.canvas.height);
                this._sendTouch(action, x, y, this.canvas.width, this.canvas.height);
            };
            this.canvas.onmousedown = (e) => { this.isMouseDown = true; handleEvent(e, ACTION.DOWN); };
            this.canvas.onmousemove = (e) => { if (this.isMouseDown) handleEvent(e, ACTION.MOVE); };
            this.canvas.onmouseup = (e) => { this.isMouseDown = false; handleEvent(e, ACTION.UP); };
            this.canvas.onmouseleave = (e) => { if (this.isMouseDown) { this.isMouseDown = false; handleEvent(e, ACTION.UP); } };
            this.canvas.ontouchstart = (e) => handleEvent(e, ACTION.DOWN);
            this.canvas.ontouchmove = (e) => handleEvent(e, ACTION.MOVE);
            this.canvas.ontouchend = (e) => handleEvent(e, ACTION.UP);
        }

        _sendTouch(action, x, y, sw, sh) {
            const buf = new ArrayBuffer(32);
            const dv = new DataView(buf);
            dv.setUint8(0, CONTROL_TYPE.INJECT_TOUCH_EVENT);
            dv.setUint8(1, action);
            dv.setUint32(2, 0, false); dv.setUint32(6, 0, false);
            dv.setUint32(10, x, false); dv.setUint32(14, y, false);
            dv.setUint16(18, sw, false); dv.setUint16(20, sh, false);
            dv.setUint16(22, 0xFFFF, false);
            dv.setUint32(24, 0, false); dv.setUint32(28, 1, false);
            this._sendControl(new Uint8Array(buf));
        }

        _sendControl(msg) { if (this.socket?.readyState === 1) this.socket.send(msg); }

        sendKey(k) {
            const b = new ArrayBuffer(14);
            const d = new DataView(b);
            d.setUint8(0, CONTROL_TYPE.INJECT_KEYCODE); d.setUint8(1, ACTION.DOWN); d.setUint32(2, k, false); d.setUint32(6, 0, false); d.setUint32(10, 0, false);
            this._sendControl(new Uint8Array(b));
            setTimeout(() => { d.setUint8(1, ACTION.UP); this._sendControl(new Uint8Array(b)); }, 50);
        }
    }

    window.initRemoteScrcpy = function() {
        const remote = new ScrcpyRemote();
        const els = {
            connect: document.getElementById('remote-connect-btn'),
            disconnect: document.getElementById('remote-disconnect-btn'),
            canvas: document.getElementById('remote-canvas'),
            placeholder: document.getElementById('remote-placeholder'),
            statusText: document.getElementById('remote-status-text'),
            statusDot: document.getElementById('remote-status-dot'),
            fps: document.getElementById('remote-fps'),
            error: document.getElementById('remote-error'),
            back: document.getElementById('remote-back-btn'),
            home: document.getElementById('remote-home-btn'),
            recents: document.getElementById('remote-recents-btn'),
            targetInfo: document.getElementById('remote-target-info')
        };
        if (!els.connect) return null;

        // 显式设置 Host 信息
        if (els.targetInfo) {
            els.targetInfo.textContent = 'Host: ' + window.location.host;
        }

        remote.setCanvas(els.canvas);
        remote.onStatusChange = (status, err) => {
            els.statusDot.className = 'remote-status-dot ' + status;
            if (status === 'connected') {
                els.statusText.textContent = '已连接';
                els.connect.style.display = 'none'; els.disconnect.style.display = 'inline-flex';
                els.placeholder.style.display = 'none'; els.canvas.style.display = 'block';
                [els.back, els.home, els.recents].forEach(b => b.disabled = false);
            } else {
                els.statusText.textContent = status === 'error' ? '错误' : '未连接';
                els.connect.style.display = 'inline-flex'; els.connect.disabled = false;
                els.disconnect.style.display = 'none'; els.placeholder.style.display = 'flex';
                els.canvas.style.display = 'none';
                if (err) { els.error.textContent = err; els.error.style.display = 'block'; }
            }
        };
        remote.onFpsUpdate = (fps) => { els.fps.textContent = fps + ' FPS'; };
        els.connect.onclick = async () => { els.error.style.display = 'none'; els.connect.disabled = true; try { await remote.connect(); } catch (e) {} };
        els.disconnect.onclick = () => remote.disconnect();
        els.back.onclick = () => remote.sendKey(KEYCODE.BACK);
        els.home.onclick = () => remote.sendKey(KEYCODE.HOME);
        els.recents.onclick = () => remote.sendKey(KEYCODE.APP_SWITCH);
        return remote;
    };
})();
