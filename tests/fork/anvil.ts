/** Shared anvil endpoint for the fork suite (global setup + tests). */
export const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? "8547");
export const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
