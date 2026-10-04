// WEB-SERVE1：@tauri-apps/plugin-sql 的網站版替身（vite mode=web alias）。
// 語意對齊原版：load/select/execute/close；execute 回 {lastInsertId, rowsAffected}。
// migration 由伺服器在池首開時跑（與桌面同一套 sqlx _sqlx_migrations）。
import { apiPost } from './core.js';

class Database {
  constructor(path) {
    this.path = path;
  }

  static async load(path) {
    await apiPost('/api/sql/select', { db: path, query: 'SELECT 1', values: [] });
    return new Database(path);
  }

  static get(path) {
    return new Database(path);
  }

  async execute(query, bindValues) {
    const [rowsAffected, lastInsertId] = await apiPost('/api/sql/execute', {
      db: this.path,
      query,
      values: bindValues ?? [],
    });
    return { lastInsertId, rowsAffected };
  }

  async select(query, bindValues) {
    return apiPost('/api/sql/select', {
      db: this.path,
      query,
      values: bindValues ?? [],
    });
  }

  async close(db) {
    return apiPost('/api/sql/close', db ? { db } : {});
  }
}

export default Database;
