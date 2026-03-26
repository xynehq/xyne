import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core/dialect"

import { __knowledgeBaseTocInternals } from "@/db/knowledgeBaseToc"

describe("buildTocInfoSql", () => {
  test("casts polymorphic jsonb_build_object params to stable postgres types", () => {
    const dialect = new PgDialect()
    const query = dialect.sqlToQuery(
      __knowledgeBaseTocInternals.buildTocInfoSql(
        "completed",
        sql`${1}`,
        null,
      ),
    )

    expect(query.sql).toContain("'status', $1::text")
    expect(query.sql).toContain("'attempts', ($2)::int")
    expect(query.sql).toContain("'lastError', $3::text")
    expect(query.params).toEqual(["completed", 1, null])
  })
})
