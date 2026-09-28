// All broker configuration comes from environment variables (set by docker-compose
// from .env). Read once here so the rest of the code never touches process.env.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL'),

  livekit: {
    apiUrl: required('LIVEKIT_URL'), // http://livekit:7880 (server-to-server API)
    wsUrl: process.env.LIVEKIT_WS_URL ?? required('LIVEKIT_URL').replace(/^http/, 'ws'),
    publicUrl: required('LIVEKIT_PUBLIC_URL'), // handed to browsers + endpoint clients
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret: required('LIVEKIT_API_SECRET'),
  },

  jwtSecret: required('JWT_SECRET'),
  operators: process.env.OPERATORS ?? '',
  endpointSecret: required('ENDPOINT_SECRET'),
  targetAllowlist: process.env.TARGET_ALLOWLIST ?? '*',
  requireRecording: (process.env.REQUIRE_RECORDING ?? 'true') === 'true',
  // local = auto track egress to the shared recordings volume (self-hosted LiveKit).
  // none  = no recording (e.g. LiveKit Cloud without object storage configured).
  recordingMode: (process.env.RECORDING_MODE ?? 'local') as 'local' | 'none',

  recordingsDir: process.env.RECORDINGS_DIR ?? '/recordings', // broker's read-only view
  egressOutDir: process.env.EGRESS_OUT_DIR ?? '/out', // same volume, as egress sees it
  consoleDir: process.env.CONSOLE_DIR ?? new URL('../../console/dist', import.meta.url).pathname,

  // Timings (seconds). Consent must be answered on the endpoint within 30 s; the
  // broker waits a bit longer so the endpoint's own "timeout = deny" wins normally.
  consentTimeoutS: 40,
  tokenTtlS: 120, // token is only needed to *join*; LiveKit refreshes it while connected
  recordingGraceS: 20,
  heartbeatTimeoutS: 20,
};

if (!['local', 'none'].includes(config.recordingMode)) {
  throw new Error(`RECORDING_MODE must be "local" or "none", got "${config.recordingMode}"`);
}
if (config.recordingMode === 'none' && config.requireRecording) {
  throw new Error('RECORDING_MODE=none requires REQUIRE_RECORDING=false (sessions would be ended for not recording)');
}
