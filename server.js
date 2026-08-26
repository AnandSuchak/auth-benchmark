const express = require('express');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001; // Port 3001 to prevent conflicts
const SECRET = 'a_very_secure_256_bit_symmetric_secret_key_for_hmac_sha256_benchmarking';

// Mock session store: 10,000 active session records
const activeSessions = new Set();
for (let i = 0; i < 10000; i++) {
    activeSessions.add(`session_token_${i}`);
}

// Helper for synthetic session-store delay
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- SERVER-SIDE HEALTH METRICS ---
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = process.hrtime();

function getCpuUsagePercent() {
    const elapCpu = process.cpuUsage(lastCpuUsage);
    const elapTime = process.hrtime(lastCpuTime);
    lastCpuUsage = process.cpuUsage();
    lastCpuTime = process.hrtime();
    
    const elapTimeMs = elapTime[0] * 1000 + elapTime[1] / 1000000;
    const elapUserMs = elapCpu.user / 1000;
    const elapSystMs = elapCpu.system / 1000;
    const cpuPercent = (100 * (elapUserMs + elapSystMs)) / elapTimeMs;
    return parseFloat(cpuPercent.toFixed(2));
}

// Expose server metrics to benchmark runner
app.get('/metrics', (req, res) => {
    const memory = process.memoryUsage();
    res.status(200).json({
        cpu: getCpuUsagePercent(),
        rss: parseFloat((memory.rss / 1024 / 1024).toFixed(2)),
        heapUsed: parseFloat((memory.heapUsed / 1024 / 1024).toFixed(2))
    });
});

// 1. No-Auth Baseline route
app.get('/auth/none', (req, res) => {
    res.status(200).json({ status: 'ok', mode: 'none' });
});

// 2. Stateless JWT route
app.get('/auth/jwt', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    try {
        jwt.verify(token, SECRET);
        res.status(200).json({ status: 'ok', mode: 'jwt' });
    } catch (err) {
        res.status(403).json({ error: 'Invalid token' });
    }
});

// 3. Stateful Session route with configurable latency via query parameter (?delay=ms)
app.get('/auth/stateful', async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const delay = parseInt(req.query.delay) || 10;

    if (!sessionId) {
        return res.status(401).json({ error: 'No session id provided' });
    }

    if (delay > 0) {
        await wait(delay);
    }

    if (activeSessions.has(sessionId)) {
        res.status(200).json({ status: 'ok', mode: 'stateful' });
    } else {
        res.status(403).json({ error: 'Invalid session' });
    }
});

app.listen(PORT, () => {
    console.log(`Advanced benchmark server running on port ${PORT}`);
});
