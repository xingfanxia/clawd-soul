import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import config from './config.js';
import provider from './provider.js';

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
let _db = null;

function getDb() {
  if (_db) return _db;

  const dbPath = path.join(config.DATA_DIR, 'memory.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  sqliteVec.load(_db);

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,           -- 'observation' | 'chat' | 'event'
      summary TEXT NOT NULL,
      detail TEXT,
      app TEXT,
      timestamp TEXT NOT NULL,
      mood_energy REAL,
      mood_interest REAL,
      mood_affection REAL
    );

    CREATE TABLE IF NOT EXISTS diary (
      date TEXT PRIMARY KEY,        -- YYYY-MM-DD
      content TEXT NOT NULL,
      mood_energy REAL,
      mood_interest REAL,
      mood_affection REAL,
      created_at TEXT NOT NULL
    );
  `);

  // FTS5 virtual table for keyword search
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      summary,
      detail,
      content=episodes,
      content_rowid=rowid
    );
  `);

  // FTS triggers to keep index in sync
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, summary, detail)
      VALUES (new.rowid, new.summary, new.detail);
    END;
  `);

  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, summary, detail)
      VALUES ('delete', old.rowid, old.summary, old.detail);
    END;
  `);

  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, summary, detail)
      VALUES ('delete', old.rowid, old.summary, old.detail);
      INSERT INTO episodes_fts(rowid, summary, detail)
      VALUES (new.rowid, new.summary, new.detail);
    END;
  `);

  // Vector table for semantic search (768-dim Gemini embedding-001)
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episode_vectors USING vec0(
      embedding float[768]
    );
  `);

  // Mapping table: vector rowid → episode id
  _db.exec(`
    CREATE TABLE IF NOT EXISTS episode_vector_map (
      vec_rowid INTEGER PRIMARY KEY,
      episode_id TEXT NOT NULL,
      FOREIGN KEY (episode_id) REFERENCES episodes(id)
    );
  `);

  return _db;
}

// ---------------------------------------------------------------------------
// Episode CRUD
// ---------------------------------------------------------------------------

const INSERT_EPISODE = () => getDb().prepare(`
  INSERT OR REPLACE INTO episodes (id, type, summary, detail, app, timestamp, mood_energy, mood_interest, mood_affection)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Add an episodic memory */
async function addEpisode({ type, summary, detail, app, mood }) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  INSERT_EPISODE().run(
    id, type, summary, detail || null, app || null, timestamp,
    mood?.energy ?? null, mood?.interest ?? null, mood?.affection ?? null,
  );

  // Generate and store embedding (fire-and-forget, don't block)
  embedEpisode(id, summary + (detail ? ` ${detail}` : '')).catch((err) => {
    console.error('[memory] embedding failed:', err.message);
  });

  return id;
}

/** Embed an episode and store in vector table */
async function embedEpisode(episodeId, text) {
  if (!config.hasEmbeddingKey()) return;

  const embedding = await provider.embed(text);
  if (!embedding) return;

  const db = getDb();
  const vecRowid = db.prepare(`INSERT INTO episode_vectors(embedding) VALUES (?)`).run(
    new Float32Array(embedding),
  ).lastInsertRowid;

  db.prepare(`INSERT OR REPLACE INTO episode_vector_map(vec_rowid, episode_id) VALUES (?, ?)`).run(
    vecRowid, episodeId,
  );
}

/** Get recent episodes */
function getRecent(limit = 20) {
  return getDb().prepare(`
    SELECT * FROM episodes ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

/** Get recent episodes of a specific type */
function getRecentByType(type, limit = 10) {
  return getDb().prepare(`
    SELECT * FROM episodes WHERE type = ? ORDER BY timestamp DESC LIMIT ?
  `).all(type, limit);
}

// ---------------------------------------------------------------------------
// Hybrid search: BM25 + Vector
// ---------------------------------------------------------------------------

/** FTS5 keyword search (BM25 ranking) */
function searchBM25(query, limit = 10) {
  try {
    return getDb().prepare(`
      SELECT e.*, bm25(episodes_fts) AS bm25_score
      FROM episodes_fts fts
      JOIN episodes e ON e.rowid = fts.rowid
      WHERE episodes_fts MATCH ?
      ORDER BY bm25_score
      LIMIT ?
    `).all(query, limit);
  } catch {
    // FTS query syntax error — fall back to LIKE
    return getDb().prepare(`
      SELECT *, 0 AS bm25_score FROM episodes
      WHERE summary LIKE ? OR detail LIKE ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit);
  }
}

/** Vector similarity search */
async function searchVector(query, limit = 10) {
  if (!config.hasEmbeddingKey()) return [];

  const embedding = await provider.embed(query);
  if (!embedding) return [];

  const db = getDb();
  const vecResults = db.prepare(`
    SELECT rowid, distance
    FROM episode_vectors
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(new Float32Array(embedding), limit);

  if (vecResults.length === 0) return [];

  // Map vector rowids → episode IDs
  const results = [];
  for (const vr of vecResults) {
    const map = db.prepare(`SELECT episode_id FROM episode_vector_map WHERE vec_rowid = ?`).get(vr.rowid);
    if (map) {
      const episode = db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(map.episode_id);
      if (episode) {
        results.push({ ...episode, vec_distance: vr.distance });
      }
    }
  }
  return results;
}

/**
 * Hybrid search: BM25 + Vector → merge + rerank
 * Returns top-K most relevant episodes
 */
async function search(query, limit = 5) {
  // Run both searches in parallel
  const [bm25Results, vecResults] = await Promise.all([
    Promise.resolve(searchBM25(query, 10)),
    searchVector(query, 10),
  ]);

  // Merge and dedup by episode ID
  const seen = new Map();

  for (const ep of bm25Results) {
    // BM25 scores are negative (lower = better), normalize to 0–1
    const normalizedBm25 = 1 / (1 + Math.abs(ep.bm25_score));
    seen.set(ep.id, { ...ep, bm25Score: normalizedBm25, vecScore: 0 });
  }

  for (const ep of vecResults) {
    // Vector distance: 0 = identical, normalize to similarity 0–1
    const vecSimilarity = 1 / (1 + ep.vec_distance);
    if (seen.has(ep.id)) {
      seen.get(ep.id).vecScore = vecSimilarity;
    } else {
      seen.set(ep.id, { ...ep, bm25Score: 0, vecScore: vecSimilarity });
    }
  }

  // Rerank: weighted combination
  const ranked = [...seen.values()]
    .map((ep) => ({
      ...ep,
      combinedScore: 0.6 * ep.vecScore + 0.4 * ep.bm25Score,
    }))
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);

  return ranked;
}

// ---------------------------------------------------------------------------
// Diary CRUD
// ---------------------------------------------------------------------------

/** Save a diary entry */
function saveDiary(date, content, mood) {
  getDb().prepare(`
    INSERT OR REPLACE INTO diary (date, content, mood_energy, mood_interest, mood_affection, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(date, content, mood?.energy ?? null, mood?.interest ?? null, mood?.affection ?? null, new Date().toISOString());
}

/** Get diary entry for a specific date */
function getDiary(date) {
  return getDb().prepare(`SELECT * FROM diary WHERE date = ?`).get(date);
}

/** List recent diary entries */
function listDiary(limit = 7) {
  return getDb().prepare(`SELECT * FROM diary ORDER BY date DESC LIMIT ?`).all(limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get today's episodes (for diary generation) */
function getTodayEpisodes(type) {
  const today = new Date().toISOString().slice(0, 10);
  const query = type
    ? `SELECT * FROM episodes WHERE timestamp >= ? AND type = ? ORDER BY timestamp ASC`
    : `SELECT * FROM episodes WHERE timestamp >= ? ORDER BY timestamp ASC`;
  return type
    ? getDb().prepare(query).all(`${today}T00:00:00`, type)
    : getDb().prepare(query).all(`${today}T00:00:00`);
}

/** Get episode count */
function count() {
  return getDb().prepare(`SELECT COUNT(*) as count FROM episodes`).get().count;
}

/** Close the database cleanly */
function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Jaccard similarity (word-level)
// ---------------------------------------------------------------------------

/** Tokenize text into a set of lowercase words, handling CJK characters */
function tokenize(text) {
  if (!text) return new Set();
  const tokens = new Set();
  // Split on whitespace, then further split CJK chars as individual tokens
  const parts = text.toLowerCase().split(/\s+/);
  for (const part of parts) {
    // Extract CJK characters as individual tokens
    const cjkChars = part.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
    if (cjkChars) {
      for (const ch of cjkChars) tokens.add(ch);
    }
    // Extract non-CJK word segments (len > 1)
    const nonCjk = part.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ').split(/\s+/);
    for (const word of nonCjk) {
      if (word.length > 1) tokens.add(word);
    }
  }
  return tokens;
}

/** Word-level Jaccard similarity between two texts */
function jaccardSimilarity(textA, textB) {
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of setA) {
    if (setB.has(token)) intersectionSize += 1;
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// ---------------------------------------------------------------------------
// MMR (Maximal Marginal Relevance) selection
// ---------------------------------------------------------------------------

/** Select results maximizing relevance while penalizing redundancy */
function mmrSelect(results, limit) {
  if (results.length <= limit) return results;

  const selected = [];
  const remaining = [...results];

  // Greedily pick the highest-scoring first
  remaining.sort((a, b) => b.combinedScore - a.combinedScore);
  selected.push(remaining.shift());

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.combinedScore;

      // Max similarity to any already-selected result
      const maxSim = selected.reduce(
        (max, sel) => Math.max(max, jaccardSimilarity(candidate.summary, sel.summary)),
        0,
      );

      const mmrScore = 0.7 * relevance - 0.3 * maxSim;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Auto-recall with temporal decay + MMR
// ---------------------------------------------------------------------------

/** Enhanced search with temporal decay and MMR diversity */
async function autoRecall(query, limit = 5) {
  const overFetched = await search(query, limit * 2);
  if (!overFetched || overFetched.length === 0) return [];

  const now = Date.now();

  // Apply temporal decay (immutable — create new scored array)
  const decayed = overFetched.map((result) => {
    const ageDays = (now - new Date(result.timestamp).getTime()) / 86400000;
    return { ...result, combinedScore: result.combinedScore * Math.exp(-0.01 * ageDays) };
  });

  // Apply MMR for diversity, then return top `limit`
  return mmrSelect(decayed, limit);
}

export default {
  addEpisode, getRecent, getRecentByType,
  search, searchBM25,
  saveDiary, getDiary, listDiary,
  getTodayEpisodes, count, close,
  getDb, autoRecall,
};
