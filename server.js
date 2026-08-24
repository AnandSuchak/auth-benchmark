const express = require('express');
const jwt = require('jsonwebtoken');
const autocannon = require('autocannon');
const path = require('path');

const app = express();
const PORT = 3001;

// Body parser
app.use(express.json());

// --- SECRET & DATABASE STATE ---
let SECRET_KEY = 'super-secret-key-v1';
let secretVersion = 1;
let activeSessionsDB = new Set();

function resetDatabase() {
    activeSessionsDB.clear();
    for (let i = 0; i < 10000; i++) {
        activeSessionsDB.add(`session_${i}`);
    }
    activeSessionsDB.add('valid_session_1234');
}
resetDatabase();

// --- CPU TRACKING FOR METRICS ---
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

// --- SAFETY LOCK FOR BENCHMARK ---
let isBenchmarking = false;
let currentAutocannonInstance = null;

// --- ENDPOINT A: STATEFUL AUTHENTICATION ---
app.get('/api/v1/data-stateful', async (req, res) => {
    const sessionId = req.headers['authorization'];
    
    if (!sessionId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 🔴 THE BOTTLENECK: Simulate a 10ms database network & lookup latency
    await new Promise(resolve => setTimeout(resolve, 10)); 

    if (activeSessionsDB.has(sessionId)) {
        return res.status(200).json({ data: 'Inventory Data fetched (Stateful)' });
    } else {
        return res.status(401).json({ error: 'Session Invalid or Revoked' });
    }
});

// --- ENDPOINT B: STATELESS AUTHENTICATION ---
app.get('/api/v1/data-stateless', (req, res) => {
    const token = req.headers['authorization'];
    
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // 🟢 THE SOLUTION: Local CPU cryptographic check (0ms network latency)
        const decoded = jwt.verify(token, SECRET_KEY);
        return res.status(200).json({ data: 'Inventory Data fetched (Stateless)', user: decoded.id });
    } catch (err) {
        return res.status(401).json({ error: 'Token Invalid / Secret Rolled' });
    }
});

// --- API TO GET A VALID JWT TOKEN ---
app.get('/api/v1/token', (req, res) => {
    const token = jwt.sign({ id: 'agent_99' }, SECRET_KEY);
    res.json({ token });
});

// --- STATE CONTROL: REVOCATION & ROTATION ---
app.post('/api/v1/revoke-stateful', (req, res) => {
    activeSessionsDB.delete('valid_session_1234');
    res.json({ message: 'Stateful session (valid_session_1234) has been removed from DB' });
});

app.post('/api/v1/restore-stateful', (req, res) => {
    activeSessionsDB.add('valid_session_1234');
    res.json({ message: 'Stateful session (valid_session_1234) restored in DB' });
});

app.post('/api/v1/roll-key', (req, res) => {
    secretVersion++;
    SECRET_KEY = `super-secret-key-v${secretVersion}-${Date.now()}`;
    res.json({ message: 'Stateless secret rolled successfully', version: secretVersion });
});

// --- SYSTEM HEALTH METRICS ---
app.get('/api/v1/metrics', (req, res) => {
    const memory = process.memoryUsage();
    res.json({
        cpu: getCpuUsagePercent(),
        memory: {
            rss: parseFloat((memory.rss / 1024 / 1024).toFixed(2)), // MB
            heapUsed: parseFloat((memory.heapUsed / 1024 / 1024).toFixed(2)) // MB
        },
        activeSessionsCount: activeSessionsDB.size,
        secretVersion: secretVersion,
        isSessionValid: activeSessionsDB.has('valid_session_1234')
    });
});

// --- SSE BENCHMARK RUNNER ---
app.get('/api/v1/run-benchmark', (req, res) => {
    if (isBenchmarking) {
        return res.status(409).json({ error: 'A benchmark load test is already running. Please wait.' });
    }

    const type = req.query.type || 'stateful';
    const connections = parseInt(req.query.connections) || 100;
    const duration = parseInt(req.query.duration) || 10;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    isBenchmarking = true;
    sendSSE('status', { message: `Benchmarking /api/v1/data-${type} (connections: ${connections}, duration: ${duration}s)` });

    const targetUrl = `http://localhost:${PORT}/api/v1/data-${type}`;
    const headers = {};

    if (type === 'stateful') {
        headers['Authorization'] = 'valid_session_1234';
    } else {
        const token = jwt.sign({ id: 'agent_99' }, SECRET_KEY);
        headers['Authorization'] = token;
    }

    let tickRequests = 0;
    let tickTotalLatency = 0;
    let tickErrors = 0;

    currentAutocannonInstance = autocannon({
        url: targetUrl,
        connections: connections,
        duration: duration,
        headers: headers
    }, (err, results) => {
        isBenchmarking = false;
        currentAutocannonInstance = null;
        if (err) {
            sendSSE('error', { message: err.message });
            res.end();
            return;
        }
        sendSSE('done', results);
        res.end();
    });

    currentAutocannonInstance.on('response', (client, statusCode, resBytes, responseTime) => {
        tickRequests++;
        tickTotalLatency += responseTime;
        if (statusCode !== 200) {
            tickErrors++;
        }
    });

    currentAutocannonInstance.on('reqError', (err) => {
        tickErrors++;
    });

    autocannon.track(currentAutocannonInstance, { silent: true });

    currentAutocannonInstance.on('tick', (stats) => {
        const avgLatency = tickRequests > 0 ? parseFloat((tickTotalLatency / tickRequests).toFixed(2)) : 0;
        sendSSE('tick', {
            counter: stats.counter,
            requests: stats.counter,
            latency: avgLatency,
            errors: tickErrors,
            timeouts: 0
        });
        // Reset tick accumulators
        tickRequests = 0;
        tickTotalLatency = 0;
        tickErrors = 0;
    });
});

app.post('/api/v1/abort-benchmark', (req, res) => {
    if (currentAutocannonInstance) {
        currentAutocannonInstance.stop();
        isBenchmarking = false;
        currentAutocannonInstance = null;
        return res.json({ message: 'Benchmark aborted successfully.' });
    }
    res.status(400).json({ error: 'No benchmark is currently running.' });
});

// --- DASHBOARD UI PAGE ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Benchmarking System</title>
    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
    <!-- Chart.js CDN -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --bg-base: #070a13;
            --bg-surface: rgba(16, 22, 42, 0.7);
            --bg-card: rgba(22, 32, 60, 0.5);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            
            --stateful-accent: #ff4d4d;
            --stateful-gradient: linear-gradient(135deg, #ef4444, #f97316);
            --stateless-accent: #00f0ff;
            --stateless-gradient: linear-gradient(135deg, #10b981, #06b6d4);
            
            --primary: #3b82f6;
            --primary-gradient: linear-gradient(135deg, #3b82f6, #6366f1);
            --success: #10b981;
            --warning: #f59e0b;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            background-color: var(--bg-base);
            color: var(--text-primary);
            font-family: 'Plus Jakarta Sans', sans-serif;
            min-height: 100vh;
            padding-bottom: 2rem;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.08) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.06) 0%, transparent 45%);
            background-attachment: fixed;
        }

        header {
            border-bottom: 1px solid var(--border-color);
            padding: 1.5rem 2rem;
            backdrop-filter: blur(12px);
            position: sticky;
            top: 0;
            z-index: 100;
            background: rgba(7, 10, 19, 0.8);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header-title h1 {
            font-family: 'Outfit', sans-serif;
            font-size: 1.5rem;
            font-weight: 700;
            background: linear-gradient(135deg, #fff 0%, #94a3b8 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .badge-live {
            background: rgba(16, 185, 129, 0.15);
            color: var(--success);
            padding: 0.25rem 0.6rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            border: 1px solid rgba(16, 185, 129, 0.2);
        }

        .badge-live::before {
            content: '';
            display: inline-block;
            width: 6px;
            height: 6px;
            background-color: var(--success);
            border-radius: 50%;
            animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(0.9); opacity: 0.6; }
            50% { transform: scale(1.3); opacity: 1; }
            100% { transform: scale(0.9); opacity: 0.6; }
        }

        .tabs {
            display: flex;
            gap: 0.5rem;
        }

        .tab-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--text-secondary);
            padding: 0.5rem 1rem;
            border-radius: 8px;
            cursor: pointer;
            font-family: inherit;
            font-weight: 500;
            transition: all 0.3s ease;
        }

        .tab-btn:hover {
            color: var(--text-primary);
            background: rgba(255, 255, 255, 0.03);
        }

        .tab-btn.active {
            color: var(--text-primary);
            background: rgba(255, 255, 255, 0.08);
            border-color: var(--border-color);
        }

        main {
            max-width: 1400px;
            margin: 2rem auto 0 auto;
            padding: 0 1.5rem;
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
            animation: fadeIn 0.4s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* --- DASHBOARD GRID --- */
        .dash-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 1.5rem;
        }

        @media (min-width: 1024px) {
            .dash-grid {
                grid-template-columns: 350px 1fr;
            }
        }

        /* --- CARDS & MODULES --- */
        .panel {
            background: var(--bg-surface);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 1.5rem;
            backdrop-filter: blur(8px);
            box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5);
        }

        .panel-title {
            font-family: 'Outfit', sans-serif;
            font-size: 1.15rem;
            font-weight: 600;
            margin-bottom: 1.25rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 0.75rem;
        }

        /* --- FORM ELEMENTS --- */
        .form-group {
            margin-bottom: 1.25rem;
        }

        .form-group label {
            display: block;
            font-size: 0.85rem;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
            font-weight: 500;
        }

        .btn-group-toggle {
            display: grid;
            grid-template-columns: 1fr 1fr;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 8px;
            padding: 0.25rem;
            border: 1px solid var(--border-color);
        }

        .toggle-btn {
            background: transparent;
            border: none;
            color: var(--text-secondary);
            padding: 0.6rem;
            font-weight: 600;
            font-size: 0.85rem;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s ease;
            font-family: inherit;
        }

        .toggle-btn.active.stateful {
            background: var(--stateful-gradient);
            color: #fff;
            box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);
        }

        .toggle-btn.active.stateless {
            background: var(--stateless-gradient);
            color: #030712;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.2);
        }

        .slider-container {
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .slider-container input[type="range"] {
            flex-grow: 1;
            height: 6px;
            border-radius: 9999px;
            appearance: none;
            background: rgba(255, 255, 255, 0.1);
            outline: none;
            cursor: pointer;
        }

        .slider-container input[type="range"]::-webkit-slider-thumb {
            appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--primary);
            cursor: pointer;
            box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);
            transition: all 0.2s ease;
        }

        .slider-container input[type="range"]::-webkit-slider-thumb:hover {
            transform: scale(1.2);
        }

        .slider-val {
            font-family: 'Fira Code', monospace;
            font-size: 0.9rem;
            color: var(--text-primary);
            min-width: 45px;
            text-align: right;
        }

        /* --- BUTTONS --- */
        .btn {
            width: 100%;
            border: none;
            border-radius: 8px;
            padding: 0.75rem 1.5rem;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            transition: all 0.3s ease;
        }

        .btn-primary {
            background: var(--primary-gradient);
            color: #fff;
            box-shadow: 0 4px 14px rgba(59, 130, 246, 0.3);
        }

        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4);
        }

        .btn-secondary {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
        }

        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.08);
        }

        .btn-abort {
            background: rgba(239, 68, 68, 0.1);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.2);
            display: none;
        }

        .btn-abort:hover {
            background: rgba(239, 68, 68, 0.2);
        }

        /* --- METRICS CARDS --- */
        .metrics-summary {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 1rem;
            margin-bottom: 1.5rem;
        }

        @media (min-width: 640px) {
            .metrics-summary {
                grid-template-columns: repeat(4, 1fr);
            }
        }

        .metric-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 1rem;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
        }

        .metric-label {
            font-size: 0.75rem;
            color: var(--text-secondary);
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .metric-val {
            font-family: 'Outfit', sans-serif;
            font-size: 1.6rem;
            font-weight: 700;
            margin-top: 0.25rem;
        }

        .metric-card.stateful-theme .metric-val {
            color: var(--stateful-accent);
        }

        .metric-card.stateless-theme .metric-val {
            color: var(--stateless-accent);
        }

        /* --- LIVE STATUS BAR --- */
        .status-container {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 1rem;
            margin-bottom: 1.5rem;
        }

        @media (min-width: 768px) {
            .status-container {
                grid-template-columns: repeat(4, 1fr);
            }
        }

        .status-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 0.75rem 1rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .status-icon {
            font-size: 1.25rem;
        }

        .status-info {
            display: flex;
            flex-direction: column;
        }

        .status-label {
            font-size: 0.7rem;
            color: var(--text-muted);
            text-transform: uppercase;
            font-weight: 600;
        }

        .status-value {
            font-size: 0.9rem;
            font-weight: 600;
            font-family: 'Fira Code', monospace;
        }

        /* --- TERMINAL WINDOW --- */
        .terminal {
            background: #02050b;
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 1rem;
            font-family: 'Fira Code', monospace;
            font-size: 0.8rem;
            color: #bbf7d0; /* light green */
            height: 200px;
            overflow-y: auto;
            margin-top: 1.5rem;
            line-height: 1.5;
            box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.8);
        }

        .terminal .err { color: #fecaca; }
        .terminal .info { color: #e2e8f0; }
        .terminal .sys { color: #93c5fd; }

        /* --- GRAPH AREA --- */
        .chart-wrapper {
            position: relative;
            width: 100%;
            height: 320px;
            margin-bottom: 1rem;
        }

        .chart-container-split {
            display: grid;
            grid-template-columns: 1fr;
            gap: 1.5rem;
        }

        @media (min-width: 1024px) {
            .chart-container-split {
                grid-template-columns: 1fr 1fr;
            }
        }

        /* --- SANDBOX & ARCHITECTURE STYLING --- */
        .sandbox-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 1.5rem;
        }

        @media (min-width: 768px) {
            .sandbox-grid {
                grid-template-columns: 1fr 1fr;
            }
        }

        .action-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 1.5rem;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            gap: 1.25rem;
            position: relative;
            overflow: hidden;
        }

        .action-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 4px;
            height: 100%;
        }

        .action-card.stateful-theme::before {
            background: var(--stateful-gradient);
        }

        .action-card.stateless-theme::before {
            background: var(--stateless-gradient);
        }

        .card-header-badge {
            font-size: 0.7rem;
            text-transform: uppercase;
            font-weight: 700;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            letter-spacing: 0.05em;
        }

        .stateful-theme .card-header-badge {
            background: rgba(239, 68, 68, 0.1);
            color: var(--stateful-accent);
        }

        .stateless-theme .card-header-badge {
            background: rgba(16, 185, 129, 0.1);
            color: var(--stateless-accent);
        }

        .latency-result-box {
            background: rgba(0, 0, 0, 0.3);
            border: 1px dashed var(--border-color);
            border-radius: 8px;
            padding: 1rem;
            min-height: 120px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            font-family: 'Fira Code', monospace;
            font-size: 0.85rem;
        }

        .latency-num {
            font-family: 'Outfit', sans-serif;
            font-size: 2.2rem;
            font-weight: 800;
            margin: 0.25rem 0;
        }

        .latency-num.success { color: var(--success); }
        .latency-num.fail { color: var(--stateful-accent); }

        .arch-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
            font-size: 0.9rem;
        }

        .arch-table th, .arch-table td {
            padding: 0.8rem 1rem;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }

        .arch-table th {
            color: var(--text-secondary);
            font-weight: 600;
            background: rgba(255, 255, 255, 0.02);
        }

        .arch-table td strong {
            color: var(--text-primary);
        }

        .text-green { color: var(--success); }
        .text-red { color: #f87171; }
        .text-blue { color: var(--primary); }

        .badge {
            padding: 0.15rem 0.4rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
        }
        .badge-red { background: rgba(239, 68, 68, 0.15); color: #f87171; }
        .badge-green { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    </style>
</head>
<body>

    <header>
        <div class="header-title">
            <h1>🛡️ Authentication Benchmarking Suite</h1>
        </div>
        <div class="tabs">
            <button class="tab-btn active" onclick="switchTab('benchmark')">⚡ Load Benchmarking</button>
            <button class="tab-btn" onclick="switchTab('sandbox')">🛑 Revocation Sandbox</button>
            <button class="tab-btn" onclick="switchTab('architecture')">📖 Technical Architecture</button>
        </div>
        <div class="badge-live">Server Live</div>
    </header>

    <main>
        <!-- --- LIVE METRICS BAR (SHARED) --- -->
        <div class="status-container">
            <div class="status-card">
                <span class="status-icon">💻</span>
                <div class="status-info">
                    <span class="status-label">Server CPU</span>
                    <span class="status-value" id="status-cpu">0.0%</span>
                </div>
            </div>
            <div class="status-card">
                <span class="status-icon">🧠</span>
                <div class="status-info">
                    <span class="status-label">Memory RSS</span>
                    <span class="status-value" id="status-mem">0.0 MB</span>
                </div>
            </div>
            <div class="status-card">
                <span class="status-icon">🗄️</span>
                <div class="status-info">
                    <span class="status-label">Active Sessions</span>
                    <span class="status-value" id="status-sessions">0</span>
                </div>
            </div>
            <div class="status-card">
                <span class="status-icon">🔑</span>
                <div class="status-info">
                    <span class="status-label">Secret Version</span>
                    <span class="status-value" id="status-secret-ver">1</span>
                </div>
            </div>
        </div>

        <!-- ================= BENCHMARK TAB ================= -->
        <div id="tab-benchmark" class="tab-content active">
            <div class="dash-grid">
                <!-- CONTROLS SIDEBAR -->
                <div class="panel">
                    <div class="panel-title">Test Runner</div>
                    <form id="benchmark-form" onsubmit="event.preventDefault(); startBenchmark();">
                        <div class="form-group">
                            <label>Target Endpoint Type</label>
                            <div class="btn-group-toggle">
                                <button type="button" id="toggle-stateful" class="toggle-btn active stateful" onclick="setTarget('stateful')">Stateful DB</button>
                                <button type="button" id="toggle-stateless" class="toggle-btn stateless" onclick="setTarget('stateless')">Stateless JWT</button>
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Concurrent Connections (VUs)</label>
                            <div class="slider-container">
                                <input type="range" id="connections-input" min="10" max="500" step="10" value="100" oninput="document.getElementById('connections-val').innerText = this.value">
                                <span class="slider-val" id="connections-val">100</span>
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Duration (Seconds)</label>
                            <div class="slider-container">
                                <input type="range" id="duration-input" min="5" max="30" step="5" value="10" oninput="document.getElementById('duration-val').innerText = this.value">
                                <span class="slider-val" id="duration-val">10</span>
                            </div>
                        </div>

                        <button type="submit" id="run-btn" class="btn btn-primary">🚀 Run Benchmark</button>
                        <button type="button" id="abort-btn" class="btn btn-abort" onclick="abortBenchmark()">🛑 Abort Load Test</button>
                    </form>
                    
                    <div class="terminal" id="term">
                        <span class="sys">System Ready. Choose options and click 'Run Benchmark'.</span><br>
                    </div>
                </div>

                <!-- CHARTS & SUMMARY CONTENT -->
                <div style="display: flex; flex-direction: column; gap: 1.5rem;">
                    <!-- METRICS HEADER CARDS -->
                    <div class="metrics-summary">
                        <div class="metric-card" id="theme-card-rps">
                            <span class="metric-label">Throughput (RPS)</span>
                            <span class="metric-val" id="metric-rps">-</span>
                        </div>
                        <div class="metric-card" id="theme-card-latency">
                            <span class="metric-label">Mean Latency</span>
                            <span class="metric-val" id="metric-latency-avg">-</span>
                        </div>
                        <div class="metric-card" id="theme-card-p95">
                            <span class="metric-label">p95 Latency</span>
                            <span class="metric-val" id="metric-latency-p95">-</span>
                        </div>
                        <div class="metric-card" id="theme-card-errors">
                            <span class="metric-label">Error Rate</span>
                            <span class="metric-val" id="metric-errors">-</span>
                        </div>
                    </div>

                    <!-- PERFORMANCE GRAPHS -->
                    <div class="panel">
                        <div class="panel-title">Performance Chart (Real-time Load Statistics)</div>
                        <div class="chart-wrapper">
                            <canvas id="benchmarkChart"></canvas>
                        </div>
                    </div>
                    
                    <div class="chart-container-split">
                        <div class="panel">
                            <div class="panel-title">Server CPU Consumption</div>
                            <div class="chart-wrapper" style="height: 200px;">
                                <canvas id="cpuChart"></canvas>
                            </div>
                        </div>
                        <div class="panel">
                            <div class="panel-title">Server Memory Footprint</div>
                            <div class="chart-wrapper" style="height: 200px;">
                                <canvas id="memChart"></canvas>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- ================= SANDBOX TAB ================= -->
        <div id="tab-sandbox" class="tab-content">
            <div class="panel" style="margin-bottom: 1.5rem;">
                <div class="panel-title">Real-time Revocation Sandbox</div>
                <p style="color: var(--text-secondary); margin-bottom: 1.5rem; line-height: 1.6;">
                    One of the main trade-offs between Stateful and Stateless auth is <strong>Revocation Latency</strong>. 
                    In a stateful database setup, removing a session ID immediately invalidates it, but incurs validation latency.
                    In a stateless setup, the validation is local (signature checking), but revoking a token before expiry requires key rotation or blacklisting.
                    <strong>Measure Revocation Latency</strong> starts checking the API every 30ms, triggers revocation/key rotation, and measures the elapsed time to receive the first 401 Unauthorized status.
                </p>
                
                <div class="sandbox-grid">
                    <!-- STATEFUL WORKSPACE -->
                    <div class="action-card stateful-theme">
                        <div>
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                                <h3 style="font-family: 'Outfit';">Endpoint A: Stateful DB Auth</h3>
                                <span class="card-header-badge">Stateful</span>
                            </div>
                            <p style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 1rem; line-height: 1.4;">
                                Checked against database. We simulate removing the active session ID <code>valid_session_1234</code>.
                            </p>
                        </div>
                        
                        <div class="latency-result-box" id="stateful-rev-box">
                            <span style="color: var(--text-secondary);">Stateful Revocation Status</span>
                            <span class="latency-num" id="stateful-latency-val">-</span>
                            <span style="color: var(--text-muted);" id="stateful-details-val">Click test to start</span>
                        </div>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;">
                            <button class="btn btn-secondary" onclick="controlSession('restore')">Recreate Session</button>
                            <button class="btn btn-primary" style="background: var(--stateful-gradient);" onclick="measureRevocationLatency('stateful')">Measure Latency</button>
                        </div>
                    </div>

                    <!-- STATELESS WORKSPACE -->
                    <div class="action-card stateless-theme">
                        <div>
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                                <h3 style="font-family: 'Outfit';">Endpoint B: Stateless JWT Auth</h3>
                                <span class="card-header-badge">Stateless</span>
                            </div>
                            <p style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 1rem; line-height: 1.4;">
                                Signature verified locally on CPU. We simulate revocation via <strong>Key Rotation</strong>, rolling the server verification secret.
                            </p>
                        </div>
                        
                        <div class="latency-result-box" id="stateless-rev-box">
                            <span style="color: var(--text-secondary);">Stateless Key Rotation Status</span>
                            <span class="latency-num" id="stateless-latency-val">-</span>
                            <span style="color: var(--text-muted);" id="stateless-details-val">Click test to start</span>
                        </div>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;">
                            <button class="btn btn-secondary" onclick="controlSession('roll')">Roll Secret Key</button>
                            <button class="btn btn-primary" style="background: var(--stateless-gradient); color: #030712;" onclick="measureRevocationLatency('stateless')">Measure Latency</button>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="panel">
                <div class="panel-title">Revocation Log Output</div>
                <div class="terminal" id="sandbox-term" style="height: 150px;">
                    <span class="sys">Ready. Click 'Measure Latency' on either method.</span><br>
                </div>
            </div>
        </div>

        <!-- ================= ARCHITECTURE TAB ================= -->
        <div id="tab-architecture" class="tab-content">
            <div class="panel">
                <div class="panel-title">Comparison Matrix & Trade-offs</div>
                <p style="color: var(--text-secondary); line-height: 1.6; margin-bottom: 1rem;">
                    Both architectures have clear operational characteristics. Under heavy load, the differences become stark. Below is a breakdown of their features:
                </p>
                <table class="arch-table">
                    <thead>
                        <tr>
                            <th>Metric / Characteristic</th>
                            <th>Stateful Auth (Database Blacklist)</th>
                            <th>Stateless Auth (Rolling Secret / JWT)</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><strong>Validation Latency</strong></td>
                            <td><span class="text-red">High (10ms+ Network DB Query)</span></td>
                            <td><span class="text-green">Sub-millisecond (Local CPU Cryptography)</span></td>
                        </tr>
                        <tr>
                            <td><strong>Throughput (RPS)</strong></td>
                            <td><span class="text-red">Bottlenecked (limited by connection pool / DB latency)</span></td>
                            <td><span class="text-green">Extremely High (limited only by CPU cores)</span></td>
                        </tr>
                        <tr>
                            <td><strong>Server CPU Utilization</strong></td>
                            <td><span class="text-green">Very Low</span> (Server is idle waiting for DB I/O)</td>
                            <td><span class="text-red">Higher</span> (Crypto signature parsing + math calculations)</td>
                        </tr>
                        <tr>
                            <td><strong>Server Memory footprint</strong></td>
                            <td>Low / Moderate (holds DB pool caches)</td>
                            <td>Low (stateless verify context)</td>
                        </tr>
                        <tr>
                            <td><strong>Instant Revocation Latency</strong></td>
                            <td><span class="text-green">Instant (0ms to 10ms check)</span></td>
                            <td><span class="text-red">Slow / Complex</span> (Propagation delay of keys or token blacklist database check)</td>
                        </tr>
                        <tr>
                            <td><strong>Architectural Complexity</strong></td>
                            <td>Simple (Server + DB)</td>
                            <td>Complex (Key distribution, token lifespans)</td>
                        </tr>
                        <tr>
                            <td><strong>Impact of Key Compounding</strong></td>
                            <td>None</td>
                            <td>Increased CPU cycles as cryptographic math demands scale</td>
                        </tr>
                    </tbody>
                </table>
                
                <h3 style="font-family: 'Outfit'; margin-top: 2rem; margin-bottom: 0.75rem;">Summary of the Experiment</h3>
                <p style="color: var(--text-secondary); line-height: 1.6; margin-bottom: 1rem;">
                    When running load tests, observe how <strong>Stateful Auth</strong> queues requests. Since each request is blocked for 10ms waiting for the database, even a modest workload of 500 connections will run out of concurrent available threads/sockets, creating a bottleneck. 
                </p>
                <p style="color: var(--text-secondary); line-height: 1.6;">
                    On the other hand, <strong>Stateless Auth</strong> processes validations as fast as the CPU can compute, resulting in a dramatic latency drop and sky-high throughput. However, notice that under maximum load, the server's CPU usage spikes significantly higher than in stateful mode, demonstrating that cryptographic signature verification is CPU-intensive.
                </p>
            </div>
        </div>
    </main>

    <script>
        let currentTarget = 'stateful';
        let eventSource = null;
        let healthTimer = null;
        
        // --- CHARTS INITIALIZATION ---
        const bChartCtx = document.getElementById('benchmarkChart').getContext('2d');
        const cpuChartCtx = document.getElementById('cpuChart').getContext('2d');
        const memChartCtx = document.getElementById('memChart').getContext('2d');

        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.05)';

        // Performance Chart
        const benchmarkChart = new Chart(bChartCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Throughput (RPS)',
                        data: [],
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        borderWidth: 2,
                        yAxisID: 'yRps',
                        tension: 0.35,
                        fill: true
                    },
                    {
                        label: 'Avg Latency (ms)',
                        data: [],
                        borderColor: '#ef4444',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        yAxisID: 'yLat',
                        tension: 0.35
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    yRps: {
                        type: 'linear',
                        position: 'left',
                        title: { display: true, text: 'Requests Per Second', color: '#3b82f6' },
                        grid: { drawOnChartArea: true }
                    },
                    yLat: {
                        type: 'linear',
                        position: 'right',
                        title: { display: true, text: 'Latency (ms)', color: '#ef4444' },
                        grid: { drawOnChartArea: false }
                    }
                },
                plugins: {
                    legend: { position: 'top' }
                }
            }
        });

        // CPU Chart
        const cpuHistory = Array(30).fill(0);
        const cpuLabels = Array(30).fill('');
        const cpuChart = new Chart(cpuChartCtx, {
            type: 'line',
            data: {
                labels: cpuLabels,
                datasets: [{
                    label: 'CPU Usage %',
                    data: cpuHistory,
                    borderColor: '#a855f7',
                    backgroundColor: 'rgba(168, 85, 247, 0.1)',
                    borderWidth: 1.5,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { min: 0, max: 100, title: { display: false } }
                },
                plugins: { legend: { display: false } }
            }
        });

        // Memory Chart
        const memHistory = Array(30).fill(0);
        const memChart = new Chart(memChartCtx, {
            type: 'line',
            data: {
                labels: cpuLabels,
                datasets: [{
                    label: 'Memory RSS (MB)',
                    data: memHistory,
                    borderColor: '#14b8a6',
                    backgroundColor: 'rgba(20, 184, 166, 0.1)',
                    borderWidth: 1.5,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { title: { display: false } }
                },
                plugins: { legend: { display: false } }
            }
        });

        // --- GENERAL APP LOGIC ---
        function switchTab(tabId) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            event.currentTarget.classList.add('active');
            document.getElementById(\`tab-\${tabId}\`).classList.add('active');
        }

        function setTarget(type) {
            currentTarget = type;
            const statefulBtn = document.getElementById('toggle-stateful');
            const statelessBtn = document.getElementById('toggle-stateless');
            
            if (type === 'stateful') {
                statefulBtn.classList.add('active', 'stateful');
                statelessBtn.classList.remove('active', 'stateless');
            } else {
                statelessBtn.classList.add('active', 'stateless');
                statefulBtn.classList.remove('active', 'stateful');
            }
            
            // Adjust card theme colors
            const themeRps = document.getElementById('theme-card-rps');
            const themeLat = document.getElementById('theme-card-latency');
            const themeP95 = document.getElementById('theme-card-p95');
            const themeErr = document.getElementById('theme-card-errors');
            
            [themeRps, themeLat, themeP95, themeErr].forEach(card => {
                card.className = \`metric-card \${type}-theme\`;
            });
        }

        // --- HEALTH MONITORING ---
        async function fetchMetrics() {
            try {
                const res = await fetch('/api/v1/metrics');
                const data = await res.json();
                
                document.getElementById('status-cpu').innerText = data.cpu + '%';
                document.getElementById('status-mem').innerText = data.memory.rss + ' MB';
                document.getElementById('status-sessions').innerText = data.activeSessionsCount;
                document.getElementById('status-secret-ver').innerText = data.secretVersion;
                
                // Update CPU History
                cpuHistory.push(data.cpu);
                cpuHistory.shift();
                cpuChart.update('none');
                
                // Update Memory History
                memHistory.push(data.memory.rss);
                memHistory.shift();
                memChart.update('none');
            } catch (err) {
                console.error('Error fetching metrics:', err);
            }
        }

        healthTimer = setInterval(fetchMetrics, 1000);
        fetchMetrics();

        // --- RUNNING LOAD BENCHMARKS ---
        function startBenchmark() {
            const connections = document.getElementById('connections-input').value;
            const duration = document.getElementById('duration-input').value;
            const term = document.getElementById('term');
            const runBtn = document.getElementById('run-btn');
            const abortBtn = document.getElementById('abort-btn');

            term.innerHTML = \`<span class="info">Initializing \${currentTarget.toUpperCase()} benchmark...</span><br>\`;
            runBtn.disabled = true;
            abortBtn.style.display = 'inline-flex';
            
            // Clear chart
            benchmarkChart.data.labels = [];
            benchmarkChart.data.datasets[0].data = [];
            benchmarkChart.data.datasets[1].data = [];
            benchmarkChart.update();

            // Reset summary
            document.getElementById('metric-rps').innerText = '-';
            document.getElementById('metric-latency-avg').innerText = '-';
            document.getElementById('metric-latency-p95').innerText = '-';
            document.getElementById('metric-errors').innerText = '-';

            eventSource = new EventSource(\`/api/v1/run-benchmark?type=\${currentTarget}&connections=\${connections}&duration=\${duration}\`);
            
            let secondsElapsed = 0;

            eventSource.addEventListener('status', (e) => {
                const data = JSON.parse(e.data);
                term.innerHTML += \`<span class="sys">\${data.message}</span><br>\`;
                term.scrollTop = term.scrollHeight;
            });

            eventSource.addEventListener('tick', (e) => {
                const data = JSON.parse(e.data);
                secondsElapsed++;
                
                benchmarkChart.data.labels.push(\`\${secondsElapsed}s\`);
                benchmarkChart.data.datasets[0].data.push(data.requests);
                benchmarkChart.data.datasets[1].data.push(data.latency);
                benchmarkChart.update();

                term.innerHTML += \`Tick \${secondsElapsed}s: Throughput = <strong>\${data.requests.toFixed(0)} req/s</strong>, Avg Latency = <strong>\${data.latency.toFixed(2)} ms</strong>, Errors = \${data.errors}<br>\`;
                term.scrollTop = term.scrollHeight;

                document.getElementById('metric-rps').innerText = data.requests.toFixed(0);
                document.getElementById('metric-latency-avg').innerText = data.latency.toFixed(1) + ' ms';
                document.getElementById('metric-errors').innerText = data.errors + ' errs';
            });

            eventSource.addEventListener('done', (e) => {
                const results = JSON.parse(e.data);
                
                term.innerHTML += \`<br><span class="sys">🏁 BENCHMARK COMPLETED SUCCESSFULLY!</span><br>\`;
                term.innerHTML += \`----------------------------------------<br>\`;
                term.innerHTML += \`Total Requests: <strong>\${results.requests.sent}</strong><br>\`;
                term.innerHTML += \`Avg Throughput: <strong>\${results.requests.average.toFixed(2)} rps</strong><br>\`;
                term.innerHTML += \`Avg Latency: <strong>\${results.latency.average.toFixed(2)} ms</strong><br>\`;
                term.innerHTML += \`p95 Latency: <strong>\${results.latency.p95.toFixed(2)} ms</strong><br>\`;
                term.innerHTML += \`p99 Latency: <strong>\${results.latency.p99.toFixed(2)} ms</strong><br>\`;
                term.innerHTML += \`Errors: <span class="\${results.errors > 0 ? 'err' : 'info'}">\${results.errors}</span> | Timeouts: \${results.timeouts}<br>\`;
                term.scrollTop = term.scrollHeight;

                document.getElementById('metric-rps').innerText = results.requests.average.toFixed(0);
                document.getElementById('metric-latency-avg').innerText = results.latency.average.toFixed(1) + ' ms';
                document.getElementById('metric-latency-p95').innerText = results.latency.p95.toFixed(1) + ' ms';
                document.getElementById('metric-errors').innerText = ((results.errors / results.requests.sent) * 100).toFixed(2) + '%';
                
                cleanupEventSource();
            });

            eventSource.addEventListener('error', (e) => {
                const data = e.data ? JSON.parse(e.data) : { message: 'Connection lost' };
                term.innerHTML += \`<span class="err">Error: \${data.message}</span><br>\`;
                term.scrollTop = term.scrollHeight;
                cleanupEventSource();
            });
        }

        function abortBenchmark() {
            fetch('/api/v1/abort-benchmark', { method: 'POST' })
                .then(res => res.json())
                .then(data => {
                    const term = document.getElementById('term');
                    term.innerHTML += \`<span class="err">Benchmark aborted by user.</span><br>\`;
                    term.scrollTop = term.scrollHeight;
                    cleanupEventSource();
                })
                .catch(err => console.error(err));
        }

        function cleanupEventSource() {
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            document.getElementById('run-btn').disabled = false;
            document.getElementById('abort-btn').style.display = 'none';
        }

        // --- REVOCATION LATENCY METRICS ---
        async function controlSession(action) {
            let url = '';
            if (action === 'restore') url = '/api/v1/restore-stateful';
            else if (action === 'roll') url = '/api/v1/roll-key';
            
            const res = await fetch(url, { method: 'POST' });
            const data = await res.json();
            
            const term = document.getElementById('sandbox-term');
            term.innerHTML += \`<span class="sys">\${data.message}</span><br>\`;
            term.scrollTop = term.scrollHeight;
            fetchMetrics();
        }

        async function measureRevocationLatency(type) {
            const term = document.getElementById('sandbox-term');
            const latencyValEl = document.getElementById(\`\${type}-latency-val\`);
            const detailsEl = document.getElementById(\`\${type}-details-val\`);
            const boxEl = document.getElementById(\`\${type}-rev-box\`);
            
            term.innerHTML += \`<span class="info">Starting revocation test for \${type}...</span><br>\`;
            term.scrollTop = term.scrollHeight;
            
            latencyValEl.innerText = 'Testing...';
            latencyValEl.className = 'latency-num';
            detailsEl.innerText = 'Polling endpoint...';
            
            // Get credentials
            let authHeader = '';
            if (type === 'stateful') {
                // Ensure session exists first
                await fetch('/api/v1/restore-stateful', { method: 'POST' });
                authHeader = 'valid_session_1234';
            } else {
                // Fetch fresh token
                const tokenRes = await fetch('/api/v1/token');
                const tokenData = await tokenRes.json();
                authHeader = tokenData.token;
            }
            
            const pollUrl = \`/api/v1/data-\${type}\`;
            let isRevoked = false;
            let revocationTriggeredAt = null;
            let revocationEffectiveAt = null;
            let pollCount = 0;
            
            // Start high frequency polling loop (every 10ms)
            const timer = setInterval(async () => {
                pollCount++;
                try {
                    const startPoll = performance.now();
                    const res = await fetch(pollUrl, {
                        headers: { 'Authorization': authHeader }
                    });
                    
                    if (res.status === 401) {
                        // Success! Session has been revoked!
                        if (revocationTriggeredAt && !revocationEffectiveAt) {
                            revocationEffectiveAt = performance.now();
                            clearInterval(timer);
                            
                            const delta = (revocationEffectiveAt - revocationTriggeredAt).toFixed(1);
                            latencyValEl.innerText = delta + ' ms';
                            latencyValEl.className = 'latency-num success';
                            detailsEl.innerText = \`Took \${pollCount} requests to detect\`;
                            
                            term.innerHTML += \`<span class="sys">🟢 Revocation detected in \${delta} ms! Validation returned 401.</span><br>\`;
                            term.scrollTop = term.scrollHeight;
                            fetchMetrics();
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }, 15);

            // Wait 300ms of polling, then fire revocation request
            setTimeout(async () => {
                term.innerHTML += \`<span class="sys">Firing revocation command...</span><br>\`;
                term.scrollTop = term.scrollHeight;
                
                revocationTriggeredAt = performance.now();
                
                const url = type === 'stateful' ? '/api/v1/revoke-stateful' : '/api/v1/roll-key';
                await fetch(url, { method: 'POST' });
            }, 300);
        }
    </script>
</body>
</html>
    `);
});

// Start Express Server
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 BENCHMARK SERVER RUNNING AT: http://localhost:${PORT}`);
    console.log(`📊 Open this link in your browser to run the test suite.`);
    console.log(`======================================================\n`);
});
