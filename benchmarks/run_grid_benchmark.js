const autocannon = require('autocannon');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

// Parse command line arguments
const isFast = process.argv.includes('--fast') || process.argv.includes('-f');

// Define connection matrix and durations
let connections = [];
let durations = [];

if (isFast) {
    console.log('⚡ FAST DIAGNOSTIC MODE ACTIVE: Running a subset grid for verification.');
    connections = [10, 50, 100, 250];
    durations = [5, 10];
} else {
    console.log('📊 FULL DIAGNOSTIC MODE: Running full connection matrix and durations.');
    // Connections from 10 to 250, interval of 10
    for (let c = 10; c <= 250; c += 10) {
        connections.push(c);
    }
    // Durations from 5 to 30, interval of 5
    for (let d = 5; d <= 30; d += 5) {
        durations.push(d);
    }
}

// Helper: Sleep utility for cooldowns
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Result structure to store all raw runs
const runs = [];

// Helper: Verify if server is running
function checkServer() {
    return new Promise((resolve) => {
        const req = http.get(`${BASE_URL}/api/v1/metrics`, (res) => {
            if (res.statusCode === 200) resolve(true);
            else resolve(false);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

// Helper: Fetch server-side metrics
function fetchMetrics() {
    return new Promise((resolve) => {
        http.get(`${BASE_URL}/api/v1/metrics`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// Helper: Fetch a fresh token for stateless
function fetchToken() {
    return new Promise((resolve, reject) => {
        http.get(`${BASE_URL}/api/v1/token`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data).token);
                } catch (e) {
                    reject(new Error('Failed to parse token payload'));
                }
            });
        }).on('error', (err) => reject(err));
    });
}

// Helper: Restore stateful session ID in the server DB
function restoreStatefulSession() {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: 'localhost',
            port: PORT,
            path: '/api/v1/restore-stateful',
            method: 'POST'
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
        });
        req.on('error', () => resolve());
        req.end();
    });
}

// Helper: Run a single autocannon load test and poll metrics
function runAutocannon(url, conns, durationSec, headers) {
    return new Promise((resolve, reject) => {
        const metricsHistory = [];
        
        // Start metric polling interval every 1 second
        const metricsInterval = setInterval(async () => {
            const metrics = await fetchMetrics();
            if (metrics) {
                metricsHistory.push({
                    cpu: metrics.cpu,
                    mem: metrics.memory.rss
                });
            }
        }, 1000);

        const instance = autocannon({
            url,
            connections: conns,
            duration: durationSec,
            headers
        }, (err, results) => {
            clearInterval(metricsInterval);
            if (err) return reject(err);
            
            // Calculate average CPU and Memory usage during this run
            const avgCpu = metricsHistory.length > 0 
                ? parseFloat((metricsHistory.reduce((sum, m) => sum + m.cpu, 0) / metricsHistory.length).toFixed(2))
                : 0;
            const avgMem = metricsHistory.length > 0
                ? parseFloat((metricsHistory.reduce((sum, m) => sum + m.mem, 0) / metricsHistory.length).toFixed(2))
                : 0;

            resolve({
                results,
                avgCpu,
                avgMem
            });
        });
    });
}

// Clean log formatting
function printRow(cells) {
    console.log('| ' + cells.map(cell => String(cell).padEnd(10)).join(' | ') + ' |');
}

// Main execution block
async function startGridBenchmark() {
    const isAlive = await checkServer();
    if (!isAlive) {
        console.error(`\n❌ ERROR: Benchmark server is not running on port ${PORT}.`);
        console.error(`Please run "node server.js" in another terminal before executing this script.\n`);
        process.exit(1);
    }

    // Restore the session ID in the server DB in case it was deleted by revocation tests
    await restoreStatefulSession();

    console.log(`\n🏁 Starting Grid Benchmark comparison on ${BASE_URL}...`);
    console.log(`Grid parameters:`);
    console.log(`  - Methods: Stateful (DB Check) and Stateless (JWT Check)`);
    console.log(`  - Durations: [${durations.join(', ')}] seconds`);
    console.log(`  - Connections (VUs): [${connections.join(', ')}]\n`);

    // Print headers for real-time stdout table
    const tableHeaders = ['Method', 'VUs', 'Time (s)', 'RPS', 'Mean (ms)', 'p90 (ms)', 'p99 (ms)', 'Errors', 'CPU %', 'Mem (MB)'];
    console.log('|' + '-'.repeat(tableHeaders.length * 13) + '|');
    printRow(tableHeaders);
    console.log('|' + '-'.repeat(tableHeaders.length * 13) + '|');

    // Loops: Duration (j) -> Connections (i) -> Methods
    for (const duration of durations) {
        for (const conns of connections) {
            
            // ------------------ RUN A: STATEFUL ------------------
            try {
                const statefulUrl = `${BASE_URL}/api/v1/data-stateful`;
                const statefulHeaders = { 'Authorization': 'valid_session_1234' };
                
                const { results, avgCpu, avgMem } = await runAutocannon(statefulUrl, conns, duration, statefulHeaders);
                
                const errorCount = results.errors + results.non2xx;
                const rps = results.requests.average;
                const meanLat = results.latency.average;
                const p90Lat = results.latency.p90;
                const p99Lat = results.latency.p99;

                const runData = {
                    method: 'stateful',
                    connections: conns,
                    duration,
                    rps,
                    meanLatency: meanLat,
                    p90Latency: p90Lat,
                    p99Latency: p99Lat,
                    errors: errorCount,
                    totalRequests: results.requests.sent,
                    avgCpu,
                    avgMem
                };
                runs.push(runData);

                printRow([
                    'Stateful',
                    conns,
                    duration,
                    rps.toFixed(0),
                    meanLat.toFixed(1),
                    p90Lat.toFixed(0),
                    p99Lat.toFixed(0),
                    errorCount,
                    avgCpu.toFixed(1) + '%',
                    avgMem.toFixed(0)
                ]);
            } catch (e) {
                console.error(`\nError running Stateful run (VUs: ${conns}, time: ${duration}s):`, e.message);
            }
            await sleep(2000); // Stateful cooldown

            // ------------------ RUN B: STATELESS ------------------
            try {
                const statelessUrl = `${BASE_URL}/api/v1/data-stateless`;
                // Fetch fresh JWT
                const jwtToken = await fetchToken();
                const statelessHeaders = { 'Authorization': jwtToken };
                
                const { results, avgCpu, avgMem } = await runAutocannon(statelessUrl, conns, duration, statelessHeaders);
                
                const errorCount = results.errors + results.non2xx;
                const rps = results.requests.average;
                const meanLat = results.latency.average;
                const p90Lat = results.latency.p90;
                const p99Lat = results.latency.p99;

                const runData = {
                    method: 'stateless',
                    connections: conns,
                    duration,
                    rps,
                    meanLatency: meanLat,
                    p90Latency: p90Lat,
                    p99Latency: p99Lat,
                    errors: errorCount,
                    totalRequests: results.requests.sent,
                    avgCpu,
                    avgMem
                };
                runs.push(runData);

                printRow([
                    'Stateless',
                    conns,
                    duration,
                    rps.toFixed(0),
                    meanLat.toFixed(1),
                    p90Lat.toFixed(0),
                    p99Lat.toFixed(0),
                    errorCount,
                    avgCpu.toFixed(1) + '%',
                    avgMem.toFixed(0)
                ]);
            } catch (e) {
                console.error(`\nError running Stateless run (VUs: ${conns}, time: ${duration}s):`, e.message);
            }
            await sleep(2000); // Stateless cooldown
        }
    }
    console.log('|' + '-'.repeat(tableHeaders.length * 13) + '|');

    // Write reports
    generateReports();
}

function generateReports() {
    console.log('\n💾 Writing raw results to JSON file...');
    fs.writeFileSync(
        path.join(__dirname, 'benchmark_grid_results.json'), 
        JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2)
    );

    console.log('📊 Writing results to CSV file...');
    let csv = 'Method,Connections (VUs),Duration (s),Throughput (RPS),Mean Latency (ms),p90 Latency (ms),p99 Latency (ms),Errors,Avg CPU %,Avg Memory (MB)\n';
    for (const r of runs) {
        csv += `${r.method.toUpperCase()},${r.connections},${r.duration},${r.rps.toFixed(0)},${r.meanLatency.toFixed(1)},${r.p90Latency.toFixed(0)},${r.p99Latency.toFixed(0)},${r.errors},${r.avgCpu.toFixed(1)},${r.avgMem.toFixed(0)}\n`;
    }
    fs.writeFileSync(path.join(__dirname, 'benchmark_grid_results.csv'), csv);

    console.log('✍️ Writing comparative Markdown Report to benchmark_grid_report.md...');
    let md = `# Authentication Grid Benchmark Diagnostics Report\n\n`;
    md += `*Generated on: ${new Date().toUTCString()}*\n`;
    md += `*Environment: Identical Single Node.js server endpoints running on port ${PORT}*\n\n`;

    md += `## 📊 Overview\n`;
    md += `This report lists the performance diagnostics comparing **Stateful DB-Backed Sessions** (simulating 10ms lookup latency) and **Stateless local JWT Verification** (using cryptography, 0ms network latency).\n\n`;

    // Grouping by duration for side-by-side matrices
    for (const duration of durations) {
        md += `### ⏱️ Performance Matrix: ${duration}s Duration\n\n`;
        
        md += `#### Throughput & Latency Matrix\n`;
        md += `| Connections (VUs) | Stateful Throughput (RPS) | Stateless Throughput (RPS) | Stateful Mean Latency (ms) | Stateless Mean Latency (ms) | RPS Speedup Factor | Latency Reduction |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

        for (const conns of connections) {
            const stateful = runs.find(r => r.method === 'stateful' && r.connections === conns && r.duration === duration);
            const stateless = runs.find(r => r.method === 'stateless' && r.connections === conns && r.duration === duration);

            if (stateful && stateless) {
                const speedup = stateless.rps / stateful.rps;
                const reduction = stateful.meanLatency > 0 
                    ? ((stateful.meanLatency - stateless.meanLatency) / stateful.meanLatency * 100).toFixed(1) + '%'
                    : 'N/A';

                md += `| **${conns}** | ${stateful.rps.toFixed(0)} | ${stateless.rps.toFixed(0)} | ${stateful.meanLatency.toFixed(1)} | ${stateless.meanLatency.toFixed(1)} | **${speedup.toFixed(2)}x** | **${reduction}** |\n`;
            }
        }
        md += `\n`;

        md += `#### Server Resource Profile (${duration}s)\n`;
        md += `| Connections (VUs) | Stateful CPU % | Stateless CPU % | Stateful Mem (MB) | Stateless Mem (MB) | Stateful Errors | Stateless Errors |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

        for (const conns of connections) {
            const stateful = runs.find(r => r.method === 'stateful' && r.connections === conns && r.duration === duration);
            const stateless = runs.find(r => r.method === 'stateless' && r.connections === conns && r.duration === duration);

            if (stateful && stateless) {
                md += `| **${conns}** | ${stateful.avgCpu.toFixed(1)}% | ${stateless.avgCpu.toFixed(1)}% | ${stateful.avgMem.toFixed(0)} | ${stateless.avgMem.toFixed(0)} | ${stateful.errors} | ${stateless.errors} |\n`;
            }
        }
        md += `\n---\n\n`;
    }

    // Breaking Points analysis
    md += `## 🛑 Breaking Points (SLA Breaches)\n`;
    md += `We define a system breach when the request error rate exceeds **1%** of total requests sent.\n\n`;
    md += `| Method | Duration (s) | Breakpoint Connections (VUs) | Total Requests | Error Count | Error Rate % |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    let breakpointsFound = false;
    for (const r of runs) {
        const rate = (r.errors / r.totalRequests) * 100;
        if (rate > 1) {
            md += `| ${r.method.toUpperCase()} | ${r.duration}s | ${r.connections} | ${r.totalRequests} | ${r.errors} | **${rate.toFixed(2)}%** |\n`;
            breakpointsFound = true;
        }
    }
    if (!breakpointsFound) {
        md += `| *No SLA breaches detected* | | | | | |\n`;
    }
    md += `\n\n`;

    // Master list table
    md += `## 📋 Complete Master Diagnostic Table\n\n`;
    md += `| Method | Connections (VUs) | Duration (s) | Throughput (RPS) | Mean Latency (ms) | p90 Latency (ms) | p99 Latency (ms) | Errors | Avg CPU | Avg Memory (MB) |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    for (const r of runs) {
        md += `| ${r.method.toUpperCase()} | ${r.connections} | ${r.duration}s | ${r.rps.toFixed(0)} | ${r.meanLatency.toFixed(1)} | ${r.p90Latency.toFixed(0)} | ${r.p99Latency.toFixed(0)} | ${r.errors} | ${r.avgCpu.toFixed(1)}% | ${r.avgMem.toFixed(0)} |\n`;
    }

    fs.writeFileSync(path.join(__dirname, 'benchmark_grid_report.md'), md);
    console.log(`\n🎉 DIAGNOSTICS COMPLETED SUCCESSFULLY!`);
    console.log(`📈 Results written to:`);
    console.log(`  - [JSON Data]: benchmark_grid_results.json`);
    console.log(`  - [CSV Spreadsheet]: benchmark_grid_results.csv`);
    console.log(`  - [Markdown Table]: benchmark_grid_report.md\n`);
}

// Start grid benchmark
startGridBenchmark();
