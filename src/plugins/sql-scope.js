const PREROLL_TABLES = new Set([
  'preroll_buckets',
  'preroll_items',
  'preroll_schedules',
  'preroll_steps',
  'preroll_history',
  'preroll_state',
]);

const TRAILER_TABLES = new Set(['trailer_downloads']);

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
  'sql.trailers': TRAILER_TABLES,
};

const DENIED_WORDS = new Set([
  'attach',
  'detach',
  'pragma',
  'vacuum',
  'reindex',
  'analyze',
  'load_extension',
]);

const STATEMENT_STARTS = new Set([
  'select',
  'insert',
  'replace',
  'update',
  'delete',
  'with',
  'values',
  'create',
  'drop',
  'alter',
]);

const FROM_CLAUSE_END = new Set([
  'where',
  'group',
  'having',
  'order',
  'limit',
  'window',
  'union',
  'intersect',
  'except',
  'returning',
  'select',
  'values',
  'set',
  'do',
]);

const NO_SKIP = new Set();
const IF_EXISTS_WORDS = new Set(['if', 'not', 'exists']);
const CONFLICT_WORDS = new Set(['or', 'rollback', 'abort', 'replace', 'fail', 'ignore']);
const NAME_TYPES = new Set(['word', 'ident', 'string']);

/**
 * Split SQLite SQL into tokens. Comments are dropped; identifiers are lowercased.
 * @param {string} sql
 * @returns {{ type: 'word'|'ident'|'string'|'number'|'param'|'punct', value?: string }[]}
 */
export function tokenizeSql(sql) {
  const text = String(sql ?? '');
  const tokens = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('SQL has an unterminated comment');
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      const [value, next] = readQuoted(text, i, "'");
      tokens.push({ type: 'string', value: value.toLowerCase() });
      i = next;
      continue;
    }
    if (ch === '"' || ch === '`') {
      const [value, next] = readQuoted(text, i, ch);
      tokens.push({ type: 'ident', value: value.toLowerCase() });
      i = next;
      continue;
    }
    if (ch === '[') {
      const end = text.indexOf(']', i + 1);
      if (end === -1) throw new Error('SQL has an unterminated identifier');
      tokens.push({ type: 'ident', value: text.slice(i + 1, end).toLowerCase() });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-\uffff]/.test(text[j])) j += 1;
      tokens.push({ type: 'word', value: text.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      let j = i + 1;
      while (
        j < n &&
        (/[\w.]/.test(text[j]) || ((text[j] === '+' || text[j] === '-') && /[eE]/.test(text[j - 1])))
      ) {
        j += 1;
      }
      tokens.push({ type: 'number' });
      i = j;
      continue;
    }
    if (ch === '?' || ch === ':' || ch === '@' || ch === '$') {
      let j = i + 1;
      while (j < n && /[\w$\u0080-\uffff]/.test(text[j])) j += 1;
      tokens.push({ type: 'param' });
      i = j;
      continue;
    }
    tokens.push({ type: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

function readQuoted(text, start, quote) {
  let i = start + 1;
  let out = '';
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        out += quote;
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    out += text[i];
    i += 1;
  }
  throw new Error('SQL has an unterminated quoted string');
}

function isPunct(token, value) {
  return token?.type === 'punct' && token.value === value;
}

function isWord(token, value) {
  return token?.type === 'word' && token.value === value;
}

function skipParens(tokens, start) {
  let depth = 0;
  for (let j = start; j < tokens.length; j += 1) {
    if (isPunct(tokens[j], '(')) depth += 1;
    else if (isPunct(tokens[j], ')')) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return tokens.length;
}

function collectCteNames(tokens, withIndex, into) {
  let j = withIndex + 1;
  if (isWord(tokens[j], 'recursive')) j += 1;
  while (j < tokens.length && NAME_TYPES.has(tokens[j].type)) {
    into.add(tokens[j].value);
    j += 1;
    if (isPunct(tokens[j], '(')) j = skipParens(tokens, j);
    if (!isWord(tokens[j], 'as')) return;
    j += 1;
    if (isWord(tokens[j], 'not')) j += 1;
    if (isWord(tokens[j], 'materialized')) j += 1;
    if (!isPunct(tokens[j], '(')) return;
    j = skipParens(tokens, j);
    if (!isPunct(tokens[j], ',')) return;
    j += 1;
  }
}

/**
 * Walk one SQLite statement and report every table it names.
 * Throws for multiple statements, denied statement types, and unreadable table references.
 * @param {string} sql
 * @returns {{ statement: string, tables: { name: string, schema: string|null }[], cteNames: Set<string> }}
 */
export function analyzeSql(sql) {
  const tokens = tokenizeSql(sql);
  while (tokens.length && isPunct(tokens[tokens.length - 1], ';')) tokens.pop();
  if (!tokens.length) throw new Error('SQL statement is empty');

  for (const t of tokens) {
    if (isPunct(t, ';')) throw new Error('SQL must be a single statement');
    if (t.type === 'word' && DENIED_WORDS.has(t.value)) {
      throw new Error(`SQL keyword is not allowed: ${t.value.toUpperCase()}`);
    }
    if (t.type === 'ident' && t.value === 'load_extension') {
      throw new Error('SQL keyword is not allowed: LOAD_EXTENSION');
    }
  }

  const first = tokens[0];
  if (first.type !== 'word' || !STATEMENT_STARTS.has(first.value)) {
    throw new Error('SQL statement type is not allowed');
  }
  const statement = first.value;
  const isCreateIndex =
    statement === 'create' &&
    (isWord(tokens[1], 'index') || (isWord(tokens[1], 'unique') && isWord(tokens[2], 'index')));
  if (statement === 'create' && !isWord(tokens[1], 'table') && !isCreateIndex) {
    throw new Error('Only CREATE TABLE and CREATE INDEX are allowed');
  }
  if ((statement === 'drop' || statement === 'alter') && !isWord(tokens[1], 'table')) {
    throw new Error(`Only ${statement.toUpperCase()} TABLE is allowed`);
  }

  const tables = [];
  const cteNames = new Set();
  const fromAtDepth = [false];
  let depth = 0;
  /** @type {{ kind: 'table'|'from', skip: Set<string> }|null} */
  let expect = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (expect) {
      if (t.type === 'word' && expect.skip.has(t.value)) continue;
      if (isPunct(t, '(') && expect.kind === 'from') {
        depth += 1;
        fromAtDepth[depth] = true;
        expect = { kind: 'from', skip: NO_SKIP };
        continue;
      }
      const startsSubquery =
        expect.kind === 'from' &&
        (isWord(t, 'select') || isWord(t, 'values') || isWord(t, 'with'));
      if (startsSubquery) {
        fromAtDepth[depth] = false;
        expect = null;
      } else if (NAME_TYPES.has(t.type)) {
        let name = t.value;
        let schema = null;
        if (isPunct(tokens[i + 1], '.') && NAME_TYPES.has(tokens[i + 2]?.type)) {
          schema = name;
          name = tokens[i + 2].value;
          i += 2;
        }
        tables.push({ name, schema });
        expect = null;
        continue;
      } else {
        throw new Error('SQL table reference could not be read');
      }
    }

    if (isPunct(t, '(')) {
      depth += 1;
      fromAtDepth[depth] = false;
      continue;
    }
    if (isPunct(t, ')')) {
      fromAtDepth[depth] = false;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (isPunct(t, ',')) {
      if (fromAtDepth[depth]) expect = { kind: 'from', skip: NO_SKIP };
      continue;
    }
    if (t.type !== 'word') continue;

    if (FROM_CLAUSE_END.has(t.value)) fromAtDepth[depth] = false;

    const prev = tokens[i - 1];
    switch (t.value) {
      case 'from':
        if (isWord(prev, 'distinct') && (isWord(tokens[i - 2], 'is') || isWord(tokens[i - 2], 'not'))) {
          break;
        }
        fromAtDepth[depth] = true;
        expect = { kind: 'from', skip: NO_SKIP };
        break;
      case 'join':
        fromAtDepth[depth] = true;
        expect = { kind: 'from', skip: NO_SKIP };
        break;
      case 'into':
      case 'references':
        expect = { kind: 'table', skip: NO_SKIP };
        break;
      case 'update':
        if (!isWord(prev, 'do')) expect = { kind: 'table', skip: CONFLICT_WORDS };
        break;
      case 'table':
        expect = { kind: 'table', skip: IF_EXISTS_WORDS };
        break;
      case 'on':
        if (isCreateIndex && depth === 0) expect = { kind: 'table', skip: NO_SKIP };
        break;
      case 'to':
        if (statement === 'alter' && depth === 0 && isWord(prev, 'rename')) {
          expect = { kind: 'table', skip: NO_SKIP };
        }
        break;
      case 'with':
        collectCteNames(tokens, i, cteNames);
        break;
      default:
        break;
    }
  }
  if (expect) throw new Error('SQL ends where a table name was expected');

  return { statement, tables, cteNames };
}

/**
 * Table names referenced by one SQL statement.
 * @param {string} sql
 * @returns {string[]}
 */
export function extractSqlTableNames(sql) {
  return [...new Set(analyzeSql(sql).tables.map((t) => t.name))];
}

function cteMayShadow(name, schemaNames) {
  if (!schemaNames) return false;
  if (name.startsWith('sqlite_') || name.startsWith('pragma_')) return false;
  return !schemaNames().has(name);
}

/**
 * @param {string} sql
 * @param {Set<string>} allowlist
 * @param {{ schemaNames?: (() => Set<string>)|null }} [opts] existing schema object names; a CTE may only use a name that is not one of them
 */
export function assertSqlTablesAllowed(sql, allowlist = PREROLL_TABLES, { schemaNames = null } = {}) {
  const { tables, cteNames } = analyzeSql(sql);
  if (tables.length === 0) {
    throw new Error('SQL must reference an allowlisted table');
  }
  for (const { name, schema } of tables) {
    if (schema && schema !== 'main') {
      throw new Error(`SQL references another database: ${schema}`);
    }
    if (allowlist.has(name)) continue;
    if (!schema && cteNames.has(name) && cteMayShadow(name, schemaNames)) continue;
    throw new Error(`SQL references disallowed table: ${name}`);
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

function wrapStatement(stmt) {
  const wrapper = {
    run: (...args) => stmt.run(...args),
    get: (...args) => stmt.get(...args),
    all: (...args) => stmt.all(...args),
    iterate: (...args) => stmt.iterate(...args),
    columns: () => stmt.columns(),
    pluck(...args) {
      stmt.pluck(...args);
      return wrapper;
    },
    expand(...args) {
      stmt.expand(...args);
      return wrapper;
    },
    raw(...args) {
      stmt.raw(...args);
      return wrapper;
    },
    safeIntegers(...args) {
      stmt.safeIntegers(...args);
      return wrapper;
    },
    bind(...args) {
      stmt.bind(...args);
      return wrapper;
    },
    get reader() {
      return stmt.reader;
    },
    get readonly() {
      return stmt.readonly;
    },
    get source() {
      return stmt.source;
    },
    get busy() {
      return stmt.busy;
    },
  };
  return Object.freeze(wrapper);
}

/**
 * Wrap better-sqlite3 so a tool can only run single statements against allowlisted
 * tables. Never return a raw Statement, transaction function, or the Database: each
 * exposes `.database`, which is the unscoped host connection.
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} [allowlist]
 */
export function createScopedSql(db, allowlist = PREROLL_TABLES) {
  const schemaQuery = () =>
    new Set(
      db
        .prepare('SELECT name FROM sqlite_master UNION SELECT name FROM sqlite_temp_master')
        .all()
        .map((row) => String(row.name).toLowerCase()),
    );

  function check(sql) {
    assertSqlTablesAllowed(sql, allowlist, { schemaNames: schemaQuery });
  }

  const scoped = {
    prepare(sql) {
      check(sql);
      return wrapStatement(db.prepare(sql));
    },
    exec(sql) {
      check(sql);
      const stmt = db.prepare(sql);
      if (stmt.reader) stmt.all();
      else stmt.run();
      return scoped;
    },
    transaction(fn) {
      if (typeof fn !== 'function') {
        throw new TypeError('transaction expects a function');
      }
      const tx = db.transaction((...args) => fn(...args));
      const run = (...args) => tx(...args);
      run.deferred = (...args) => tx.deferred(...args);
      run.immediate = (...args) => tx.immediate(...args);
      run.exclusive = (...args) => tx.exclusive(...args);
      return Object.freeze(run);
    },
  };
  return Object.freeze(scoped);
}

export { PREROLL_TABLES, RECOMMENDATION_TABLES, TRAILER_TABLES, SQL_SCOPES };
