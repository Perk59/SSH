const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

// デバッグ用のログ関数
function log(message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
}

wss.on('connection', (ws) => {
    log('New WebSocket connection established');
    let sshClient = null;

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            log('Received message:', data.type);
        } catch (err) {
            log('Failed to parse message:', err);
            return;
        }

        if (data.type === 'connect') {
            log('Attempting SSH connection to:', data.host);

            sshClient = new Client();

            const config = {
                host: data.host,
                port: parseInt(data.port) || 22,
                username: data.username,
                // SSH接続のデバッグモードを有効化
                debug: (message) => log('SSH Debug:', message)
            };

            // 認証設定
            if (data.authType === 'password') {
                config.password = data.password;
            } else {
                try {
                    config.privateKey = data.privateKey;
                    if (data.passphrase) {
                        config.passphrase = data.passphrase;
                    }
                } catch (err) {
                    log('Private key configuration error:', err);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Private key configuration failed: ' + err.message
                    }));
                    return;
                }
            }

            sshClient
                .on('ready', () => {
                    log('SSH connection established');
                    ws.send(JSON.stringify({
                        type: 'data',
                        data: '\r\n接続成功！\r\n'
                    }));

                    sshClient.shell((err, stream) => {
                        if (err) {
                            log('Shell creation error:', err);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Failed to create shell: ' + err.message
                            }));
                            return;
                        }

                        stream.on('data', (data) => {
                            log('Received data from shell');
                            ws.send(JSON.stringify({
                                type: 'data',
                                data: data.toString('utf8')
                            }));
                        });

                        stream.stderr.on('data', (data) => {
                            log('Received stderr data:', data.toString());
                            ws.send(JSON.stringify({
                                type: 'data',
                                data: data.toString('utf8')
                            }));
                        });

                        stream.on('close', () => {
                            log('Shell stream closed');
                            sshClient.end();
                        });

                        stream.on('error', (err) => {
                            log('Shell stream error:', err);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Shell error: ' + err.message
                            }));
                        });

                        ws.on('message', (message) => {
                            const data = JSON.parse(message);
                            if (data.type === 'data') {
                                stream.write(data.data);
                            }
                        });
                    });
                })
                .on('error', (err) => {
                    log('SSH connection error:', err);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'SSH connection failed: ' + err.message
                    }));
                })
                .on('close', () => {
                    log('SSH connection closed');
                    ws.send(JSON.stringify({
                        type: 'data',
                        data: '\r\n接続が閉じられました。\r\n'
                    }));
                })
                .connect(config);
        }
    });

    ws.on('error', (err) => {
        log('WebSocket error:', err);
    });

    ws.on('close', () => {
        log('WebSocket connection closed');
        if (sshClient) {
            sshClient.end();
        }
    });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
    log(`Server running on port ${port}`);
});
