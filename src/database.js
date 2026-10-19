
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

const caminhoEnv = path.resolve(__dirname, '../.env');

const resultadoEnv = dotenv.config({
  path: caminhoEnv,
  override: false
});

if (resultadoEnv.error) {
  console.error(
    'VortexGrid: erro ao carregar .env:',
    resultadoEnv.error.code || resultadoEnv.error.message
  );
}

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  connectTimeout: 10000
};

// Diagnóstico seguro: nunca registra a senha.
console.log('VortexGrid - Diagnóstico de configuração:', {
  arquivoEnvEncontrado: !resultadoEnv.error,
  caminhoEnv,
  transporte: 'UNIX socket',
  socket: '/run/mysql/mysql.sock',
  banco: config.database,
  usuario: config.user,
  senhaConfigurada: Boolean(config.password),
  tamanhoSenha: config.password?.length ?? 0,
  espacosNasExtremidades: config.password
    ? config.password !== config.password.trim()
    : false
});

const ausentes = [];

if (!config.user) ausentes.push('DB_USER');
if (!config.password) ausentes.push('DB_PASSWORD');
if (!config.database) ausentes.push('DB_NAME');

if (ausentes.length > 0) {
  throw new Error(
    `VortexGrid: variáveis ausentes: ${ausentes.join(', ')}`
  );
}

// Teste de conexão pelo socket Unix utilizado pelo PHP.
const pool = mysql.createPool({
  socketPath: '/run/mysql/mysql.sock',
  user: config.user,
  password: config.password,
  database: config.database,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  connectTimeout: 10000
});

async function testarConexao() {
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(`
      SELECT
        DATABASE() AS banco,
        VERSION() AS versao,
        USER() AS usuario_conexao,
        CURRENT_USER() AS usuario_autenticado,
        @@hostname AS servidor
    `);

    console.log('VortexGrid: conexão MariaDB estabelecida.', {
      banco: rows[0].banco,
      usuarioConexao: rows[0].usuario_conexao,
      usuarioAutenticado: rows[0].usuario_autenticado,
      servidor: rows[0].servidor
    });

    return {
      conectado: true,
      ...rows[0]
    };
  } catch (error) {
    console.error('VortexGrid - Diagnóstico de conexão:', {
      codigo: error.code || 'DESCONHECIDO',
      numero: error.errno || null,
      estado: error.sqlState || null,
      mensagem: error.message || 'Erro sem mensagem',
      syscall: error.syscall || null,
      fatal: error.fatal ?? null
    });

    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

module.exports = pool;
module.exports.testarConexao = testarConexao;
