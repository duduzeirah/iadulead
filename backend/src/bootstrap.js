require('dotenv').config();

const { spawn } = require('child_process');

console.log('🚀 Rodando migração automática...');

const migrate = spawn('node', ['src/db/migrate.js'], {
  stdio: 'inherit',
  env: process.env
});

migrate.on('close', (code) => {
  if (code !== 0) {
    console.error('❌ Migração falhou');
    process.exit(1);
  }

  console.log('✅ Migração OK. Iniciando servidor...');

  const server = spawn('node', ['src/server.js'], {
    stdio: 'inherit',
    env: process.env
  });

  server.on('close', (code) => {
    process.exit(code);
  });
});
