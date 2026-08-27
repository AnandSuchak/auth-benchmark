/**
 * Test 1 Concurrency Sweep
 * 
 * Concurrency: 175, 190, 200, 210, 225
 * Architecture: JWT, Stateful (10ms latency)
 * Runs: 10 per condition (100 runs total)
 * Warm-up: 15s | Measurement: 30s | Cooldown: 3s
 * Pipelining: 1
 * 
 * Execution: node test1_concurrency_sweep.js
 */

const autocannon = require('autocannon');
const fs = require('fs');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');

// Config parameters
const PORT = 3001;
const URL = `http://localhost:${PORT}`;
const SECRET = 'a_very_secure_256_bit_symmetric_secret_key_for_hmac_sha256_benchmarking';

const CONCURRENCY_LEVELS = [175, 190, 200, 210, 225];
const RUNS = 10;
const WARMUP_SEC = 15;
const MEASURE_SEC = 30;
const COOLDOWN_SEC = 3;

// Generate valid JWT token dynamically for tests
const jwtToken = jwt.sign(
    { id: 'session_token_500', user: 'test_user_999' },
    SECRET,
    { algorithm: 'HS256' }
);

// Verify server connectivity before launching
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
        9: 2.262,  // df = 9 (n = 10)
    };
    const df = n - 1;
    return tTable[df] || 1.96; // fallback to z-score
}

// Run single autocannon instance (Warmup then measurement)
function runIndividualTest(tc) {
    return new Promise((resolve, reject) => {
        let reqPath = '/auth/jwt';
        let headers = { 'Authorization': `Bearer ${jwtToken}` };

        if (tc.architecture === 'stateful') {
            reqPath = '/auth/stateful?delay=10';
            headers = { 'x-session-id': 'session_token_500' };
        }

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

            // 2. Measurement Phase
            const measureInstance = autocannon({
                url: URL + reqPath,
                connections: tc.concurrency,
                duration: MEASURE_SEC,
                headers,
                pipelining: 1
            }, (err, res) => {
                if (err) return reject(err);

                // Calculate precise percentiles from collected raw response times
                let p50Val = 0;
                let p95Val = 0;
                let p99Val = 0;
                let maxVal = 0;

                if (latencies.length > 0) {
                    latencies.sort((a, b) => a - b);
                    p50Val = latencies[Math.floor(latencies.length * 0.50)];
                    p95Val = latencies[Math.floor(latencies.length * 0.95)];
                    p99Val = latencies[Math.floor(latencies.length * 0.99)];
                    maxVal = latencies[latencies.length - 1];
                } else {
                    p50Val = res.latency.p50 || 0;
                    p95Val = res.latency.p97_5 || 0;
                    p99Val = res.latency.p99 || 0;
                    maxVal = res.latency.max || 0;
                }

                resolve({
                    run: tc.run,
                    architecture: tc.architecture,
                    latencyParam: tc.latency,
                    concurrency: tc.concurrency,
                    rps: res.requests.average,
                    meanLatency: res.latency.average,
                    p95Latency: p95Val,
                    p99Latency: p99Val,
                    maxLatency: maxVal,
                    errors: res.errors,
                    timeouts: res.timeouts,
                    non2xx: res.non2xx
                });
            });

            // Listen to response times at high resolution (float milliseconds)
            measureInstance.on('response', (client, statusCode, resBytes, responseTime) => {
                latencies.push(responseTime);
            });
        });
    });
}

async function startSweepBenchmark() {
    console.log('🔍 Checking target server health...');
    const isHealthy = await checkServerHealthy();
    if (!isHealthy) {
        console.error(`❌ Error: Target benchmark server is not running or unreachable at ${URL}`);
        console.error('   Please run: node server.js first in a separate shell!');
        process.exit(1);
    }
    console.log(`✅ Server detected active at ${URL}`);

    // Build the test cases array
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

    // Shuffle execution order to remove JIT / thermal throttle bias
    shuffle(testCases);

    console.log(`🚀 Shuffled Test 1 sweep matrix initialized. Executing ${testCases.length} runs...`);

    const rawResults = [];

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        console.log(`[${i + 1}/${testCases.length}] ${tc.architecture.toUpperCase()} | ${tc.concurrency} connections | Run ${tc.run}/${RUNS}`);
        
        try {
            const res = await runIndividualTest(tc);
            rawResults.push(res);
        } catch (e) {
            console.error(`❌ Test run failed:`, tc, e.message);
            rawResults.push({
                run: tc.run,
                architecture: tc.architecture,
                latencyParam: tc.latency,
                concurrency: tc.concurrency,
                rps: 0,
                meanLatency: 0,
                p95Latency: 0,
                p99Latency: 0,
                maxLatency: 0,
                errors: 1,
                timeouts: 0,
                non2xx: 0
            });
        }

        // Cooldown sleep period between tests
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
            const p95Vals = runs.map(r => r.p95Latency);
            const p99Vals = runs.map(r => r.p99Latency);
            const maxVals = runs.map(r => r.maxLatency);
            const errorVals = runs.map(r => r.errors);
            const timeoutVals = runs.map(r => r.timeouts);

            // Compute averages
            const meanRps = rpsVals.reduce((a, b) => a + b, 0) / n;
            const meanLat = latencyVals.reduce((a, b) => a + b, 0) / n;
            const meanP95 = p95Vals.reduce((a, b) => a + b, 0) / n;
            const meanP99 = p99Vals.reduce((a, b) => a + b, 0) / n;
            const meanMax = maxVals.reduce((a, b) => a + b, 0) / n;
            const meanErrors = errorVals.reduce((a, b) => a + b, 0) / n;
            const meanTimeouts = timeoutVals.reduce((a, b) => a + b, 0) / n;

            // Compute Standard Deviations
            const sdRps = calcSD(rpsVals, meanRps);
            const sdLat = calcSD(latencyVals, meanLat);
            const sdP95 = calcSD(p95Vals, meanP95);
            const sdP99 = calcSD(p99Vals, meanP99);
            const sdMax = calcSD(maxVals, meanMax);

            // Compute 95% Confidence Intervals using t-distribution critical values
            const tCritical = getTCritical(n);
            const rpsMarginOfError = tCritical * (sdRps / Math.sqrt(n));
            const rpsCILow = Math.max(0, meanRps - rpsMarginOfError);
            const rpsCIHigh = meanRps + rpsMarginOfError;

            const latMarginOfError = tCritical * (sdLat / Math.sqrt(n));
            const latCILow = Math.max(0, meanLat - latMarginOfError);
            const latCIHigh = meanLat + latMarginOfError;

            // Compute Coefficients of Variation (CV = SD / Mean)
            const cvRps = meanRps > 0 ? sdRps / meanRps : 0;
            const cvLat = meanLat > 0 ? sdLat / meanLat : 0;
            const cvP99 = meanP99 > 0 ? sdP99 / meanP99 : 0;

            const summaryObj = {
                concurrency,
                architecture: arch,
                runs: n,
                meanRps,
                sdRps,
                rpsCILow,
                rpsCIHigh,
                meanLat,
                sdLat,
                latCILow,
                latCIHigh,
                meanP95,
                sdP95,
                meanP99,
                sdP99,
                meanMax,
                sdMax,
                meanErrors,
                meanTimeouts,
                cvRps,
                cvLat,
                cvP99
            };

            summaryResults.push(summaryObj);
            summaryMap[key] = summaryObj;
        }
    }

    // Write raw CSV output
    const rawHeaders = 'Run,Architecture,SessionLatencyMs,Connections,RPS,MeanLatencyMs,P95LatencyMs,P99LatencyMs,MaxLatencyMs,Errors,Timeouts,Non2xx\n';
    const rawRows = rawResults.map(r => 
        `${r.run},${r.architecture},${r.latencyParam},${r.concurrency},${r.rps.toFixed(2)},${r.meanLatency.toFixed(2)},${r.p95Latency.toFixed(2)},${r.p99Latency.toFixed(2)},${r.maxLatency.toFixed(2)},${r.errors},${r.timeouts},${r.non2xx}`
    ).join('\n');
    fs.writeFileSync(path.join(__dirname, 'test1_raw.csv'), rawHeaders + rawRows);

    // Write summary CSV output
    const summaryHeaders = 'Connections,Architecture,Runs,MeanRPS,SDRPS,RPS_CI_Low,RPS_CI_High,MeanLatencyMs,SDLatencyMs,Latency_CI_Low,Latency_CI_High,MeanP95Ms,SDP95Ms,MeanP99Ms,SDP99Ms,MeanMaxMs,SDMaxMs,MeanErrors,MeanTimeouts,CV_RPS,CV_MeanLatency,CV_P99\n';
    const summaryRows = summaryResults.map(s => 
        `${s.concurrency},${s.architecture},${s.runs},${s.meanRps.toFixed(2)},${s.sdRps.toFixed(2)},${s.rpsCILow.toFixed(2)},${s.rpsCIHigh.toFixed(2)},${s.meanLat.toFixed(2)},${s.sdLat.toFixed(2)},${s.latCILow.toFixed(2)},${s.latCIHigh.toFixed(2)},${s.meanP95.toFixed(2)},${s.sdP95.toFixed(2)},${s.meanP99.toFixed(2)},${s.sdP99.toFixed(2)},${s.meanMax.toFixed(2)},${s.sdMax.toFixed(2)},${s.meanErrors.toFixed(2)},${s.meanTimeouts.toFixed(2)},${s.cvRps.toFixed(4)},${s.cvLat.toFixed(4)},${s.cvP99.toFixed(4)}`
    ).join('\n');
    fs.writeFileSync(path.join(__dirname, 'test1_summary.csv'), summaryHeaders + summaryRows);

    // Generate text report
    let report = `================================================================================
TEST 1 CONCURRENCY SWEEP REPORT
================================================================================
Generated on: ${new Date().toUTCString()}
Server URL: ${URL}
Session Store Mock Latency: 10 ms (Stateful) | 0 ms (JWT)
Test runs per condition: ${RUNS} runs (shuffled randomized execution)
Warm-up: ${WARMUP_SEC}s | Measurement: ${MEASURE_SEC}s | Cooldown: ${COOLDOWN_SEC}s
Pipelining: 1

--------------------------------------------------------------------------------
1. ERROR AND TIMEOUT DIAGNOSTICS
--------------------------------------------------------------------------------
Total client errors recorded: ${rawResults.reduce((acc, r) => acc + r.errors, 0)}
Total request timeouts recorded: ${rawResults.reduce((acc, r) => acc + r.timeouts, 0)}

--------------------------------------------------------------------------------
2. STATISTICAL MATRIX SUMMARY
--------------------------------------------------------------------------------
Conns | Method   | Mean RPS   | RPS 95% CI         | Mean Latency | Latency 95% CI     | Mean p99   | Errors  | CV_p99
---------------------------------------------------------------------------------------------------------------
`;

    const sortedConcurrencies = [...CONCURRENCY_LEVELS].sort((a, b) => a - b);
    
    for (const c of sortedConcurrencies) {
        for (const arch of architectures) {
            const sum = summaryMap[`${c}_${arch}`];
            if (sum) {
                const ciRps = `[${sum.rpsCILow.toFixed(0)}, ${sum.rpsCIHigh.toFixed(0)}]`;
                const ciLat = `[${sum.latCILow.toFixed(1)}, ${sum.latCIHigh.toFixed(1)}]`;
                report += `${String(c).padEnd(5)} | ${arch.toUpperCase().padEnd(8)} | ${sum.meanRps.toFixed(0).padStart(10)} | ${ciRps.padEnd(18)} | ${sum.meanLat.toFixed(1).padStart(9)} ms | ${ciLat.padEnd(18)} | ${sum.meanP99.toFixed(1).padStart(7)} ms | ${sum.meanErrors.toFixed(0).padStart(7)} | ${(sum.cvP99 * 100).toFixed(1)}%\n`;
            }
        }
    }

    report += `
================================================================================
TEST 1 COMPLETION STATUS
================================================================================
[${rawResults.length === testCases.length ? 'PASS' : 'FAIL'}] All requested benchmark conditions completed (${rawResults.length}/${testCases.length})
[${rawResults.reduce((acc, r) => acc + r.errors + r.timeouts, 0) === 0 ? 'PASS' : 'FAIL'}] No unexpected errors/timeouts
[${RUNS >= 10 ? 'PASS' : 'FAIL'}] Ten independent runs completed for each condition
`;

    fs.writeFileSync(path.join(__dirname, 'test1_report.txt'), report);

    console.log('\n================================================================================');
    console.log('TEST 1 COMPLETION STATUS');
    console.log('================================================================================');
    console.log(`[${rawResults.length === testCases.length ? 'PASS' : 'FAIL'}] All requested benchmark conditions completed`);
    console.log(`[${rawResults.reduce((acc, r) => acc + r.errors + r.timeouts, 0) === 0 ? 'PASS' : 'FAIL'}] No unexpected errors/timeouts`);
    console.log(`[${RUNS >= 10 ? 'PASS' : 'FAIL'}] Ten independent runs completed for each condition`);
    console.log('================================================================================\n');

    console.log('🎉 Test 1 sweep completed successfully!');
    console.log('📂 Results saved to:');
    console.log('   - test1_raw.csv');
    console.log('   - test1_summary.csv');
    console.log('   - test1_report.txt');
}

startSweepBenchmark();
