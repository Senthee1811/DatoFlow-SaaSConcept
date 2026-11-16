/** Injection tokens. Every dependency is injected by token, so no decorator metadata is needed. */
export const ENV = Symbol('ENV');
export const DB = Symbol('DB');
export const REDIS = Symbol('REDIS');
export const EMAIL = Symbol('EMAIL');
export const AUTH = Symbol('AUTH');
export const LOGGER = Symbol('LOGGER');
