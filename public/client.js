class SSHClient {
    constructor() {
        // 基本的なターミナル設定
        this.term = new Terminal({
            cursorBlink: true,
            theme: {
                background: '#1e1e1e',
                foreground: '#ffffff'
            },
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            allowTransparency: true,
            scrollback: 10000,
            convertEol: true
        });

        // アドオンとステート管理
        this.fitAddon = new FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.connections = this.loadConnections();
        this.currentConnection = null;
        this.currentWs = null;
        this.dataListener = null;
        this.disposables = new Set();
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;

        // UIの初期化
        this.initializeUI();
    }

    initializeUI() {
        const terminalElement = document.getElementById('terminal');
        if (!terminalElement) {
            console.error('Terminal element not found');
            return;
        }

        this.term.open(terminalElement);
        this.fitAddon.fit();

        // ページを離れる前のクリーンアップ
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });

        this.setupEventListeners();
        this.renderConnectionList();
    }

    setupEventListeners() {
        // 認証タイプの切り替え
        const authTypeSelect = document.getElementById('authType');
        authTypeSelect?.addEventListener('change', (e) => {
            const passwordAuth = document.getElementById('passwordAuth');
            const keyAuth = document.getElementById('keyAuth');
            if (!passwordAuth || !keyAuth) return;

            const isPassword = e.target.value === 'password';
            passwordAuth.style.display = isPassword ? 'block' : 'none';
            keyAuth.style.display = isPassword ? 'none' : 'block';
        });

        // ファイル選択のハンドリング
        const privateKeyFile = document.getElementById('privateKeyFile');
        privateKeyFile?.addEventListener('change', this.handleFileSelect.bind(this));

        // ボタンのイベントハンドリング
        const connectButton = document.getElementById('connect');
        connectButton?.addEventListener('click', this.connect.bind(this));

        const saveButton = document.getElementById('saveConnection');
        saveButton?.addEventListener('click', this.saveCurrentConnection.bind(this));

        const newButton = document.getElementById('newConnection');
        newButton?.addEventListener('click', this.clearForm.bind(this));

        // ウィンドウリサイズ対応
        const debouncedFit = this.debounce(() => this.fitAddon.fit(), 100);
        window.addEventListener('resize', debouncedFit);
    }

    // LocalStorageとの連携
    loadConnections() {
        try {
            const saved = localStorage.getItem('sshConnections');
            return saved ? JSON.parse(saved) : [];
        } catch (error) {
            console.error('Failed to load connections:', error);
            return [];
        }
    }

    saveConnections() {
        try {
            localStorage.setItem('sshConnections', JSON.stringify(this.connections));
        } catch (error) {
            console.error('Failed to save connections:', error);
        }
    }

    renderConnectionList() {
        const connectionList = document.getElementById('connectionList');
        if (!connectionList) return;

        connectionList.innerHTML = this.connections.map((conn, index) => `
            <div class="connection-item" data-index="${index}">
                <span>${this.escapeHtml(conn.name)}</span>
                <div class="connection-actions">
                    <button class="action-button connect-saved" title="接続">
                        <span class="material-icons">play_arrow</span>
                    </button>
                    <button class="action-button edit-saved" title="編集">
                        <span class="material-icons">edit</span>
                    </button>
                    <button class="action-button delete-saved" title="削除">
                        <span class="material-icons">delete</span>
                    </button>
                </div>
            </div>
        `).join('');

        // イベントリスナーの設定
        connectionList.querySelectorAll('.connection-item').forEach(item => {
            const index = parseInt(item.dataset.index);

            item.querySelector('.connect-saved')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.loadConnection(index);
                this.connect();
            });

            item.querySelector('.edit-saved')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.loadConnection(index);
            });

            item.querySelector('.delete-saved')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteConnection(index);
            });
        });
    }

    async handleFileSelect(e) {
        const file = e.target.files?.[0];
        const selectedFileName = document.getElementById('selectedFileName');
        const privateKeyInput = document.getElementById('privateKey');

        if (!selectedFileName || !privateKeyInput) return;

        if (file) {
            selectedFileName.textContent = file.name;
            try {
                const text = await file.text();
                privateKeyInput.value = text;
            } catch (error) {
                console.error('Error reading file:', error);
                alert('ファイルの読み込みに失敗しました。');
                selectedFileName.textContent = 'ファイルが選択されていません';
                privateKeyInput.value = '';
            }
        } else {
            selectedFileName.textContent = 'ファイルが選択されていません';
            privateKeyInput.value = '';
        }
    }

    getFormData() {
        return {
            name: document.getElementById('connectionName')?.value || '',
            host: document.getElementById('host')?.value || '',
            username: document.getElementById('username')?.value || '',
            port: document.getElementById('port')?.value || '22',
            authType: document.getElementById('authType')?.value || 'password',
            password: document.getElementById('password')?.value || '',
            privateKey: document.getElementById('privateKey')?.value || '',
            passphrase: document.getElementById('passphrase')?.value || ''
        };
    }

    setFormData(data) {
        const elements = {
            connectionName: document.getElementById('connectionName'),
            host: document.getElementById('host'),
            username: document.getElementById('username'),
            port: document.getElementById('port'),
            authType: document.getElementById('authType'),
            password: document.getElementById('password'),
            privateKey: document.getElementById('privateKey'),
            passphrase: document.getElementById('passphrase'),
            passwordAuth: document.getElementById('passwordAuth'),
            keyAuth: document.getElementById('keyAuth')
        };

        // 各フィールドの値を設定
        Object.entries(elements).forEach(([key, element]) => {
            if (element && key in data) {
                element.value = data[key] || '';
            }
        });

        // 認証方式に応じた表示切り替え
        if (elements.passwordAuth && elements.keyAuth) {
            const isPassword = data.authType === 'password';
            elements.passwordAuth.style.display = isPassword ? 'block' : 'none';
            elements.keyAuth.style.display = isPassword ? 'none' : 'block';
        }
    }

    saveCurrentConnection() {
        const data = this.getFormData();
        if (!data.name || !data.host || !data.username) {
            alert('接続名、ホスト名、ユーザー名は必須です。');
            return;
        }

        const existingIndex = this.connections.findIndex(conn => conn.name === data.name);
        if (existingIndex >= 0) {
            this.connections[existingIndex] = data;
        } else {
            this.connections.push(data);
        }

        this.saveConnections();
        this.renderConnectionList();
        alert('接続情報を保存しました。');
    }

    loadConnection(index) {
        const connection = this.connections[index];
        if (connection) {
            this.setFormData(connection);
        }
    }

    deleteConnection(index) {
        if (confirm('この接続を削除してもよろしいですか？')) {
            this.connections.splice(index, 1);
            this.saveConnections();
            this.renderConnectionList();
        }
    }

    clearForm() {
        this.setFormData({
            name: '',
            host: '',
            username: '',
            port: '22',
            authType: 'password',
            password: '',
            privateKey: '',
            passphrase: ''
        });
    }

    cleanup() {
        // WebSocket接続のクリーンアップ
        if (this.currentWs) {
            if (this.currentWs.readyState === WebSocket.OPEN) {
                this.currentWs.close();
            }
            this.currentWs = null;
        }

        // イベントリスナーのクリーンアップ
        this.disposables.forEach(disposable => {
            try {
                disposable.dispose();
            } catch (error) {
                console.error('Error disposing listener:', error);
            }
        });
        this.disposables.clear();
        this.dataListener = null;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
    }

    async connect() {
        if (this.isConnecting) {
            console.log('Connection already in progress');
            return;
        }

        const data = this.getFormData();
        if (!data.host || !data.username) {
            alert('ホスト名とユーザー名は必須です。');
            return;
        }

        this.cleanup();
        this.isConnecting = true;

        try {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ssh`;
            console.log('Connecting to WebSocket:', wsUrl);

            const ws = new WebSocket(wsUrl);
            this.currentWs = ws;

            ws.onopen = () => {
                console.log('WebSocket connection established');
                ws.send(JSON.stringify({
                    type: 'connect',
                    ...data
                }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'error') {
                        console.error('Received error:', data.message);
                        this.term.write(`\r\nError: ${data.message}\r\n`);
                        return;
                    }
                    this.term.write(data.data);
                } catch (e) {
                    console.log('Received raw data:', event.data);
                    this.term.write(event.data);
                }
            };

            this.dataListener = (data) => {
                if (ws?.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'data', data }));
                }
            };

            const disposable = this.term.onData(this.dataListener);
            this.disposables.add(disposable);

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.term.write(`\r\nWebSocket Error: ${error.message}\r\n`);
                this.handleConnectionError();
            };

            ws.onclose = (event) => {
                console.log('WebSocket closed:', event.code, event.reason);
                this.term.write(`\r\n接続が閉じられました。(コード: ${event.code}${event.reason ? `, 理由: ${event.reason}` : ''})\r\n`);
                this.handleConnectionError();
            };
        } catch (error) {
            console.error('Connection setup error:', error);
            this.term.write(`\r\n接続設定エラー: ${error.message}\r\n`);
            this.handleConnectionError();
        }
    }

    handleConnectionError() {
        this.isConnecting = false;
        this.cleanup();
    }

    // ユーティリティメソッド
    debounce(func, wait) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    escapeHtml(string) {
        const div = document.createElement('div');
        div.textContent = string;
        return div.innerHTML;
    }

    dispose() {
        this.cleanup();
        if (this.term) {
            try {
                this.term.dispose();
            } catch (error) {
                console.error('Error disposing terminal:', error);
            }
        }
    }
}

// アプリケーションのインスタンス管理
let sshClient;

// 初期化
window.addEventListener('load', () => {
    try {
        sshClient = new SSHClient();
    } catch (error) {
        console.error('Failed to initialize SSH client:', error);
    }
});

// クリーンアップ
window.addEventListener('beforeunload', () => {
    if (sshClient) {
        sshClient.dispose();
    }
});
