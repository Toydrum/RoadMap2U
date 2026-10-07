# Procedimiento de soporte y privacidad / Support and privacy procedure

**Borrador ES/EN pendiente de aprobación. No autoriza la publicación ni la activación familiar PROD. / ES/EN draft awaiting approval. It does not authorize publication or PROD family activation.**

Este documento complementa el [runbook operativo backend](https://github.com/Toydrum/roadmap2u-backend/blob/5a4bb3ba7a25f250c0485082669a1c5249b873e9/docs/runbooks/family-support-privacy.md) y el [anexo técnico](technical-privacy-annex.md). Describe una propuesta de atención manual; no afirma que exista un sistema de tickets o un canal seguro de recepción de documentos ya aprobado.

## ES — responsables y canal

Responsable indicado por el titular: **Héctor Coronado, persona física**. Correo público confirmado de soporte y privacidad: **overseer@roadmap2u.com**. El domicilio para notificaciones sigue pendiente; la dirección personal enviada por chat no forma parte de este documento.

Antes de aprobar: designar a quien tramitará solicitudes de privacidad y a quien recibirá escalaciones, confirmar horarios y objetivos de respuesta, elegir almacenamiento privado de expedientes y su conservación, y verificar el medio seguro para acreditar identidad/representación y entregar información. La confirmación de SNS prueba la suscripción de alertas; no prueba que estos procedimientos se hayan ensayado.

## ES — recepción, verificación y seguimiento

1. Asignar un identificador de caso y conservar fecha de recepción, canal de respuesta, ambiente y categoría. No poner contenido del bosque ni datos íntimos en el asunto o título. Si la petición es urgente por riesgo para un menor, registrar y escalar según el protocolo aprobado.
2. Acusar recibo, explicar la información mínima necesaria y el medio seguro aprobado para verificarla. Nunca pedir contraseñas, MFA, tokens o códigos de invitación. Un correo o captura de pantalla no acredita por sí solo titularidad o representación.
3. Comprobar identidad y, cuando corresponda, representación; confirmar en el servidor el rol y alcance actuales. Una responsabilidad principal o adicional de la app es una autorización técnica y no sustituye esa comprobación jurídica. Separar datos propios, del menor y de terceros.
4. Registrar la decisión y el motivo, ejecutar solo la acción autorizada y comprobar el resultado canónico. Cada intervención operativa conserva el ambiente correcto, permisos, revisión y auditoría previstos; un fallo o conflicto requiere releer el estado antes de otro intento.
5. Responder por el canal verificado, guardar evidencia mínima del resultado y cerrar el caso solo después de comprobarlo. Registrar lo que siga pendiente, incluidas diferencias entre datos activos, puntos de recuperación y copias descargadas por otras personas.

### ES — derechos de datos

La propuesta recibe acceso, rectificación, cancelación y oposición, además de revocación o limitación. La solicitud identifica a la persona y su representación cuando aplique, un medio de respuesta y la petición. Referencia para revisión: decisión en 20 días hábiles; cumplimiento procedente en 15 posteriores; ampliación única justificada. La entrega electrónica disponible es gratuita. Validar aplicación y cómputo antes de aprobar el procedimiento. [Ley vigente, artículos 2, 27–34](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf).

## ES — tratamiento de casos familiares

| Caso | Ruta prevista y comprobación |
| --- | --- |
| Recuperación de una cuenta menor | Verificar autoridad e identidad antes de usar el flujo permitido al principal. No enviar credenciales mediante un ticket o correo ordinario. |
| Invitación, vinculación o transferencia | Consultar la solicitud vigente y las aceptaciones. Mantener el flujo autorizado; no sustituir la aceptación del destinatario con una escritura manual. |
| Amistad infantil disputada | Comprobar los cuatro consentimientos y el estado actual. Usar rechazo o revocación autorizados; no fabricar aprobación ni conceder acceso adulto-menor. |
| Respaldo de un menor | El principal autorizado puede exportar datos sincronizados, incluidos check-ins y sesiones; visitas, adicional y amistades no tienen esa facultad. Verificar destinatario y autoridad vigentes y entregar por el medio seguro aprobado, sin adjuntar el bosque al expediente. |
| Cierre de una cuenta menor | Confirmar la petición y autoridad, descargar y verificar el respaldo previsto antes de la eliminación irreversible, y seguir el estado de cierre hasta su resultado. Si el cliente solo comunica aceptación de la solicitud, no declararla completada. No prometer restauración. |
| Conflicto entre responsables o acceso comprometido | Conservar evidencia mínima y escalar. Toda contención requiere un medio existente y autorizado; no se supone una API nueva de congelación, ni se cambia la fecha de mayoría o responsabilidad para resolver un conflicto. |
| Mayoría de edad o fin de piloto | Comprobar estado efectivo: se conservan cuenta y bosque; la mayoría termina supervisión y cobertura piloto. La revocación de cobertura no borra por sí sola la cuenta ni relaciones. Revisar otras fuentes de Premium antes de explicar el acceso. |

## ES — incidentes, conservación y ensayo

Ante un incidente, registrar alcance conocido, hora, ambiente, identificadores mínimos, contención autorizada y responsable de seguimiento. La decisión sobre comunicaciones y plazos se valida con el procedimiento jurídico aprobado. No enviar mensajes a terceros ni cambiar flags como parte de preparar este borrador.

La política de expedientes, auditorías, respaldos y documentos de identidad sigue pendiente. Los logs configurados a 30 días y PITR de 35 días no son plazos universales de borrado. El [anexo técnico](technical-privacy-annex.md) identifica los límites observados, incluida auditoría sin TTL automático. Registrar cualquier obligación de conservación y su resolución; no prometer purgar información con una herramienta inexistente.

Ensayar en DEV/TEST con datos sintéticos: caso incompleto, identidad no acreditada, rol adicional que solicita respaldo, conflicto de revisión, cierre asíncrono y entrega al titular verificado. Conservar resultados sanitizados. Los smokes familiares ya ejecutados no prueban por sí solos el proceso manual de soporte. La aprobación exige responsable designado, canal validado, decisiones pendientes resueltas y firma de los textos ES/EN; ningún ensayo habilita PROD automáticamente.

## EN — roles and channel

Controller named by the owner: **Héctor Coronado, an individual**. Confirmed public support and privacy email: **overseer@roadmap2u.com**. The notice address remains undecided; the personal address supplied in chat is excluded from this document.

Before approval: designate the privacy request handler and escalation recipient, confirm hours and response targets, select private case storage and retention, and validate the secure method for proving identity/representation and delivering information. SNS confirmation verifies the alert subscription; it does not verify that these procedures have been rehearsed.

## EN — intake, verification and follow-up

1. Assign a case identifier and retain the receipt date, reply channel, environment and category. Keep forest contents and intimate data out of the subject or title. Record and escalate urgent child safety concerns using the approved protocol.
2. Acknowledge receipt, explain the minimum information required and the approved secure verification method. Never ask for passwords, MFA, tokens or invitation codes. An email or screenshot alone does not establish account ownership or legal representation.
3. Verify identity and representation where applicable; confirm current server role and scope. A primary or additional app role is technical authorization and does not replace legal verification. Separate the person's data, the minor's data and third-party data.
4. Record the decision and reason, perform only the authorized action and verify canonical state. Operational intervention preserves the correct environment, permissions, revision and audit; an error or conflict requires rereading state before another attempt.
5. Reply through the verified channel, keep minimal result evidence and close the case after verification. Record unresolved differences between live data, recovery points and copies downloaded by others.

### EN — data rights

The proposal handles access, rectification, cancellation and objection, plus withdrawal or restriction. Requests identify the person, representation where applicable, reply channel and request. Review reference: decision within 20 business days; eligible fulfillment within 15 thereafter; one justified extension. Available electronic delivery is free. Validate applicability and deadline calculation before approving the procedure. [Current law, Articles 2 and 27–34](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf).

## EN — family case handling

| Case | Proposed path and verification |
| --- | --- |
| Minor account recovery | Verify identity and authority before using the primary adult's permitted flow. Do not send credentials through a ticket or ordinary email. |
| Invitation, linking or transfer | Read the current request and acceptances. Preserve the authorized flow; manual writes do not replace recipient acceptance. |
| Disputed child friendship | Check all four consents and current state. Use authorized decline or revocation; do not fabricate approval or grant adult-minor friendship access. |
| Minor backup | The authorized primary can export synced data, including check-ins and sessions; visits, additional adults and friends lack that authority. Verify current recipient and authority and use the approved secure delivery method without attaching the forest to the case record. |
| Minor account closure | Confirm request and authority, download and verify the required backup before irreversible deletion, and follow closure to its result. A client acknowledging the request does not prove completion. Do not promise recovery. |
| Responsibility dispute or compromised access | Preserve minimal evidence and escalate. Containment uses existing authorized means; no new freeze API is presumed, and adulthood dates or responsibility are not changed to resolve a dispute. |
| Adulthood or pilot end | Verify effective state: account and forest remain; adulthood ends supervision and pilot coverage. Coverage revocation does not itself delete accounts or relationships. Check other Premium sources before explaining access. |

## EN — incidents, retention and rehearsal

For an incident, record known scope, time, environment, minimal identifiers, authorized containment and follow-up owner. Communications and deadlines require the approved legal procedure. Preparing this draft does not authorize messages to third parties or flag changes.

Case, audit, backup and identity-document retention policies remain pending. The configured 30-day logs and 35-day PITR do not establish universal deletion deadlines. The [technical annex](technical-privacy-annex.md) records observed limits, including audit without automatic TTL. Record retention obligations and their resolution; do not promise deletion using a tool that does not exist.

Rehearse in DEV/TEST with synthetic data: incomplete request, unverified identity, an additional adult requesting a backup, revision conflict, asynchronous closure and delivery to a verified person. Keep sanitized results. Completed family smokes alone do not prove the manual support process. Approval requires designated personnel, validated channel, resolved decisions and signed ES/EN texts; rehearsals never automatically enable PROD.
