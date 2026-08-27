# Performance and Tail-Latency Trade-offs Between Stateless JWT and Stateful Session Authentication

[![Paper](https://img.shields.io/badge/Paper-TechRxiv-blue.svg)](#) *(Note: Add your TechRxiv link here once published)*
[![Node.js](https://img.shields.io/badge/Node.js-v24.11.1-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

This repository contains the benchmarking infrastructure, raw datasets, and statistical analysis for evaluating the scalability of **Stateless JSON Web Tokens (JWT)** versus **Stateful Session Authentication** in Node.js microservices.

## 📌 Abstract / Overview
Authentication architectures dictate strict operational constraints in scalable web services. While stateless JSON Web Tokens (JWT) are operationally convenient, continuous cryptographic verification (HMAC-SHA256) introduces computational overhead under heavy load. Stateful session authentication shifts this cost from computation to session-store access, introducing network I/O latency. 

Through highly controlled, randomized, and repeated benchmarking (using Autocannon and Express.js), this project maps the exact performance crossover surface. The findings demonstrate that while JWT is exceptionally fast at low concurrency, event-loop starvation causes severe tail-latency degradation under high load. Conversely, stateful sessions (modeled with a synthetic 10ms I/O delay) scale significantly better by yielding the execution thread.

## 💻 Hardware & Environment Specifications
To ensure absolute reproducibility, all benchmarks were executed in the following environment:
* **OS:** Windows 11 Home (64-bit)
* **CPU:** 12th Gen Intel(R) Core(TM) i5-1240P (12 Cores, 16 Threads)
* **RAM:** 16.0 GB
* **Runtime:** Node.js `v24.11.1`
* **Framework:** Express `v4.19.2`
* **JWT Library:** `jsonwebtoken v9.0.2` (Algorithm: HS256)

## 📂 Repository Structure
* `/benchmarks/`: Contains the Node.js Express server and the Autocannon test suites.
* `/data/raw/`: Contains the raw CSV outputs of every HTTP request, error, and timeout.
* `/data/processed/`: Contains the statistically aggregated results (Mean, Standard Deviation, 95% CI).
* `/paper/`: Contains the finalized, peer-review-ready manuscript in PDF format.

## 🚀 How to Reproduce the Benchmarks

**1. Install Dependencies**
```bash
cd benchmarks
npm install express jsonwebtoken autocannon
```

**2. Start the Target Server**
The server exposes `/auth/none`, `/auth/jwt`, and `/auth/stateful?delay=10`.
```bash
node server.js
```

**3. Execute the Benchmark Suites**
Open a second terminal. To run the high-resolution, 10-run crossover sweep (focusing on 175-225 concurrent connections):
```bash
node test1_concurrency_sweep.js
```
*Note: The script automatically shuffles the execution order and includes 15-second warm-ups and 3-second cooldowns to prevent JIT and thermal throttling bias.*

## 📊 Key Findings
* **Low Concurrency Dominance**: At 10 concurrent connections, JWT outperforms the 10ms stateful model by over 15x in throughput.
* **The Crossover**: Stateful session throughput linearly overtakes JWT precisely between 195 and 200 concurrent connections.
* **Tail-Latency Volatility**: At >200 connections, JWT experiences severe CPU contention, causing p99 tail latency to accelerate past 100ms. The stateful architecture's p99 remains bounded at ~35ms.

## 📝 Citation
If you utilize this benchmarking methodology or dataset in your research, please cite the associated TechRxiv preprint:

```bibtex
@article{suchak2026authentication,
  title={Performance Benchmarking of Stateless JWT and Stateful Session Authentication Under Increasing Concurrency},
  author={Suchak, Anand S.},
  journal={TechRxiv},
  year={2026},
  publisher={IEEE}
}
```
