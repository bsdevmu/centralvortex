
require('dotenv').config({ path: '/home/SEU_USUARIO/domains/SEU_DOMINIO/private_nodejs/.env' });

const mariadb = require('mariadb');

async function testar() {
  let conn;

  try {
    conn = await mariadb.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectTimeout: 10000
    });

    const resultado = await conn.query(`
      SELECT
        DATABASE() AS banco,
        VERSION() AS versao,
        CURRENT_USER() AS usuario
    `);

    console.log('CONEXAO_MARIADB_OK');
    console.log(JSON.stringify(resultado[0]));
  } catch (erro) {
    console.error('CONEXAO_MARIADB_FALHOU');
    console.error('Codigo:', erro.code || 'SEM_CODIGO');
    console.error('Mensagem:', erro.message);
  } finally {
    if (conn) await conn.end();
  }
}

testar();
