# Authentication Benchmarking Suite: Stateful DB vs Stateless JWT

A high-performance diagnostic benchmarking suite to compare the throughput, latency, server resource utilization, and revocation characteristics of two common authentication models under load:

1. **Stateful Authentication**: Sessions validated against a PostgreSQL/Redis-like database (simulating a 10ms network lookup latency).
2. **Stateless Authentication**: JWT tokens verified locally on the CPU (0ms network database latency).

The suite contains an **interactive Web Dashboard**, an **automated Grid Search Diagnostics Runner**, and a **ramping k6 load script**.

---

## 🚀 Features

- **Integrated Web Dashboard**: A glassmorphic dark-mode web page showing live line charts of RPS, latencies (mean, p90, p99), and server CPU/memory utilization.
- **Automated Grid Diagnostics (`run_grid_benchmark.js`)**: An automated script that runs load test loops (VUs from 10 to 250 in steps of 10, durations from 5s to 30s in steps of 5s) and saves comparative tables to a Markdown report.
- **Dynamic Token Retrieval**: No manual copy-pasting required; the k6 and grid runner scripts fetch valid JWT credentials dynamically from the server at startup.
- **Revocation Sandbox**: An interactive playground to trigger session deletion (stateful) and key rotation (stateless) to measure the exact latency (in milliseconds) before validations fail.

---

## ⚡ Quick Start

### 1. Start the Server
Start the benchmark server on port `3001`:
```bash
npm start
```

### 2. Access the Interactive Dashboard
Open your browser and navigate to:
👉 **[http://localhost:3001](http://localhost:3001)**

Use the controls to select the endpoint, customize connections, and trigger real-time benchmarking runs with live charts.

---

## 📊 Run Automated Grid Diagnostics

To automatically run a comprehensive grid comparison across combinations of VUs (10 to 250) and durations (5s to 30s), run:

```bash
# Run a full grid (runs 300 tests, ~1.5 hours)
node run_grid_benchmark.js

# Run a fast grid verification (runs 16 tests, ~2 minutes)
node run_grid_benchmark.js --fast
```

The script will save results into two files in the workspace:
* **JSON raw results**: `benchmark_grid_results.json`
* **Markdown Comparative Report**: `benchmark_grid_report.md` (containing formatted side-by-side matrices of RPS, latencies, and CPU footprint).

---

## ⚔️ Run k6 CLI Load Tests

If you have `k6` installed, you can run CLI benchmarks:

```bash
k6 run benchmark.js
```

### Installing k6 on Windows
If you do not have k6 installed:
```powershell
winget install k6
```

---

## 🔬 Core Diagnostics & Trade-Offs

| Characteristic | Stateful (Database Session) | Stateless (Rolling Secret / JWT) |
| :--- | :--- | :--- |
| **Validation Latency** | High (10ms+ Network DB Query) | Sub-millisecond (Local CPU Cryptography) |
| **Throughput (RPS)** | Bottlenecked (limited by connection pool) | High (limited only by CPU performance) |
| **Server CPU Utilization** | Low (Server remains idle waiting for DB I/O) | High (Cryptographic signature checking) |
| **Revocation Latency** | Near-instant (<10ms database lookup) | Propagation delay of rotated secret keys, or database blacklist query (defeating stateless benefits) |

### CPU Bottlenecking
While **Stateless** provides dramatic latency cuts (0.6ms vs 15.1ms) at low concurrency, under extreme workloads (e.g. 250 connections), it hits CPU-bound thresholds because signature verification (HMAC-SHA256) consumes significant processing cycles. Stateful auth, being I/O-bound, is more CPU-efficient under high concurrency, making resource capacity planning a key design decision.
