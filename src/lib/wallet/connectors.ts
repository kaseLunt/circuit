/**
 * Connector IDENTITY — the ids the connect surface renders and the predicate that says which
 * of them is a fabricated wallet.
 *
 * Split out of `./config.ts` on purpose: config.ts constructs wagmi connectors, so importing
 * it drags the whole connector stack into any module graph that only wanted to ask "is this a
 * mock?". The readiness-source router (`src/lib/live/readiness-source.ts`) asks exactly that
 * and nothing more.
 *
 * The id spelling lives HERE, once: `mockConnectorIdAt` mints the ids config.ts assigns and
 * `isMockConnectorId` recognizes them. Two files agreeing on a `mock-${n}` template is how a
 * renamed connector silently becomes unrecognized — and an unrecognized mock connector would
 * fall to the RPC source, which is the safe direction, while an unrecognized REAL connector
 * would fall to the demo source, which is the unsafe one. One definition removes the choice.
 */

/** wagmi's own connector ids, named here so the chrome, the router and the tests share one spelling. */
export const INJECTED_CONNECTOR_ID = "injected";
export const MOCK_CONNECTOR_ID = "mock";

/**
 * The id of the nth configured mock connector. wagmi's `mock` fixes its id, so every mock
 * past the first is re-identified (`config.ts`) or the connect surface could not tell two
 * test wallets apart.
 */
export function mockConnectorIdAt(index: number): string {
  return index === 0 ? MOCK_CONNECTOR_ID : `${MOCK_CONNECTOR_ID}-${index + 1}`;
}

/**
 * Is this session's transport a FABRICATED wallet?
 *
 * The one question the readiness router asks, and it is deliberately answered by an allow
 * list rather than by excluding `injected`: a connector id this function does not recognize
 * reads as real, so a wallet stack nobody anticipated gets the RPC source and its stated
 * absences — never the demo scenario table's inventions.
 */
export function isMockConnectorId(connectorId: string): boolean {
  return (
    connectorId === MOCK_CONNECTOR_ID || connectorId.startsWith(`${MOCK_CONNECTOR_ID}-`)
  );
}
