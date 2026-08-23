// PM2 process manifest — one process per worker (isolated restarts + logs).
//
// On the VPS:
//   npm install
//   pm2 start ecosystem.config.cjs
//   pm2 save          # persist the process list
//   pm2 startup       # generate the boot script so it survives reboots
//
// If the sync worker crashes, the email worker keeps running, and vice versa.
module.exports = {
  apps: [
    {
      name: "lor-sync",
      script: "src/workers/sync.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production" },
    },
    {
      name: "lor-emails",
      script: "src/workers/emails.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: "256M",
      env: { NODE_ENV: "production" },
    },
  ],
};
