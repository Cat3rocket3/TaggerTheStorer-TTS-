// db.js
const sql = require("mssql");

const config = {
  user: 'sa',
  password: '144g144gG@',      // same as in docker run and SSMS
  server: 'localhost',         // host machine talking to Docker
  port: 1433,                  // from -p 1433:1433
  database: 'TaggedFileBrowser233',     // the DB you created
  options: {
    encrypt: true,             // matches "Encrypt: Mandatory"
    trustServerCertificate: true
  }
};

let pool = null;

async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(config);
  return pool;
}

module.exports = {
  sql,
  getPool,
};
