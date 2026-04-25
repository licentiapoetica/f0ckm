import tls from "tls";
import net from "net";
import { Buffer } from "buffer";

export const sendMail = (config, options) => {
    return new Promise((resolve, reject) => {
        const { host, port, secure, user, password, from } = config;
        const { to, subject, body } = options;

        let socket;
        let step = 0;

        const connect = () => {
            if (secure) {
                socket = tls.connect(port, host, () => {
                    console.log(`[SMTP] Securely connected to ${host}:${port}`);
                });
            } else {
                socket = net.connect(port, host, () => {
                    console.log(`[SMTP] Connected to ${host}:${port}`);
                });
            }

            socket.on("data", onData);
            socket.on("error", (err) => reject(err));
            socket.on("timeout", () => {
                socket.destroy();
                reject(new Error("SMTP Timeout"));
            });
        };

        const send = (data) => {
            socket.write(data + "\r\n");
        };

        const onData = (data) => {
            const response = data.toString();
            // console.log(`[SMTP] step ${step} server: ${response.trim()}`);

            if (response.startsWith("220") && step === 0) {
                send(`EHLO ${host}`);
                step = 1;
            } else if (response.startsWith("250") && step === 1) {
                if (!secure && response.includes("STARTTLS")) {
                    send("STARTTLS");
                    step = 1.5;
                } else {
                    handleAuth();
                }
            } else if (response.startsWith("220") && step === 1.5) {
                // Upgrade to TLS
                const secureSocket = tls.connect({
                    socket: socket,
                    host: host
                }, () => {
                    // console.log("[SMTP] STARTTLS successful");
                });
                socket.removeAllListeners("data");
                socket = secureSocket;
                socket.on("data", onData);
                socket.on("error", (err) => reject(err));
                send(`EHLO ${host}`);
                step = 1.9;
            } else if (response.startsWith("250") && step === 1.9) {
                handleAuth();
            } else if (response.startsWith("334") && step === 2) {
                send(Buffer.from(user).toString("base64"));
                step = 3;
            } else if (response.startsWith("334") && step === 3) {
                send(Buffer.from(password).toString("base64"));
                step = 4;
            } else if (response.startsWith("235") && step === 4) {
                send(`MAIL FROM:<${from}>`);
                step = 5;
            } else if (response.startsWith("250") && (step === 4 || step === 5)) {
                // If we didn't use AUTH, we might land here after MAIL FROM
                if (step === 4) {
                    send(`MAIL FROM:<${from}>`);
                    step = 5;
                } else {
                    send(`RCPT TO:<${to}>`);
                    step = 6;
                }
            } else if (response.startsWith("250") && step === 6) {
                send("DATA");
                step = 7;
            } else if (response.startsWith("354") && step === 7) {
                const message = [
                    `From: ${from}`,
                    `To: ${to}`,
                    `Subject: ${subject}`,
                    `Content-Type: text/plain; charset=UTF-8`,
                    "",
                    body,
                    "."
                ].join("\r\n");
                send(message);
                step = 8;
            } else if (response.startsWith("250") && step === 8) {
                send("QUIT");
                resolve(true);
            } else if (response.startsWith("5") || response.startsWith("4")) {
                reject(new Error(`SMTP Error: ${response.trim()}`));
            }
        };

        const handleAuth = () => {
            if (user && password) {
                send("AUTH LOGIN");
                step = 2;
            } else {
                send(`MAIL FROM:<${from}>`);
                step = 5;
            }
        };

        connect();
    });
};
