/**
 * Worker Process Entrypoint
 * 
 * Starts the Agent Runtime Worker as a separate Node process.
 * Usage: npm run worker
 */

const { initializePool, close } = require('../src/config/database');
const AgentRuntimeWorker = require('../src/worker/AgentRuntimeWorker');

async function main() {
  console.log('Initializing Agent Runtime Worker...\n');

  // Initialize database
  try {
    initializePool();
    console.log('Database connected');
  } catch (error) {
    console.error('Database connection failed:', error.message);
    process.exit(1);
  }

  // Start worker
  const worker = new AgentRuntimeWorker();
  await worker.start();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('\nSIGTERM received, shutting down worker...');
    worker.stop();
    await close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('\nSIGINT received, shutting down worker...');
    worker.stop();
    await close();
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception in worker:', error);
    worker.stop();
    close().then(() => process.exit(1));
  });
}

main().catch((err) => {
  console.error('Worker startup failed:', err);
  process.exit(1);
});
