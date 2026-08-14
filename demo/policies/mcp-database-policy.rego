package vengtoo.mcp

# MCP Database Policy — prevents destructive SQL operations
#
# This policy allows read operations (query, list_tables, describe_table)
# but blocks destructive writes (DROP, DELETE, TRUNCATE) through the execute tool.
# Safe writes (INSERT, UPDATE) are allowed.

default allow := false

# Read-only tools are always allowed
allow if {
    input.resource.name == "database__query"
}

allow if {
    input.resource.name == "database__list_tables"
}

allow if {
    input.resource.name == "database__describe_table"
}

# Execute tool: allow safe writes, block destructive ones
allow if {
    input.resource.name == "database__execute"
    sql := lower(input.resource.attributes.sql)
    not contains(sql, "drop")
    not contains(sql, "truncate")
    not contains(sql, "delete from")
    not contains(sql, "alter table")
}

# Deny reason for blocked operations
reason := "BLOCKED: ALTER TABLE operations are not permitted for AI agents. Schema changes require human approval." if {
    input.resource.name == "database__execute"
    sql := lower(input.resource.attributes.sql)
    contains(sql, "alter table")
} else := "BLOCKED: DROP TABLE operations are not permitted for AI agents. This prevents accidental or malicious data destruction." if {
    input.resource.name == "database__execute"
    sql := lower(input.resource.attributes.sql)
    contains(sql, "drop")
} else := "BLOCKED: TRUNCATE operations are not permitted for AI agents." if {
    input.resource.name == "database__execute"
    sql := lower(input.resource.attributes.sql)
    contains(sql, "truncate")
} else := "BLOCKED: DELETE operations are not permitted for AI agents. Use application-level soft deletes instead." if {
    input.resource.name == "database__execute"
    sql := lower(input.resource.attributes.sql)
    contains(sql, "delete from")
}
