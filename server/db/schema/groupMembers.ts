import { pgTable, text, primaryKey } from "drizzle-orm/pg-core"
import { groups } from "@/db/schema/groups"

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    memberEmail: text("member_email").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.memberEmail] }) }),
)
