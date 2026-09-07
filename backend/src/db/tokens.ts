/**
 * Injection tokens live apart from the module that provides them, so a provider
 * needing a token does not have to import the module that imports the provider.
 */
export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
