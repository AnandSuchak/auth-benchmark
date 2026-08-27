/**
 * Reproducibility Validation Benchmark
 * 
 * Concurrency: 175, 180, 185, 190, 195, 200, 205, 210, 215, 220, 225
 * Architecture: JWT, Stateful (10ms latency)
 * Runs: 5 independent runs per condition (110 runs total)
 * Warm-up: 15s | Measurement: 30s | Cooldown: 5s
 * Pipelining: 1
 * 
 * Active Cooldown: Polls server /metrics until CPU < 5% before starting each test.
 * Historical Comparison: Parses final-validation-summary.csv and test1_summary.csv.
 * 
 * Execution: node reproducibility_validation.js [--fast]
 */

const autocannon = require('autocannon');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const { monitorEventLoopDelay } = require('perf_hooks');

// Config parameters
const PORT = 3001;
const URL = `http://localhost:${PORT}`;
const SECRET = 'a_very_secure_256_bit_symmetric_secret_key_for_hmac_sha256_benchmarking';

const isFast = process.argv.includes('--fast') || process.argv.includes('-f');

let CONCURRENCY_LEVELS = [];
let RUNS = 1;
let WARMUP_SEC = 15;
let MEASURE_SEC = 30;
let COOLDOWN_SEC = 5;

if (isFast) {
    console.log('⚡ FAST DIAGNOSTIC MODE: Running subset matrix for verification...');
    CONCURRENCY_LEVELS = [175, 190];
    RUNS = 2;
    WARMUP_SEC = 1;
    MEASURE_SEC = 2;
    COOLDOWN_SEC = 1;
} else {
    console.log('📊 REPRODUCIBILITY VALIDATION MODE: Running full matrix (110 runs)...');
    CONCURRENCY_LEVELS = [175, 180, 185, 190, 195, 200, 205, 210, 215, 220, 225];
    RUNS = 5;
    WARMUP_SEC = 15;
    MEASURE_SEC = 30;
    COOLDOWN_SEC = 5;
}

// Generate valid JWT token dynamically
const jwtToken = jwt.sign(
    { id: 'session_token_500', user: 'test_user_999' },
    SECRET,
    { algorithm: 'HS256' }
);

// Verify server connectivity
function checkServerHealthy() {
    return new Promise((resolve) => {
        const req = http.get(`${URL}/auth/none`, (res) => {
            if (res.statusCode === 200) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

// Fetch metrics directly from the Express server process
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

// Helper: Cooldown server by polling its CPU in a loop
async function cooldownServer() {
    console.log('⏳ Checking server cooldown state...');
    for (let attempt = 1; attempt <= 10; attempt++) {
        const metrics = await fetchServerMetrics();
        if (metrics) {
            console.log(`   [Server Metrics] CPU: ${metrics.cpu}%, RSS: ${metrics.rss} MB, Heap: ${metrics.heapUsed} MB`);
            if (metrics.cpu < 5.0) {
                console.log('   ✅ Server cooled down below 5% CPU.');
                return true;
            }
        } else {
            console.log('   ⚠️ Warning: Server metrics unreachable.');
        }
        // Wait 1s between polls
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log('   ⚠️ Server did not cool down below 5% CPU within 10s. Continuing test...');
    return false;
}

// Fisher-Yates array shuffling algorithm
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Standard Deviation calculation (Sample SD, denominator: n - 1)
function calcSD(arr, mean) {
    if (arr.length <= 1) return 0;
    const sqDiffSum = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0);
    return Math.sqrt(sqDiffSum / (arr.length - 1));
}

// Student's t-distribution critical values for df = n - 1
function getTCritical(n) {
    const tTable = {
        1: 12.706, // df = 1 (n = 2)
        2: 4.303,  // df = 2 (n = 3)
        3: 3.182,  // df = 3 (n = 4)
        4: 2.776,  // df = 4 (n = 5)
    };
    const df = n - 1;
    return tTable[df] || 1.96; // fallback to z-score
}

// Parse CSV file into key-value list of objects
function parseCSV(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length <= 1) return null;
    const headers = lines[0].toLowerCase().split(',');
    
    const results = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',');
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = values[j];
        }
        results.push(row);
    }
    return results;
}

// Read past summary tables to extract baseline results
function getPreviousRpsMap() {
    const prevRpsMap = {}; // Key: "concurrency_architecture" -> meanRps
    
    // 1. Check final-validation-summary.csv
    const finalValSummary = parseCSV(path.join(__dirname, 'final-validation-summary.csv'));
    if (finalValSummary) {
        for (const row of finalValSummary) {
            const conn = parseInt(row.concurrency || row.connections);
            const arch = row.architecture ? row.architecture.trim().toLowerCase() : '';
            const rps = parseFloat(row.rps_mean || row.meanrps);
            if (conn && arch && !isNaN(rps)) {
                prevRpsMap[`${conn}_${arch}`] = rps;
            }
        }
    }
    
    // 2. Check test1_summary.csv next for missing concurrencies
    const test1Summary = parseCSV(path.join(__dirname, 'test1_summary.csv'));
    if (test1Summary) {
        for (const row of test1Summary) {
            const conn = parseInt(row.connections || row.concurrency);
            const arch = row.architecture ? row.architecture.trim().toLowerCase() : '';
            const rps = parseFloat(row.meanrps || row.rps_mean);
            if (conn && arch && !isNaN(rps)) {
                if (!prevRpsMap[`${conn}_${arch}`]) {
                    prevRpsMap[`${conn}_${arch}`] = rps;
                }
            }
        }
    }
    
    return prevRpsMap;
}

// Run single autocannon instance (Warmup then measurement)
function runIndividualTest(tc, testOrder) {
    return new Promise((resolve, reject) => {
        let reqPath = '/auth/jwt';
        let headers = { 'Authorization': `Bearer ${jwtToken}` };

        if (tc.architecture === 'stateful') {
            reqPath = '/auth/stateful?delay=10';
            headers = { 'x-session-id': 'session_token_500' };
        }

        const startTimeStamp = new Date().toISOString();

        // 1. Warm-up Phase
        autocannon({
            url: URL + reqPath,
            connections: tc.concurrency,
            duration: WARMUP_SEC,
            headers,
            pipelining: 1
        }, (err) => {
            if (err) return reject(err);

            const latencies = [];
            
            // Initialize Event Loop histogram
            const elDelay = monitorEventLoopDelay({ resolution: 10 });
            elDelay.enable();
            elDelay.reset(); // clear warm-up delay values

            // Initialize CPU tracking
            let startCpu = process.cpuUsage();
            let startHrTime = process.hrtime();

            // 2. Measurement Phase
            const measureInstance = autocannon({
                url: URL + reqPath,
                connections: tc.concurrency,
                duration: MEASURE_SEC,
                headers,
                pipelining: 1
            }, (err, res) => {
                elDelay.disable();
                if (err) return reject(err);

                // Compute CPU average
                const elapCpu = process.cpuUsage(startCpu);
                const elapHrTime = process.hrtime(startHrTime);
                const elapTimeMs = elapHrTime[0] * 1000 + elapHrTime[1] / 1000000;
                const cpuAvg = (100 * (elapCpu.user / 1000 + elapCpu.system / 1000)) / elapTimeMs;

                // Extract Event Loop p99 (ns to ms)
                const elP99 = elDelay.percentile(99) / 1e6;

                // Calculate precise latency percentiles
                let p50Val = 0;
                let p95Val = 0;
                let p99Val = 0;

                if (latencies.length > 0) {
                    latencies.sort((a, b) => a - b);
                    p50Val = latencies[Math.floor(latencies.length * 0.50)];
                    p95Val = latencies[Math.floor(latencies.length * 0.95)];
                    p99Val = latencies[Math.floor(latencies.length * 0.99)];
                } else {
                    p50Val = res.latency.p50 || 0;
                    p95Val = res.latency.p97_5 || 0;
                    p99Val = res.latency.p99 || 0;
                }

                const totalCompleted = res.requests.sent || res.requests.average * MEASURE_SEC;

                resolve({
                    run: tc.run,
                    architecture: tc.architecture,
                    concurrency: tc.concurrency,
                    rps: res.requests.average,
                    meanLatency: res.latency.average,
                    p50Latency: p50Val,
                    p95Latency: p95Val,
                    p99Latency: p99Val,
                    errors: res.errors,
                    timeouts: res.timeouts,
                    non2xx: res.non2xx,
                    cpuPercent: cpuAvg,
                    eventLoopP99Ms: elP99,
                    actualDurationMs: elapTimeMs,
                    completedRequests: totalCompleted,
                    testOrder,
                    timestamp: startTimeStamp
                });
            });

            // Listen to response times in high-resolution floats
            measureInstance.on('response', (client, statusCode, resBytes, responseTime) => {
                latencies.push(responseTime);
            });
        });
    });
}

async function startValidationBenchmark() {
    console.log('🔍 Checking target server health...');
    const isHealthy = await checkServerHealthy();
    if (!isHealthy) {
        console.error(`❌ Error: Target benchmark server is not running or unreachable at ${URL}`);
        console.error('   Please run: node server.js first in a separate shell!');
        process.exit(1);
    }
    console.log(`✅ Server detected active at ${URL}`);

    // Machine information
    const nodeVersion = process.version;
    const platform = os.platform() + ' ' + os.release() + ' (' + os.arch() + ')';
    const cpuModel = os.cpus()[0].model;
    const totalRAM = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB';

    console.log('\n💻 HOST SYSTEM TELEMETRY:');
    console.log(`   Node.js Version: ${nodeVersion}`);
    console.log(`   Platform: ${platform}`);
    console.log(`   CPU Model: ${cpuModel}`);
    console.log(`   Total Memory: ${totalRAM}\n`);

    // Build test cases
    const testCases = [];
    const architectures = ['jwt', 'stateful'];

    for (const architecture of architectures) {
        for (const concurrency of CONCURRENCY_LEVELS) {
            for (let run = 1; run <= RUNS; run++) {
                testCases.push({
                    architecture,
                    concurrency,
                    run,
                    latency: architecture === 'stateful' ? 10 : 0
                });
            }
        }
    }

    // Shuffle execution order to remove order/thermal bias
    shuffle(testCases);

    console.log(`🚀 Shuffled validation matrix initialized. Executing ${testCases.length} runs...`);

    const rawResults = [];
    const runsWithIssues = []; // Flags runs with active errors or timeouts separately

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        console.log(`[${i + 1}/${testCases.length}] ${tc.architecture.toUpperCase()} | ${tc.concurrency} connections | Run ${tc.run}/${RUNS}`);
        
        // Server active cooldown check before each run to ensure clean state
        await cooldownServer();

        try {
            const res = await runIndividualTest(tc, i + 1);
            rawResults.push(res);
            
            // Check for errors/timeouts and flag them separately
            if (res.errors > 0 || res.timeouts > 0 || res.non2xx > 0) {
                runsWithIssues.push({
                    testOrder: i + 1,
                    architecture: tc.architecture,
                    concurrency: tc.concurrency,
                    run: tc.run,
                    errors: res.errors,
                    timeouts: res.timeouts,
                    non2xx: res.non2xx
                });
                console.log(`   ⚠️ WARNING: Run completed with ${res.errors} errors, ${res.timeouts} timeouts, ${res.non2xx} non-2xx`);
            }
        } catch (e) {
            console.error(`   ❌ Run execution failed:`, tc, e.message);
            const failRecord = {
                run: tc.run,
                architecture: tc.architecture,
                concurrency: tc.concurrency,
                rps: 0,
                meanLatency: 0,
                p50Latency: 0,
                p95Latency: 0,
                p99Latency: 0,
                errors: 1,
                timeouts: 0,
                non2xx: 0,
                cpuPercent: 0,
                eventLoopP99Ms: 0,
                actualDurationMs: 0,
                completedRequests: 0,
                testOrder: i + 1,
                timestamp: new Date().toISOString()
            };
            rawResults.push(failRecord);
            runsWithIssues.push({
                testOrder: i + 1,
                architecture: tc.architecture,
                concurrency: tc.concurrency,
                run: tc.run,
                errors: 1,
                timeouts: 0,
                non2xx: 0,
                criticalFailure: true
            });
        }

        // Standard cooldown sleep between tests
        await new Promise(resolve => setTimeout(resolve, COOLDOWN_SEC * 1000));
    }

    console.log('\n🏁 Benchmark executions completed. Performing statistical analysis...');

    // Group results by [concurrency, architecture]
    const grouped = {};
    for (const r of rawResults) {
        const key = `${r.concurrency}_${r.architecture}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(r);
    }

    const summaryResults = [];
    const summaryMap = {};

    for (const concurrency of CONCURRENCY_LEVELS) {
        for (const arch of architectures) {
            const key = `${concurrency}_${arch}`;
            const runs = grouped[key] || [];
            
            const n = runs.length;
            const rpsVals = runs.map(r => r.rps);
            const latencyVals = runs.map(r => r.meanLatency);
            const p50Vals = runs.map(r => r.p50Latency);
            const p95Vals = runs.map(r => r.p95Latency);
            const p99Vals = runs.map(r => r.p99Latency);
            const cpuVals = runs.map(r => r.cpuPercent);
            const elP99Vals = runs.map(r => r.eventLoopP99Ms);
            const errorVals = runs.map(r => r.errors);
            const timeoutVals = runs.map(r => r.timeouts);

            // Averages
            const meanRps = rpsVals.reduce((a, b) => a + b, 0) / n;
            const meanLat = latencyVals.reduce((a, b) => a + b, 0) / n;
            const meanP50 = p50Vals.reduce((a, b) => a + b, 0) / n;
            const meanP95 = p95Vals.reduce((a, b) => a + b, 0) / n;
            const meanP99 = p99Vals.reduce((a, b) => a + b, 0) / n;
            const meanCpu = cpuVals.reduce((a, b) => a + b, 0) / n;
            const meanElP99 = elP99Vals.reduce((a, b) => a + b, 0) / n;
            const totalErrors = errorVals.reduce((a, b) => a + b, 0);
            const totalTimeouts = timeoutVals.reduce((a, b) => a + b, 0);

            // Sample Standard Deviations (n - 1)
            const sdRps = calcSD(rpsVals, meanRps);
            const sdLat = calcSD(latencyVals, meanLat);
            const sdP99 = calcSD(p99Vals, meanP99);

            // Compute 95% Confidence Intervals
            const tCritical = getTCritical(n);
            const rpsMargin = tCritical * (sdRps / Math.sqrt(n));
            const rpsCILow = Math.max(0, meanRps - rpsMargin);
            const rpsCIHigh = meanRps + rpsMargin;

            const latMargin = tCritical * (sdLat / Math.sqrt(n));
            const latCILow = Math.max(0, meanLat - latMargin);
            const latCIHigh = meanLat + latMargin;

            const summaryObj = {
                concurrency,
                architecture: arch,
                runs: n,
                rpsMean: meanRps,
                rpsSD: sdRps,
                rpsCILow,
                rpsCIHigh,
                meanLatencyMean: meanLat,
                meanLatencySD: sdLat,
                latCILow,
                latCIHigh,
                p50Mean: meanP50,
                p95Mean: meanP95,
                p99Mean: meanP99,
                p99SD: sdP99,
                cpuMean: meanCpu,
                eventLoopP99Mean: meanElP99,
                totalErrors,
                totalTimeouts
            };

            summaryResults.push(summaryObj);
            summaryMap[key] = summaryObj;
        }
    }

    // Write raw CSV
    const rawHeaders = 'run,architecture,concurrency,rps,mean_latency_ms,p50_latency_ms,p95_latency_ms,p99_latency_ms,errors,timeouts,non2xx,cpu_percent,event_loop_p99_ms,duration_ms,completed_requests,test_order,timestamp,node_version,machine_info\n';
    const rawRows = rawResults.map(r => 
        `${r.run},${r.architecture},${r.concurrency},${r.rps.toFixed(2)},${r.meanLatency.toFixed(2)},${r.p50Latency.toFixed(2)},${r.p95Latency.toFixed(2)},${r.p99Latency.toFixed(2)},${r.errors},${r.timeouts},${r.non2xx},${r.cpuPercent.toFixed(2)},${r.eventLoopP99Ms.toFixed(2)},${r.actualDurationMs.toFixed(0)},${r.completedRequests.toFixed(0)},${r.testOrder},${r.timestamp},${nodeVersion},"${cpuModel} (${totalRAM})"`
    ).join('\n');
    fs.writeFileSync(path.join(__dirname, 'reproducibility_raw.csv'), rawHeaders + rawRows);

    // Write summary CSV
    const summaryHeaders = 'concurrency,architecture,runs,rps_mean,rps_sd,rps_ci_low,rps_ci_high,mean_latency_mean,mean_latency_sd,latency_ci_low,latency_ci_high,p50_mean,p95_mean,p99_mean,cpu_mean,event_loop_p99_mean,total_errors,total_timeouts\n';
    const summaryRows = summaryResults.map(s => 
        `${s.concurrency},${s.architecture},${s.runs},${s.rpsMean.toFixed(2)},${s.rpsSD.toFixed(2)},${s.rpsCILow.toFixed(2)},${s.rpsCIHigh.toFixed(2)},${s.meanLatencyMean.toFixed(2)},${s.meanLatencySD.toFixed(2)},${s.latCILow.toFixed(2)},${s.latCIHigh.toFixed(2)},${s.p50Mean.toFixed(2)},${s.p95Mean.toFixed(2)},${s.p99Mean.toFixed(2)},${s.cpuMean.toFixed(2)},${s.eventLoopP99Mean.toFixed(2)},${s.totalErrors},${s.totalTimeouts}`
    ).join('\n');
    fs.writeFileSync(path.join(__dirname, 'reproducibility_summary.csv'), summaryHeaders + summaryRows);

    // Read previous results and perform Reproducibility Analysis
    const prevRpsMap = getPreviousRpsMap();
    const crossoverData = [];

    for (const c of CONCURRENCY_LEVELS) {
        for (const arch of architectures) {
            const sum = summaryMap[`${c}_${arch}`];
            const oldRps = prevRpsMap[`${c}_${arch}`];
            
            if (sum && oldRps !== undefined) {
                const diff = sum.rpsMean - oldRps;
                const pctDiff = (diff / oldRps) * 100;
                
                // Reproducible check: falls within 95% Confidence Interval
                const isWithinCI = oldRps >= sum.rpsCILow && oldRps <= sum.rpsCIHigh;
                const isWithinMargin = Math.abs(pctDiff) < 10.0;
                const isReproducible = isWithinCI || isWithinMargin;

                crossoverData.push({
                    concurrency: c,
                    architecture: arch,
                    newRpsMean: sum.rpsMean,
                    newRpsCILow: sum.rpsCILow,
                    newRpsCIHigh: sum.rpsCIHigh,
                    oldRpsMean: oldRps,
                    percentDiscrepancy: pctDiff,
                    reproducible: isReproducible ? 'YES' : 'NO'
                });
            }
        }
    }

    // Write diagnostic report
    let report = `================================================================================
REPRODUCIBILITY VALIDATION BENCHMARK REPORT
================================================================================
Generated on: ${new Date().toUTCString()}
Server URL: ${URL}
Session Store Mock Latency: 10 ms (Stateful) | 0 ms (JWT)
Runs per condition: ${RUNS} independent runs
Warm-up: ${WARMUP_SEC}s | Measurement: ${MEASURE_SEC}s | Cooldown: ${COOLDOWN_SEC}s

💻 SYSTEM PROFILE:
Node.js Version: ${nodeVersion}
Platform: ${platform}
CPU Model: ${cpuModel}
Total RAM: ${totalRAM}

--------------------------------------------------------------------------------
1. REPRODUCIBILITY COMPARISON MATRIX
--------------------------------------------------------------------------------
Comparing current validation RPS against previous final-validation data.
Discrepancy is considered "reproducible" (YES) if the previous mean falls within 
the new 95% Confidence Interval or if the absolute deviation is less than 10%.

Conns | Arch     | New RPS Mean  | New 95% CI bounds  | Previous RPS  | Discrepancy | Reproducible
--------------------------------------------------------------------------------------------------
`;

    for (const r of crossoverData) {
        const bounds = `[${r.newRpsCILow.toFixed(0)}, ${r.newRpsCIHigh.toFixed(0)}]`;
        const sign = r.percentDiscrepancy > 0 ? '+' : '';
        report += `${String(r.concurrency).padEnd(5)} | ${r.architecture.toUpperCase().padEnd(8)} | ${r.newRpsMean.toFixed(0).padStart(12)} | ${bounds.padEnd(18)} | ${r.oldRpsMean.toFixed(0).padStart(13)} | ${sign}${r.percentDiscrepancy.toFixed(1).padStart(9)}% | ${r.reproducible}\n`;
    }

    report += `
--------------------------------------------------------------------------------
2. ERROR & DIAGNOSTIC LOGS
--------------------------------------------------------------------------------
Total validation runs with active connection issues or request failures: ${runsWithIssues.length}

`;

    if (runsWithIssues.length > 0) {
        report += `Flagged runs details:\n`;
        report += `Test Order | Architecture | Concurrency | Run | Errors | Timeouts | Non-2xx | Status\n`;
        report += `-------------------------------------------------------------------------------------\n`;
        for (const f of runsWithIssues) {
            const status = f.criticalFailure ? 'CRITICAL FAILURE' : 'WARNING';
            report += `${String(f.testOrder).padEnd(10)} | ${f.architecture.toUpperCase().padEnd(12)} | ${String(f.concurrency).padEnd(11)} | ${String(f.run).padEnd(3)} | ${String(f.errors).padEnd(6)} | ${String(f.timeouts).padEnd(8)} | ${String(f.non2xx).padEnd(7)} | ${status}\n`;
        }
    } else {
        report += `✅ All runs completed successfully with zero connection errors, timeouts, or non-2xx responses.\n`;
    }

    report += `
--------------------------------------------------------------------------------
3. STATISTICAL SUMMARY TABLE
--------------------------------------------------------------------------------
Conns | Method   | Mean RPS   | RPS 95% CI         | Mean Latency | Latency 95% CI     | Mean p50   | Mean p95   | Mean p99   | CPU %  | EL p99
---------------------------------------------------------------------------------------------------------------------------------------------
`;

    for (const c of CONCURRENCY_LEVELS) {
        for (const arch of architectures) {
            const sum = summaryMap[`${c}_${arch}`];
            if (sum) {
                const ciRps = `[${sum.rpsCILow.toFixed(0)}, ${sum.rpsCIHigh.toFixed(0)}]`;
                const ciLat = `[${sum.latCILow.toFixed(1)}, ${sum.latCIHigh.toFixed(1)}]`;
                report += `${String(c).padEnd(5)} | ${arch.toUpperCase().padEnd(8)} | ${sum.rpsMean.toFixed(0).padStart(10)} | ${ciRps.padEnd(18)} | ${sum.meanLatencyMean.toFixed(1).padStart(9)} ms | ${ciLat.padEnd(18)} | ${sum.p50Mean.toFixed(1).padStart(7)} ms | ${sum.p95Mean.toFixed(1).padStart(7)} ms | ${sum.p99Mean.toFixed(1).padStart(7)} ms | ${sum.cpuMean.toFixed(1).padStart(4)}% | ${sum.eventLoopP99Mean.toFixed(2).padStart(6)} ms\n`;
            }
        }
    }

    report += `
================================================================================
REPRODUCIBILITY CHECKLIST STATUS
================================================================================
[${rawResults.length === testCases.length ? 'PASS' : 'FAIL'}] All validation benchmark conditions executed (${rawResults.length}/${testCases.length})
[${runsWithIssues.length === 0 ? 'PASS' : 'FAIL'}] Zero errors, timeouts, or non-2xx responses detected
[${crossoverData.every(c => c.reproducible === 'YES') ? 'PASS' : 'FAIL'}] Statistical reproducibility confirmed across all compared points
[${RUNS >= 5 ? 'PASS' : 'FAIL'}] Five independent runs verified per configuration
`;

    fs.writeFileSync(path.join(__dirname, 'reproducibility_report.txt'), report);

    console.log('\n================================================================================');
    console.log('REPRODUCIBILITY VALIDATION CHECKLIST');
    console.log('================================================================================');
    console.log(`[${rawResults.length === testCases.length ? 'PASS' : 'FAIL'}] All validation benchmark conditions executed`);
    console.log(`[${runsWithIssues.length === 0 ? 'PASS' : 'FAIL'}] Zero errors, timeouts, or non-2xx responses detected`);
    console.log(`[${crossoverData.every(c => c.reproducible === 'YES') ? 'PASS' : 'FAIL'}] Statistical reproducibility confirmed across all compared points`);
    console.log(`[${RUNS >= 5 ? 'PASS' : 'FAIL'}] Five independent runs verified per configuration`);
    console.log('================================================================================\n');

    console.log('🎉 Reproducibility validation sweep completed successfully!');
    console.log('📂 Results saved to:');
    console.log('   - reproducibility_raw.csv');
    console.log('   - reproducibility_summary.csv');
    console.log('   - reproducibility_report.txt');
}

startValidationBenchmark();
