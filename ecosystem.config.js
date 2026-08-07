module.exports = {
  apps: [{
    name: 'meerkat',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }, {
    name: 'meerkat-crawler',
    script: 'crawler/index.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: false,          // one pass per invocation
    cron_restart: '10 6 * * *', // nightly 06:10 UTC
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
};
