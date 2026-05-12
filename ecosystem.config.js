// PM2 process manager config
// Usage: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name:          'scorecard',
    script:        'server.js',
    instances:     1,
    autorestart:   true,
    watch:         false,
    max_restarts:  10,
    restart_delay: 3000,
    env: {
      NODE_ENV: 'production',
      PORT:     3000,
    },
    error_file: './logs/err.log',
    out_file:   './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
