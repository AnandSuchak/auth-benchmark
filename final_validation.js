/**
 * Final Crossover Validation Benchmark Runner
 * 
 * Concurrency: 190, 192, 195, 197, 200, 202, 205
 * Architecture: JWT, Stateful (10ms latency)
 * Runs: 10 independent runs per condition (140 runs total)
 * Warm-up: 15s | Measurement: 30s | Cooldown: 3s
 * Pipelining: 1
 * 
 * Exposes Event-Loop Delays (via monitorEventLoopDelay) and process CPU (average/peak).
 * 
 * Execution: node final_validation.js [--fast]
 */

const autocannon = require('autocannon');
const fs = require('fs');
const http = require('http');
const path = require('path');
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
let COOLDOWN_SEC = 3;

if (isFast) {
    console.log('⚡ FAST DIAGNOSTIC MODE: Running subset matrix for verification...');
    CONCURRENCY_LEVELS = [190, 195];
    RUNS = 2;
    WARMUP_SEC = 1;
    MEASURE_SEC = 2;
    COOLDOWN_SEC = 1;
} else {
    console.log('📊 FINAL CROSSOVER VALIDATION MODE: Running full matrix (140 runs)...');
    CONCURRENCY_LEVELS = [190, 192, 195, 197, 200, 202, 205];
    RUNS = 10;
    WARMUP_SEC = 15;
    MEASURE_SEC = 30;
    COOLDOWN_SEC = 3;
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

// Pearson Correlation Coefficient calculation
function calcPearsonCorrelation(x, y) {
    const n = x.length;
    if (n === 0) return 0;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    
    let num = 0;
    let denX = 0;
    let denY = 0;
    
    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
    }
    
    if (denX === 0 || denY === 0) return 0;
    return num / Math.sqrt(denX * denY);
}

// Run single autocannon instance with Event-Loop and CPU profiling
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
            
            // Initialize Event-Loop delay histogram
            const elDelay = monitorEventLoopDelay({ resolution: 10 });
            elDelay.enable();
            elDelay.reset(); // Clear JIT warm-up metrics

            // Initialize CPU tracking variables
            let startCpu = process.cpuUsage();
            let startTime = process.hrtime();
            let peakCpu = 0;
            let lastSampleCpu = process.cpuUsage();
            let lastSampleTime = process.hrtime();

            const cpuInterval = setInterval(() => {
                const sampleCpu = process.cpuUsage(lastSampleCpu);
                const sampleTime = process.hrtime(lastSampleTime);
                lastSampleCpu = process.cpuUsage();
                lastSampleTime = process.hrtime();
                
                const sampleTimeMs = sampleTime[0] * 1000 + sampleTime[1] / 1000000;
                const sampleCpuPercent = (100 * (sampleCpu.user / 1000 + sampleCpu.system / 1000)) / sampleTimeMs;
                if (sampleCpuPercent > peakCpu) {
                    peakCpu = sampleCpuPercent;
                }
            }, 200);

            // 2. Measurement Phase
            const measureInstance = autocannon({
                url: URL + reqPath,
                connections: tc.concurrency,
                duration: MEASURE_SEC,
                headers,
                pipelining: 1
            }, (err, res) => {
                // Clear intervals and disable listeners
                clearInterval(cpuInterval);
                elDelay.disable();
                
                if (err) return reject(err);

                // Compute final CPU usage statistics
                const elapCpu = process.cpuUsage(startCpu);
                const elapTime = process.hrtime(startTime);
                const elapTimeMs = elapTime[0] * 1000 + elapTime[1] / 1000000;
                const avgCpu = (100 * (elapCpu.user / 1000 + elapCpu.system / 1000)) / elapTimeMs;

                // Extract Event Loop metrics (nanoseconds to milliseconds)
                const elMean = elDelay.mean / 1e6;
                const elP50 = elDelay.percentile(50) / 1e6;
                const elP99 = elDelay.percentile(99) / 1e6;
                const elMax = elDelay.max / 1e6;

                // Calculate precise HTTP latency percentiles
                let p50Val = 0;
                let p90Val = 0;
                let p99Val = 0;
                let maxVal = 0;

                if (latencies.length > 0) {
                    latencies.sort((a, b) => a - b);
                    p50Val = latencies[Math.floor(latencies.length * 0.50)];
                    p90Val = latencies[Math.floor(latencies.length * 0.90)];
                    p99Val = latencies[Math.floor(latencies.length * 0.99)];
                    maxVal = latencies[latencies.length - 1];
                } else {
                    p50Val = res.latency.p50 || 0;
                    p90Val = res.latency.p90 || 0;
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
                    p90Latency: p90Val,
                    p99Latency: p99Val,
                    maxLatency: maxVal,
                    errors: res.errors,
                    timeouts: res.timeouts,
                    non2xx: res.non2xx,
                    cpuAvgPercent: avgCpu,
                    cpuPeakPercent: peakCpu,
                    eventLoopMeanMs: elMean,
                    eventLoopP50Ms: elP50,
                    eventLoopP99Ms: elP99,
                    eventLoopMaxMs: elMax
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

    console.log(`🚀 Shuffled final validation matrix initialized. Executing ${testCases.length} runs...`);

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
                p90Latency: 0,
                p99Latency: 0,
                maxLatency: 0,
                errors: 1,
                timeouts: 0,
                non2xx: 0,
                cpuAvgPercent: 0,
                cpuPeakPercent: 0,
                eventLoopMeanMs: 0,
                eventLoopP50Ms: 0,
                eventLoopP99Ms: 0,
                eventLoopMaxMs: 0
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
            const p99Vals = runs.map(r => r.p99Latency);
            const cpuVals = runs.map(r => r.cpuAvgPercent);
            const elP99Vals = runs.map(r => r.eventLoopP99Ms);
            const errorVals = runs.map(r => r.errors + r.timeouts);

            // Compute averages
            const meanRps = rpsVals.reduce((a, b) => a + b, 0) / n;
            const meanLat = latencyVals.reduce((a, b) => a + b, 0) / n;
            const meanP99 = p99Vals.reduce((a, b) => a + b, 0) / n;
            const meanCpu = cpuVals.reduce((a, b) => a + b, 0) / n;
            const meanElP99 = elP99Vals.reduce((a, b) => a + b, 0) / n;
            const totalErrors = errorVals.reduce((a, b) => a + b, 0);

            // Compute Standard Deviations
            const sdRps = calcSD(rpsVals, meanRps);
            const sdLat = calcSD(latencyVals, meanLat);
            const sdP99 = calcSD(p99Vals, meanP99);
            const sdCpu = calcSD(cpuVals, meanCpu);
            const sdElP99 = calcSD(elP99Vals, meanElP99);

            const summaryObj = {
                concurrency,
                architecture: arch,
                runs: n,
                rpsMean: meanRps,
                rpsSD: sdRps,
                meanLatencyMean: meanLat,
                meanLatencySD: sdLat,
                p99Mean: meanP99,
                p99SD: sdP99,
                cpuMean: meanCpu,
                cpuSD: sdCpu,
                eventLoopP99Mean: meanElP99,
                eventLoopP99SD: sdElP99,
                totalErrors
            };

            summaryResults.push(summaryObj);
            summaryMap[key] = summaryObj;
        }
    }

    // Write raw CSV output
    const rawHeaders = 'architecture,concurrency,run,rps,mean_latency_ms,p90_latency_ms,p99_latency_ms,errors,non2xx,cpu_avg_percent,cpu_peak_percent,event_loop_mean_ms,event_loop_p50_ms,event_loop_p99_ms,event_loop_max_ms\n';
    const rawRows = rawResults.map(r => 
        `${r.architecture},${r.concurrency},${r.run},${r.rps.toFixed(2)},${r.meanLatency.toFixed(2)},${r.p90Latency.toFixed(2)},${r.p99Latency.toFixed(2)},${r.errors},${r.non2xx},${r.cpuAvgPercent.toFixed(2)},${r.cpuPeakPercent.toFixed(2)},${r.eventLoopMeanMs.toFixed(2)},${r.eventLoopP50Ms.toFixed(2)},${r.eventLoopP99Ms.toFixed(2)},${r.eventLoopMaxMs.toFixed(2)}`
    ).join('\n');
    fs.writeFileSync(path.join(__dirname, 'raw-final-validation.csv'), rawHeaders + rawRows);

    // Write summary CSV output
    const summaryHeaders = 'concurrency,architecture,runs,rps_mean,rps_sd,mean_latency_mean,mean_latency_sd,p99_mean,p99_sd,cpu_mean,cpu_sd,event_loop_p99_mean,event_loop_p99_sd,total_errors\n';
    const summaryRows = summaryResults.map(s => 
        `${s.concurrency},${s.architecture},${s.runs},${s.rpsMean.toFixed(2)},${s.rpsSD.toFixed(2)},${s.meanLatencyMean.toFixed(2)},${s.meanLatencySD.toFixed(2)},${s.p99Mean.toFixed(2)},${s.p99SD.toFixed(2)},${s.cpuMean.toFixed(2)},${s.cpuSD.toFixed(2)},${s.eventLoopP99Mean.toFixed(2)},${s.eventLoopP99SD.toFixed(2)},${s.totalErrors}`
    ).join('\n');
    fs.writeFileSync(path.join(__dirname, 'final-validation-summary.csv'), summaryHeaders + summaryRows);

    // Write JSON report
    const jsonReport = {
        metadata: {
            generatedAt: new Date().toISOString(),
            serverUrl: URL,
            runsPerCondition: RUNS,
            warmupSeconds: WARMUP_SEC,
            measurementSeconds: MEASURE_SEC,
            cooldownSeconds: COOLDOWN_SEC
        },
        summary: summaryResults,
        rawRuns: rawResults
    };
    fs.writeFileSync(path.join(__dirname, 'final-validation-report.json'), JSON.stringify(jsonReport, null, 2));

    // Perform Crossover Analysis
    const sortedConcurrencies = [...CONCURRENCY_LEVELS].sort((a, b) => a - b);
    
    // Crossover matrix
    const crossoverData = [];
    let lastJwtAdvantage = null;
    let firstStatefulAdvantage = null;

    for (const c of sortedConcurrencies) {
        const jwt = summaryMap[`${c}_jwt`];
        const stateful = summaryMap[`${c}_stateful`];

        if (jwt && stateful) {
            const diff = stateful.rpsMean - jwt.rpsMean;
            const pctDiff = (diff / jwt.rpsMean) * 100;
            const winner = diff > 0 ? 'STATEFUL' : 'JWT';

            crossoverData.push({
                concurrency: c,
                jwtRps: jwt.rpsMean,
                statefulRps: stateful.rpsMean,
                diff,
                pctDiff,
                winner,
                jwtP99: jwt.p99Mean,
                statefulP99: stateful.p99Mean,
                jwtCpu: jwt.cpuMean,
                statefulCpu: stateful.cpuMean,
                jwtElP99: jwt.eventLoopP99Mean,
                statefulElP99: stateful.eventLoopP99Mean
            });

            if (winner === 'JWT') {
                lastJwtAdvantage = c;
            } else if (winner === 'STATEFUL' && firstStatefulAdvantage === null) {
                firstStatefulAdvantage = c;
            }
        }
    }

    // Determine observed crossover interval
    let crossoverInterval = 'N/A';
    if (lastJwtAdvantage !== null && firstStatefulAdvantage !== null) {
        crossoverInterval = `${lastJwtAdvantage}–${firstStatefulAdvantage}`;
    }

    // Event Loop vs HTTP tail-latency correlation check
    const jwtElP99List = sortedConcurrencies.map(c => summaryMap[`${c}_jwt`].eventLoopP99Mean);
    const jwtHttpP99List = sortedConcurrencies.map(c => summaryMap[`${c}_jwt`].p99Mean);
    const jwtCorrelation = calcPearsonCorrelation(jwtElP99List, jwtHttpP99List);

    // Print final console summary
    console.log('\n================================================');
    console.log('FINAL CROSSOVER VALIDATION');
    console.log('================================================\n');
    console.log('Concurrency | JWT RPS   | Stateful RPS | Winner   | JWT p99   | Stateful p99 | JWT CPU | Stateful CPU | JWT EL p99 | Stateful EL p99');
    console.log('---------------------------------------------------------------------------------------------------------------------------------------');
    
    for (const row of crossoverData) {
        console.log(
            `${String(row.concurrency).padEnd(11)} | ` +
            `${row.jwtRps.toFixed(0).padStart(9)} | ` +
            `${row.statefulRps.toFixed(0).padStart(12)} | ` +
            `${row.winner.padEnd(8)} | ` +
            `${row.jwtP99.toFixed(1).padStart(7)} ms | ` +
            `${row.statefulP99.toFixed(1).padStart(9)} ms | ` +
            `${row.jwtCpu.toFixed(1).padStart(5)}% | ` +
            `${row.statefulCpu.toFixed(1).padStart(10)}% | ` +
            `${row.jwtElP99.toFixed(2).padStart(7)} ms | ` +
            `${row.statefulElP99.toFixed(2).padStart(12)} ms`
        );
    }
    console.log('---------------------------------------------------------------------------------------------------------------------------------------');
    console.log(`\nLast JWT advantage: ${lastJwtAdvantage ? lastJwtAdvantage + ' concurrent connections' : 'None'}`);
    console.log(`First Stateful advantage: ${firstStatefulAdvantage ? firstStatefulAdvantage + ' concurrent connections' : 'None'}`);
    console.log(`Observed crossover interval: ${crossoverInterval} concurrent connections`);
    
    const totalJwtErrors = crossoverData.reduce((sum, r) => sum + (summaryMap[`${r.concurrency}_jwt`].totalErrors), 0);
    const totalStatefulErrors = crossoverData.reduce((sum, r) => sum + (summaryMap[`${r.concurrency}_stateful`].totalErrors), 0);
    console.log(`JWT errors: ${totalJwtErrors}`);
    console.log(`Stateful errors: ${totalStatefulErrors}`);
    console.log(`Event-loop correlation: Pearson correlation r = ${jwtCorrelation.toFixed(4)} between JWT Event-loop p99 and HTTP p99 latency.`);
    console.log('================================================\n');

    console.log('🎉 Final crossover validation sweep completed successfully!');
    console.log('📂 Reports generated:');
    console.log('   - raw-final-validation.csv');
    console.log('   - final-validation-summary.csv');
    console.log('   - final-validation-report.json');
}

startValidationBenchmark();
