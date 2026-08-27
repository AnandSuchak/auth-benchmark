const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, 'benchmark_grid_results.json');
const csvPath = path.join(__dirname, 'benchmark_grid_results.csv');

if (!fs.existsSync(jsonPath)) {
    console.error('❌ Error: benchmark_grid_results.json not found! Run the benchmark grid first.');
    process.exit(1);
}

try {
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const { runs } = JSON.parse(rawData);
    
    let csv = 'Method,Connections (VUs),Duration (s),Throughput (RPS),Mean Latency (ms),p90 Latency (ms),p99 Latency (ms),Errors,Avg CPU %,Avg Memory (MB)\n';
    
    for (const r of runs) {
        csv += `${r.method.toUpperCase()},${r.connections},${r.duration},${r.rps.toFixed(0)},${r.meanLatency.toFixed(1)},${r.p90Latency.toFixed(0)},${r.p99Latency.toFixed(0)},${r.errors},${r.avgCpu.toFixed(1)},${r.avgMem.toFixed(0)}\n`;
    }
    
    fs.writeFileSync(csvPath, csv);
    console.log(`\n🎉 CSV generated successfully at:`);
    console.log(`   ${csvPath}`);
    console.log(`   You can now open this file directly in Excel or upload it to Google Sheets!\n`);
} catch (e) {
    console.error('❌ Error parsing JSON or writing CSV:', e.message);
    process.exit(1);
}
