const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function makeTempDbPath(prefix = 'tavern-test') {
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_-]+/g, '-');
  return path.join(os.tmpdir(), `${safePrefix}-${process.pid}-${crypto.randomUUID()}.db`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function cleanupDatabaseFiles(dbPath) {
  await Promise.all(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .map(file => fs.promises.rm(file, { force: true }))
  );
}

async function waitForServer(baseUrl, child, readOutput) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode}\n${readOutput()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {
      // The child has not bound its port yet.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready\n${readOutput()}`);
}

async function startServer({ dbPath = makeTempDbPath(), env: overrides = {} } = {}) {
  const port = await getFreePort();
  const env = {
    ...process.env,
    PORT: String(port),
    TAVERN_DB_PATH: dbPath,
    TAVERN_LOAD_ENV: '0',
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = String(value);
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(baseUrl, child, () => output);
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await cleanupDatabaseFiles(dbPath);
    throw error;
  }

  let stopped = false;
  return {
    child,
    baseUrl,
    dbPath,
    get output() { return output; },
    async stop({ cleanup = true } = {}) {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([
          new Promise(resolve => child.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 2_000)),
        ]);
      }
      if (cleanup) await cleanupDatabaseFiles(dbPath);
    },
  };
}

module.exports = {
  cleanupDatabaseFiles,
  getFreePort,
  makeTempDbPath,
  startServer,
};
