const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function buildHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra,
  };
}

function buildFilterQuery(filters) {
  const params = new URLSearchParams();
  for (const filter of filters) {
    params.set(filter.column, filter.raw ? filter.value : `eq.${filter.value}`);
  }
  return params;
}

class SupabaseQueryBuilder {
  constructor(table) {
    this.table = table;
    this.action = 'select';
    this.columns = '*';
    this.payload = null;
    this.filters = [];
    this.limitValue = null;
    this.expectSingle = false;
    this.returnRepresentation = false;
  }

  select(columns = '*') {
    if (this.action === 'insert' || this.action === 'update') {
      this.returnRepresentation = true;
      if (columns) this.columns = columns;
      return this;
    }

    this.action = 'select';
    this.columns = columns;
    return this;
  }

  insert(payload) {
    this.action = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.action = 'update';
    this.payload = payload;
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
    return this;
  }

  not(column, operator, value) {
    this.filters.push({ column, value: `not.${operator}.${value}`, raw: true });
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  single() {
    this.expectSingle = true;
    return this.execute();
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${this.table}`);
    const query = buildFilterQuery(this.filters);

    if (this.action === 'select') {
      query.set('select', this.columns);
      if (this.limitValue != null) {
        query.set('limit', String(this.limitValue));
      }
      url.search = query.toString();

      const headers = buildHeaders(
        this.expectSingle
          ? { Accept: 'application/vnd.pgrst.object+json' }
          : { Accept: 'application/json' }
      );

      return parseSupabaseResponse(await fetch(url, { method: 'GET', headers }), this.expectSingle);
    }

    if (this.limitValue != null) {
      query.set('limit', String(this.limitValue));
    }
    if (this.returnRepresentation) {
      query.set('select', this.columns);
    }
    url.search = query.toString();

    const headers = buildHeaders({
      'Content-Type': 'application/json',
      Prefer: this.returnRepresentation ? 'return=representation' : 'return=minimal',
      Accept: this.expectSingle ? 'application/vnd.pgrst.object+json' : 'application/json',
    });

    const method = this.action === 'insert' ? 'POST' : 'PATCH';
    return parseSupabaseResponse(
      await fetch(url, {
        method,
        headers,
        body: JSON.stringify(this.payload),
      }),
      this.expectSingle
    );
  }
}

async function parseSupabaseResponse(response, expectSingle) {
  const text = await response.text();
  const hasBody = text.length > 0;
  const payload = hasBody ? safeJsonParse(text) : null;

  if (response.ok) {
    return {
      data: payload,
      error: null,
    };
  }

  if (expectSingle && response.status === 406) {
    return {
      data: null,
      error: payload || { message: 'No rows returned' },
    };
  }

  return {
    data: null,
    error: payload || { message: response.statusText || 'Supabase request failed' },
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

module.exports = {
  from(table) {
    return new SupabaseQueryBuilder(table);
  },
};
