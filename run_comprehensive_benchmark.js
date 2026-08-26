const autocannon = require('autocannon');
const fs = require('fs');
const http = require('http');

const PORT = 3001;
const URL = `http://localhost:${PORT}`;

// Parse command line arguments
const isFast = process.argv.includes('--fast') || process.argv.includes('-f');

// Define diagnostic matrix thresholds
let CONCURRENCY_LEVELS = [];
let LATENCIES = [];
let MODES = [];
let RUNS = 1;
let WARMUP_SEC = 10;
let MEASURE_SEC = 30;

if (isFast) {
    console.log('⚡ FAST DIAGNOSTIC MODE: Running minimal subsets for verification...');
    CONCURRENCY_LEVELS = [10, 50];
    LATENCIES = [0, 10];
    MODES = ['none', 'jwt', 'stateful'];
    RUNS = 1;
    WARMUP_SEC = 1;
    MEASURE_SEC = 2;
} else {
    console.log('📊 COMPREHENSIVE MODE: Running full multidimensional diagnostics...');
    CONCURRENCY_LEVELS = [10, 25, 50, 75, 100, 150, 200, 250, 500, 750, 1000];
    LATENCIES = [0, 5, 10, 20, 50]; // ms stateful latency sweep
    MODES = ['none', 'jwt', 'stateful'];
    RUNS = 5; // 5 statistical runs
    WARMUP_SEC = 10;
    MEASURE_SEC = 30;
}

const jwtToken = require('jsonwebtoken').sign(
    { user: 'test_user_999' }, 
    'a_very_secure_256_bit_symmetric_secret_key_for_hmac_sha256_benchmarking', 
    { algorithm: 'HS256' }
);

// Helper: Query metrics directly from the Express server process
function fetchServerMetrics() {
    return new Promise((resolve) => {
        http.get(`${URL}/metrics`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => {
            resolve(null);
        });
    });
}

async function runBenchmark(mode, concurrency, latency) {
    let path = '/auth/none';
    let headers = {};

    if (mode === 'jwt') {
        path = '/auth/jwt';
        headers = { 'Authorization': `Bearer ${jwtToken}` };
    } else if (mode === 'stateful') {
        path = `/auth/stateful?delay=${latency}`;
        headers = { 'x-session-id': 'session_token_500' };
    }

    // Warm-up phase to settle JIT compiler and event loop
    await new Promise((resolve) => {
        autocannon({ url: URL + path, connections: concurrency, duration: WARMUP_SEC, headers }, resolve);
    });

    // Start server metric polling (CPU, RSS, Heap) once per second during measurement
    const metricsHistory = [];
    const metricsInterval = setInterval(async () => {
        const metrics = await fetchServerMetrics();
        if (metrics) {
            metricsHistory.push(metrics);
        }
    }, 1000);

    // Measurement phase
    return new Promise((resolve, reject) => {
        autocannon({
            url: URL + path,
            connections: concurrency,
            duration: MEASURE_SEC,
            headers,
            pipelining: 1
        }, (err, result) => {
            clearInterval(metricsInterval);
            if (err) return reject(err);

            // Calculate average server statistics over the test duration
            const avgCpu = metricsHistory.length > 0
                ? parseFloat((metricsHistory.reduce((sum, m) => sum + m.cpu, 0) / metricsHistory.length).toFixed(2))
                : 0;
            const avgRss = metricsHistory.length > 0
                ? parseFloat((metricsHistory.reduce((sum, m) => sum + m.rss, 0) / metricsHistory.length).toFixed(2))
                : 0;
            const avgHeap = metricsHistory.length > 0
                ? parseFloat((metricsHistory.reduce((sum, m) => sum + m.heapUsed, 0) / metricsHistory.length).toFixed(2))
                : 0;

            resolve({
                mode,
                latency,
                concurrency,
                rps: result.requests.average,
                meanLatency: result.latency.average,
                p99Latency: result.latency.p99,
                rssUsed: avgRss,
                heapUsed: avgHeap,
                cpuUsed: avgCpu,
                errors: result.errors
            });
        });
    });
}

async function main() {
    const results = [];
    const testCases = [];

    // Build the multidimensional test matrix
    for (const mode of MODES) {
        if (mode === 'stateful') {
            for (const lat of LATENCIES) {
                for (const conn of CONCURRENCY_LEVELS) {
                    for (let run = 1; run <= RUNS; run++) {
                        testCases.push({ mode, conn, lat, run });
                    }
                }
            }
        } else {
            for (const conn of CONCURRENCY_LEVELS) {
                for (let run = 1; run <= RUNS; run++) {
                    testCases.push({ mode, conn, lat: 0, run });
                }
            }
        }
    }

    // Randomize test cases to prevent thermal throttling or scheduling bias
    testCases.sort(() => Math.random() - 0.5);

    console.log(`Starting expanded matrix test suite: ${testCases.length} total executions...`);

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        console.log(`[${i + 1}/${testCases.length}] Executing -> Mode: ${tc.mode}, Latency: ${tc.lat}ms, Concurrency: ${tc.conn}, Run: ${tc.run}`);
        try {
            const res = await runBenchmark(tc.mode, tc.conn, tc.lat);
            results.push({
                Run: tc.run,
                Mode: tc.mode,
                SessionLatencyMs: tc.lat,
                Connections: tc.conn,
                RPS: res.rps,
                MeanLatencyMs: res.meanLatency,
                P99LatencyMs: res.p99Latency,
                RSS_MB: res.rssUsed,
                Heap_MB: res.heapUsed,
                CPU_Percent: res.cpuUsed,
                Errors: res.errors
            });

            // 1.5s cooldown period to clear sockets and JIT handles between runs
            await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (e) {
            console.error(`Execution failed for test case:`, tc, e);
        }
    }

    // Save outputs to CSV
    const csvHeader = 'Run,Mode,SessionLatencyMs,Connections,RPS,MeanLatencyMs,P99LatencyMs,RSS_MB,Heap_MB,CPU_Percent,Errors\n';
    const csvRows = results.map(r => `${r.Run},${r.Mode},${r.SessionLatencyMs},${r.Connections},${r.RPS.toFixed(0)},${r.MeanLatencyMs.toFixed(2)},${r.P99LatencyMs.toFixed(0)},${r.RSS_MB.toFixed(2)},${r.Heap_MB.toFixed(2)},${r.CPU_Percent.toFixed(2)},${r.Errors}`).join('\n');
    
    fs.writeFileSync('comprehensive_benchmark_results.csv', csvHeader + csvRows);
    console.log('Complete! Results saved to comprehensive_benchmark_results.csv');
}

main();
