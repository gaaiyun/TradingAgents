export class FakeD1 {
  constructor({ settings = null, rows = {}, fail = false } = {}) {
    this.settings = settings;
    this.rows = rows;
    this.fail = fail;
    this.calls = [];
  }

  prepare(sql) {
    const db = this;
    const statement = {
      params: [],
      bind(...params) {
        this.params = params;
        return this;
      },
      async first() {
        db.#record(sql, this.params);
        db.#maybeFail();
        if (/FROM\s+workbench_settings/i.test(sql)) return db.settings;
        return null;
      },
      async run() {
        db.#record(sql, this.params);
        db.#maybeFail();
        if (/INSERT\s+INTO\s+workbench_settings/i.test(sql)) {
          const [version, settingsJson, updatedAt] = this.params;
          db.settings = {
            version,
            settings_json: settingsJson,
            updated_at: updatedAt,
          };
        }
        return { success: true };
      },
      async all() {
        db.#record(sql, this.params);
        db.#maybeFail();
        const table = /FROM\s+([a-z_]+)/i.exec(sql)?.[1];
        return { results: structuredClone(db.rows[table] ?? []) };
      },
    };
    return statement;
  }

  #record(sql, params) {
    this.calls.push({ sql, params: structuredClone(params) });
  }

  #maybeFail() {
    if (this.fail) throw new Error("fake D1 unavailable");
  }
}
