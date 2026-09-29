import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "extraction-fan-out",
  { minutes: 5 },
  internal.spark.extractionFanOut,
);
crons.interval(
  "close-stale-active-sessions",
  { minutes: 5 },
  internal.spark.closeStaleActiveSessions,
  {},
);
crons.interval(
  "bridge-stuck-sessions",
  { minutes: 10 },
  internal.knowledge.sweepStuckSessionBridges,
  {},
);
crons.cron(
  "daily-synthesis",
  "0 8 * * *",
  internal.spark.dailySynthesis,
);
crons.cron(
  "weekly-synthesis",
  "0 9 * * 1",
  internal.spark.weeklySynthesis,
);
crons.cron(
  "monthly-synthesis",
  "0 10 1 * *",
  internal.spark.monthlySynthesis,
);
crons.interval(
  "synthesis-stale-sweep",
  { minutes: 30 },
  internal.spark.synthesisStaleSweep,
);
crons.interval(
  "knowledge-lint",
  { minutes: 30 },
  internal.spark.runLinter,
);
crons.cron(
  "dream-cycle",
  "30 3 * * *",
  internal.dreamCycle.dreamCycleFanOut,
  {},
);
crons.interval(
  "agent-scheduler",
  { minutes: 5 },
  internal.agents.agentScheduler,
  {},
);
crons.interval(
  "mcp-rate-limit-retention",
  { minutes: 60 },
  internal.spark.cleanupMcpRateLimitRows,
);
crons.interval(
  "gorgias-poll",
  { minutes: 15 },
  internal.composio.pollGorgiasForAllOrgs,
);

export default crons;
