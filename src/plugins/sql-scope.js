const PREROLL_TABLES = new Set([
  'preroll_buckets',
  'preroll_items',
  'preroll_schedules',
  'preroll_steps',
  'preroll_history',
  'preroll_state',
]);

const RECOMMENDATION_TABLES = new Set([
  'rec_letterboxd_imports',
  'rec_letterboxd_films',
  'rec_letterboxd_activity',
  'rec_schedules',
  'rec_runs',
  'rec_items',
  'rec_tmdb_movies',
  'rec_streaming_cache',
]);

const SQL_SCOPES = {
  'sql.preroll': PREROLL_TABLES,
  'sql.recommendations': RECOMMENDATION_TABLES,
};

const SQL_KEYWORDS = new Set([
  'set',
  'select',
  'from',
  'where',
  'into',
  'values',
  'and',
  'or',
  'as',
  'on',
  'do',
  'conflict',
  'excluded',
  'datetime',
  'null',
  'not',
  'exists',
  'if',
  'order',
  'by',
  'limit',
  'left',
  'right',
  'inner',
  'outer',
  'join',
  'case',
  'when',
  'then',
  'else',
  'end',
  'collate',
  'nocase',
  'asc',
  'desc',
]);

/**
 * Extract likely table identifiers from SQL (best-effort allowlist gate).
 * @param {string} sql
 * @returns {string[]}
 */
export function extractSqlTableNames(sql) {
  const text = String(sql || '');
  const names = new Set();
  // Avoid matching "DO UPDATE SET" — require a real table name after UPDATE
  const patterns = [
    /\bFROM\s+([a-zA-Z_][\w]*)/gi,
    /\bJOIN\s+([a-zA-Z_][\w]*)/gi,
    /\bINTO\s+([a-zA-Z_][\w]*)/gi,
    /\bUPDATE\s+(?!SET\b)([a-zA-Z_][\w]*)/gi,
    /\bTABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi,
    /\bDELETE\s+FROM\s+([a-zA-Z_][\w]*)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const name = m[1].toLowerCase();
      if (!SQL_KEYWORDS.has(name)) names.add(name);
    }
  }
  return [...names];
}

/**
 * @param {string} sql
 * @param {Set<string>} allowlist
 */
export function assertSqlTablesAllowed(sql, allowlist = PREROLL_TABLES) {
  const names = extractSqlTableNames(sql);
  for (const name of names) {
    if (!allowlist.has(name)) {
      throw new Error(`SQL references disallowed table: ${name}`);
    }
  }
  if (names.length === 0 && /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
    // Subquery-only or unusual SQL — reject rather than allow through
    throw new Error('SQL must reference an allowlisted table');
  }
}

/**
 * @param {Iterable<string>} permissions
 * @returns {Set<string>}
 */
export function allowlistForPermissions(permissions) {
  const allow = new Set();
  for (const perm of permissions || []) {
    const tables = SQL_SCOPES[perm];
    if (!tables) continue;
    for (const name of tables) allow.add(name);
  }
  return allow;
}

export function hasSqlPermission(permissions) {
  for (const perm of permissions || []) {
    if (SQL_SCOPES[perm]) return true;
  }
  return false;
}

/**
 * Wrap better-sqlite3 so prepare/exec only touch allowlisted tables.
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} [allowlist]
 */
export function createScopedSql(db, allowlist = PREROLL_TABLES) {
  return {
    prepare(sql) {
      assertSqlTablesAllowed(sql, allowlist);
      return db.prepare(sql);
    },
    exec(sql) {
      assertSqlTablesAllowed(sql, allowlist);
      return db.exec(sql);
    },
    transaction(fn) {
      return db.transaction(fn);
    },
  };
}

export { PREROLL_TABLES, RECOMMENDATION_TABLES, SQL_SCOPES };
