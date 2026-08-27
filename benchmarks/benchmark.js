import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = 'http://localhost:3001';
const SESSION_ID = 'valid_session_1234';

export const options = {
    // We define two concurrent scenarios to benchmark them side-by-side
    scenarios: {
        stateful_test: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '15s', target: 500 }, // Ramp to 500 concurrent users
                { duration: '30s', target: 500 }, // Hold load
                { duration: '15s', target: 0 },   // Ramp down
            ],
            exec: 'test_stateful', // Links to the function below
        },
        stateless_test: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '15s', target: 500 },
                { duration: '30s', target: 500 },
                { duration: '15s', target: 0 },
            ],
            exec: 'test_stateless',
        },
    }
};

// The setup function runs ONCE before load testing starts.
// It queries the server to get a fresh token dynamically, bypassing copy-pasting.
export function setup() {
    const res = http.get(`${BASE_URL}/api/v1/token`);
    if (res.status !== 200) {
        throw new Error(`Failed to fetch JWT token from benchmark server: ${res.status} ${res.body}`);
    }
    const token = res.json().token;
    console.log(`\n📋 DYNAMICALLY FETCHED JWT FOR K6 SCENARIO:\n${token}\n`);
    return { token };
}

export function test_stateful() {
    const res = http.get(`${BASE_URL}/api/v1/data-stateful`, {
        headers: { 'Authorization': SESSION_ID },
    });
    check(res, { 'Stateful OK': (r) => r.status === 200 }); // Validate success
    sleep(0.1); 
}

export function test_stateless(data) {
    // data is passed from setup() return object
    const res = http.get(`${BASE_URL}/api/v1/data-stateless`, {
        headers: { 'Authorization': data.token },
    });
    check(res, { 'Stateless OK': (r) => r.status === 200 }); // Validate success
    sleep(0.1);
}
