import { DatabaseSync } from 'node:sqlite';
import { createInitialData, isPrototypeData, type PrototypeData } from '../src/model.ts';

export type Snapshot = { revision: number; data: PrototypeData };

// A versioned prototype document keeps linked task/event edits atomic. Replace
// this with domain tables before introducing provider sync or real deadlines.
export function openStore(path: string, initialData: PrototypeData = createInitialData()) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workspace (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), updated_at TEXT NOT NULL
    );
    PRAGMA user_version=1;`);
  db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, 0, ?, ?)')
    .run(JSON.stringify(initialData), new Date().toISOString());

  function read(): Snapshot {
    const row = db.prepare('SELECT revision, data FROM workspace WHERE id=1').get();
    if (!row || typeof row.data !== 'string' || typeof row.revision !== 'number') throw new Error('Invalid workspace row');
    const data: unknown = JSON.parse(row.data);
    if (!isPrototypeData(data)) throw new Error('Invalid stored workspace');
    return { revision: row.revision, data };
  }

  function save(revision: number, data: PrototypeData): Snapshot | null {
    const result = db.prepare('UPDATE workspace SET revision=revision+1, data=?, updated_at=? WHERE id=1 AND revision=?')
      .run(JSON.stringify(data), new Date().toISOString(), revision);
    return result.changes === 1 ? read() : null;
  }
  return { read, save, close: () => db.close() };
}

export type Store = ReturnType<typeof openStore>;
