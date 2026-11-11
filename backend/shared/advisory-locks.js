/**
 * Acquire a transaction-scoped Postgres advisory lock using text keys.
 * Cast the function's void result so Prisma can deserialize the raw query.
 */
async function advisoryTransactionLock(tx, resourceKey, scopeKey) {
  if (scopeKey === undefined) {
    return tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${resourceKey}))::text AS acquired`;
  }
  return tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${resourceKey}), hashtext(${scopeKey}))::text AS acquired`;
}

module.exports = { advisoryTransactionLock };
