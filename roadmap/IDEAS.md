# Typed capture policy

Material information that outlives the current task belongs in a typed object, not a chat recap or
hand-maintained list. Capture is intentionally cheap, but it never changes project priority by
itself.

## Routing

| Discovery | Object | Initial state |
| --- | --- | --- |
| Future feature or tangent | `ideas/IDEA-*.md` | `inbox` or `candidate` |
| Reusable finding or knowledge | `insights/INS-*.md` | `candidate` |
| Architectural or policy choice | `decisions/D-*.md` | `proposed` |
| Threat to plan or evidence | `risks/R-*.md` | project-defined open state |

Capture a first-class object when losing it would make a later session repeat research, forget a
constraint, or make an unaudited choice. Do not create objects for transient narration.

## Promotion boundary

Agents may capture and propose. Only the configured human review may accept a Decision, promote an
idea into committed work, reprioritize phases, or change the project's durable claims.

## No duplicate index

Browse or query the object directories. Do not copy their contents into this file; generated or
validated views own summaries and counts.
