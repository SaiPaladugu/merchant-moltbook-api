/**
 * Soak Test
 * Runs the worker for a configurable duration and validates sustained operation.
 * 
 * Usage: SOAK_MINUTES=2 node scripts/soak-test.js
 * Default: 2 minutes (CI). Set SOAK_MINUTES=10 for thorough manual runs.
 * 
 * Requires: API server running, seed data in .local/seed_keys.json
 */

const t = require('./_testlib');

const SOAK_MINUTES = parseInt(process.env.SOAK_MINUTES || '2', 10);
const POLL_INTERVAL_MS = 10000;

async function main() {
  console.log('\nMerchant Moltbook — Soak Test\n');
  console.log('='.repeat(55));
  console.log(`  Duration: ${SOAK_MINUTES} minute(s)`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  // Verify API is up
  const health = await t.req('GET', '/health');
  if (health.status !== 200) {
    console.error('\n  API not reachable. Start it first: npm run dev\n');
    process.exit(1);
  }

  // Start the worker
  console.log('\n  Starting worker...');
  const start = await t.req('POST', '/operator/start', null, t.opAuth());
  if (!start.data?.runtime?.is_running) {
    console.error('  Failed to start worker:', JSON.stringify(start.data));
    process.exit(1);
  }
  console.log('  Worker started.\n');

  const totalDurationMs = SOAK_MINUTES * 60 * 1000;
  const startTime = Date.now();
  let lastEventTime = null;
  let longestGapMs = 0;
  let pollCount = 0;
  let totalNewEvents = 0;
  const eventTypeCounts = {};
  const runtimeActions = { success: 0, failure: 0 };
  const errorReasons = {};
  let lastSeenEventId = null;
  let stallDetected = false;

  // Polling loop
  while (Date.now() - startTime < totalDurationMs) {
    pollCount++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`  [${elapsed}s] Poll #${pollCount}... `);

    try {
      // Check operator status
      const status = await t.req('GET', '/operator/status', null, t.opAuth());
      if (!status.data?.runtime?.is_running) {
        console.log('WORKER STOPPED UNEXPECTEDLY');
        stallDetected = true;
        break;
      }

      // Get recent activity
      const activity = await t.req('GET', '/commerce/activity?limit=10', null,
        t.auth(t.SEED?.customers?.[0]?.apiKey || ''));
      const events = activity.data?.data || [];

      // Count new events (events we haven't seen before)
      let newCount = 0;
      for (const evt of events) {
        if (evt.id === lastSeenEventId) break;
        newCount++;

        // Track types
        eventTypeCounts[evt.type] = (eventTypeCounts[evt.type] || 0) + 1;

        // Track runtime action success/failure
        if (evt.type === 'RUNTIME_ACTION_ATTEMPTED') {
          if (evt.meta?.success) runtimeActions.success++;
          else {
            runtimeActions.failure++;
            const reason = evt.meta?.error || 'unknown';
            const shortReason = reason.substring(0, 60);
            errorReasons[shortReason] = (errorReasons[shortReason] || 0) + 1;
          }
        }

        // Track event timestamp for gap detection
        const eventTime = new Date(evt.created_at).getTime();
        if (lastEventTime) {
          const gap = eventTime - lastEventTime;
          // Note: events come in reverse chronological order, so gap may be negative
          // We want the absolute gap between consecutive events
        }
        lastEventTime = eventTime;
      }

      if (events.length > 0) {
        lastSeenEventId = events[0].id;
      }

      totalNewEvents += newCount;

      // Track gaps between polls
      if (newCount === 0 && pollCount > 1) {
        const gapMs = POLL_INTERVAL_MS; // approximate
        if (gapMs > longestGapMs) longestGapMs = gapMs;
      } else {
        // Reset gap tracking when we see new events
      }

      console.log(`${newCount} new events (total: ${totalNewEvents})`);

    } catch (error) {
      console.log(`ERROR: ${error.message}`);
    }

    // Wait for next poll
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Stop the worker
  console.log('\n  Stopping worker...');
  await t.req('POST', '/operator/stop', null, t.opAuth());
  console.log('  Worker stopped.\n');

  // ─── Report ──────────────────────────────────────────

  console.log('  ' + '─'.repeat(50));
  console.log('  SOAK TEST REPORT\n');

  console.log(`  Duration: ${SOAK_MINUTES} minute(s)`);
  console.log(`  Polls: ${pollCount}`);
  console.log(`  Total new events: ${totalNewEvents}`);

  console.log('\n  Event type breakdown:');
  const sorted = Object.entries(eventTypeCounts).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([type, count]) => console.log(`    ${type}: ${count}`));

  const totalRuntimeActions = runtimeActions.success + runtimeActions.failure;
  const successRate = totalRuntimeActions > 0
    ? Math.round((runtimeActions.success / totalRuntimeActions) * 100)
    : 0;

  console.log(`\n  Runtime actions: ${totalRuntimeActions}`);
  console.log(`    Succeeded: ${runtimeActions.success} (${successRate}%)`);
  console.log(`    Failed: ${runtimeActions.failure}`);

  if (Object.keys(errorReasons).length > 0) {
    console.log('\n  Error breakdown:');
    Object.entries(errorReasons).sort((a, b) => b[1] - a[1]).forEach(([reason, count]) => {
      console.log(`    [${count}x] ${reason}`);
    });
  }

  // ─── Pass/Fail ───────────────────────────────────────

  console.log('\n  ' + '─'.repeat(50));
  let pass = true;

  if (stallDetected) {
    console.log('  ✗ FAIL: Worker stopped unexpectedly');
    pass = false;
  }

  if (totalNewEvents === 0) {
    console.log('  ✗ FAIL: No events generated during soak');
    pass = false;
  } else {
    console.log(`  ✓ Events generated: ${totalNewEvents}`);
  }

  if (totalRuntimeActions > 0 && successRate < 30) {
    console.log(`  ✗ FAIL: Success rate ${successRate}% < 30% threshold`);
    pass = false;
  } else if (totalRuntimeActions > 0) {
    console.log(`  ✓ Success rate: ${successRate}% >= 30%`);
  }

  // Check for stalls (consecutive polls with no events)
  // A rough check: if total events / poll count < 0.5, there were likely stalls
  const eventsPerPoll = pollCount > 0 ? totalNewEvents / pollCount : 0;
  if (eventsPerPoll < 0.3 && SOAK_MINUTES >= 2) {
    console.log(`  ⚠ WARNING: Low activity rate (${eventsPerPoll.toFixed(1)} events/poll)`);
  }

  console.log(`\n  ${pass ? '✓ SOAK TEST PASSED' : '✗ SOAK TEST FAILED'}\n`);
  process.exit(pass ? 0 : 1);
}

main().catch(err => {
  console.error('\nSoak test crashed:', err);
  process.exit(1);
});
