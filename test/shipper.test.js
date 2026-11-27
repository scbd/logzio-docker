'use strict';

// Integration tests for the logzio-docker image.
//
// The shipper never talks to Logz.io here: it is pointed at a local fake
// HTTP listener started by this test, with a fake token. The Docker socket
// is mounted read-only into the shipper container only, and the shipper is
// limited to the test's own "noise" container with --matchByName.
//
// Requirements: docker and Node >= 22 on the host.
// Usage: IMAGE=logzio-docker:test npm test
//   IMAGE      image to test (default logzio-docker:test)
//   PLATFORM   docker --platform (default linux/amd64)
//   PORT       host port for the fake listener (default 18230)
//   PREFIX     container name prefix (default logzio-test-)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const IMAGE = process.env.IMAGE || 'logzio-docker:test';
const PLATFORM = process.env.PLATFORM || 'linux/amd64';
const PORT = Number(process.env.PORT || 18230);
const PREFIX = process.env.PREFIX || 'logzio-test-';
const SHIPPER = `${PREFIX}shipper`;
const NOISE = `${PREFIX}noise`;
const MARKER = `hello-${PREFIX}${process.pid}`;
const FAKE_TOKEN = 'fake-test-token';

const received = []; // { url, record }
let server;

function docker(args, opts = {}) {
    return execFileSync('docker', args, { encoding: 'utf8', ...opts });
}

function removeContainer(name) {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}

async function waitFor(predicate, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const found = predicate();
        if (found) return found;
        await new Promise((r) => setTimeout(r, 500));
    }
    return predicate();
}

function satisfiesEngines(version) {
    const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
    const gte = (a, b, c) =>
        major > a || (major === a && (minor > b || (minor === b && patch >= c)));
    return (major === 22 && gte(22, 23, 4)) ||
        (major === 24 && gte(24, 22, 1)) ||
        gte(26, 12, 1);
}

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            for (const line of body.split('\n')) {
                if (!line.trim()) continue;
                try {
                    received.push({ url: req.url, record: JSON.parse(line) });
                } catch (e) {
                    received.push({ url: req.url, record: { unparsable: line } });
                }
            }
            res.writeHead(200);
            res.end();
        });
    });
    await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));

    removeContainer(SHIPPER);
    removeContainer(NOISE);
    docker([
        'run', '-d', '--platform', PLATFORM, '--name', SHIPPER,
        '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
        '--add-host', 'fake-listener.test:host-gateway',
        '-e', `LOGZIO_TOKEN=${FAKE_TOKEN}`,
        '-e', `ENDPOINT_PORT=${PORT}`,
        '-e', 'ENDPOINT_URL_PATH=/fake-path',
        '-e', `DOCKER_API_VERSION=${process.env.DOCKER_API_VERSION || '1.44'}`,
        IMAGE,
        '--endpoint', 'fake-listener.test', '--no-secure', '--no-stats',
        // Docker reports names with a leading slash.
        '--matchByName', `^/${NOISE}$`,
    ]);
    // Give the shipper time to attach to the Docker event stream.
    await new Promise((r) => setTimeout(r, 5000));
    docker([
        'run', '-d', '--name', NOISE, 'alpine:3',
        'sh', '-c', `sleep 2; echo ${MARKER}; sleep 3`,
    ]);
});

after(() => {
    removeContainer(SHIPPER);
    removeContainer(NOISE);
    if (server) server.close();
});

test('Node version in image satisfies engines.node', () => {
    assert.equal(pkg.engines.node, '^22.23.4 || ^24.22.1 || >=26.12.1');
    const version = docker(['run', '--rm', '--platform', PLATFORM, '--entrypoint', 'node', IMAGE, '--version']).trim();
    assert.ok(satisfiesEngines(version), `node ${version} does not satisfy ${pkg.engines.node}`);
    const nodes = docker(['run', '--rm', '--platform', PLATFORM, '--entrypoint', 'sh', IMAGE, '-c', 'which -a node']).trim().split('\n');
    assert.equal(nodes.length, 1, `expected a single node binary, got ${nodes.join(', ')}`);
});

test('prints usage and exits 1 without a token', () => {
    const r = spawnSync('docker', ['run', '--rm', '--platform', PLATFORM, IMAGE], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Usage: docker-logzio/);
    assert.equal(r.stderr.trim(), '');
});

test('container log lines reach the fake listener', async () => {
    const hit = await waitFor(
        () => received.find((r) => r.record.message === MARKER),
        45000,
    );
    assert.ok(hit, `log line ${MARKER} never arrived; got ${received.length} records`);
    assert.equal(hit.record.name, NOISE);
    assert.equal(hit.record.type, 'docker_logs');
    assert.equal(hit.record.logzio_codec, 'plain');
    assert.ok(hit.record['@timestamp']);
    assert.ok(hit.url.startsWith('/fake-path?'), `unexpected url ${hit.url}`);
    assert.ok(hit.url.includes(`token=${FAKE_TOKEN}`));
});

test('docker events for the noise container reach the fake listener', async () => {
    const hit = await waitFor(
        () => received.find((r) => r.record.action_type && r.record.name === NOISE),
        45000,
    );
    assert.ok(hit, 'no docker-events record for the noise container');
    assert.ok(['create', 'start', 'die'].includes(hit.record.action_type));
});

test('shipper starts cleanly (no errors or warnings on stderr)', () => {
    const r = spawnSync('docker', ['logs', SHIPPER], { encoding: 'utf8' });
    assert.match(r.stdout, /Starting with config:/);
    assert.equal(r.stderr.trim(), '', `stderr: ${r.stderr}`);
    const state = docker(['inspect', '-f', '{{.State.Running}}', SHIPPER]).trim();
    assert.equal(state, 'true');
});
