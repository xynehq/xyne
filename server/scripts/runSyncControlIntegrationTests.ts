const run = async (
  command: string[],
  options: { env?: Record<string, string>; stdout?: "pipe" | "inherit" } = {},
) => {
  const proc = Bun.spawn(command, {
    stdout: options.stdout ?? "pipe",
    stderr: "inherit",
    env: { ...process.env, ...options.env },
  })
  const exitCode = await proc.exited
  const stdout =
    options.stdout === "inherit" ? "" : await new Response(proc.stdout).text()
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${exitCode}`)
  }
  return stdout.trim()
}

const waitForPostgres = async (containerId: string) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const proc = Bun.spawn(
      ["docker", "exec", containerId, "pg_isready", "-U", "xyne", "-d", "xyne"],
      { stdout: "pipe", stderr: "pipe" },
    )
    if ((await proc.exited) === 0) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("Timed out waiting for Postgres test container")
}

const waitForHostPostgres = async (databaseUrl: string) => {
  const { default: postgres } = await import("postgres")
  for (let attempt = 0; attempt < 40; attempt++) {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 1 })
    try {
      await sql`SELECT 1`
      await sql.end()
      return
    } catch {
      await sql.end({ timeout: 0 }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error("Timed out waiting for host Postgres connection")
}

let containerId = ""

try {
  await run(["docker", "version"])
  containerId = await run([
    "docker",
    "run",
    "-d",
    "--rm",
    "-e",
    "POSTGRES_USER=xyne",
    "-e",
    "POSTGRES_PASSWORD=xyne",
    "-e",
    "POSTGRES_DB=xyne",
    "-p",
    "127.0.0.1::5432",
    "postgres:15-alpine",
  ])

  await waitForPostgres(containerId)
  const portOutput = await run(["docker", "port", containerId, "5432/tcp"])
  const port = portOutput.match(/:(\d+)$/)?.[1]
  if (!port)
    throw new Error(`Could not parse mapped Postgres port: ${portOutput}`)

  const databaseUrl = `postgres://xyne:xyne@127.0.0.1:${port}/xyne`
  await waitForHostPostgres(databaseUrl)
  const proc = Bun.spawn(
    ["bun", "test", "tests/syncControlIntegration.test.ts"],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        RUN_SYNC_CONTROL_INTEGRATION: "1",
      },
    },
  )
  process.exitCode = await proc.exited
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (containerId) {
    await Bun.spawn(["docker", "rm", "-f", containerId], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited
  }
}
