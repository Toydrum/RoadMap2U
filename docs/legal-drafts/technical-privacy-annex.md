# Anexo técnico de privacidad / Technical privacy annex

**Borrador ES/EN para revisión; no es una aprobación jurídica ni una política de conservación. / ES/EN review draft; not legal approval or a retention policy.**

Observación: 6 de octubre de 2026, PROD. Backend de aplicación `5a4bb3ba7a25f250c0485082669a1c5249b873e9`. Se verificaron metadatos de los recursos AWS instalados y el código de exportación, visitas, sincronización y cierre; no se leyeron bosques ni contenidos de usuarios.

## ES — servicios y recorrido de los datos

| Área | Implementación observada | Información para revisión |
| --- | --- | --- |
| Dispositivo | IndexedDB y archivos de respaldo descargados por la persona | El bosque funciona localmente; las copias descargadas quedan bajo control de quien las recibe. |
| Identidad | Amazon Cognito, región `us-east-1` | Cuenta, atributos de autenticación y administración de identidad. No se publica una identidad compartida por hogar. |
| API y procesamiento | Amazon API Gateway y AWS Lambda, `us-east-1` | Autorización por cuenta, rol y alcance. Transferencias y consentimientos se verifican en el servidor. |
| Datos sincronizados | Amazon DynamoDB, `us-east-1` | La sincronización es opt-in. Incluye árboles, ramas, check-ins, sesiones, cosechas y conservas. Las preferencias locales no forman parte de la exportación familiar de nube. |
| Auditoría | Tabla de auditoría DynamoDB separada | Acciones, actor, sujeto, fecha y detalles operativos; no es el archivo de respaldo del bosque. |
| Cierre asíncrono | Amazon SQS, Lambda y reconciliación | Mensajes de trabajo e identificadores necesarios para procesar el cierre. |
| Entrega web | Amazon S3 y distribución global Amazon CloudFront | Artefactos estáticos de la app. CloudFront tiene logging desactivado en la configuración observada. |
| Operación | Amazon CloudWatch y Amazon SNS | Logs/métricas de operación y alertas privadas. El contacto público de privacidad requiere designación del responsable; no se deriva de la suscripción. |

La marca de proveedor técnico observada es **AWS**. La entidad contractual, condiciones de tratamiento, ubicación/reglas de transferencias y base aplicable deben confirmarse con el contrato y la revisión jurídica. La región configurada de servicios regionales no demuestra que toda operación o entrega global esté limitada a esa región.

### Visitas y respaldo del menor

La vista de visitas entrega el bosque limitado y no sirve check-ins ni sesiones, cualquiera que sea la relación. El responsable principal autorizado puede ejecutar una exportación separada de los registros sincronizados de la cuenta menor; el resultado **sí incluye check-ins y sesiones**. El responsable adicional y las amistades no tienen esa autoridad. La exportación comprueba la autoridad antes y después de consultar los datos para evitar devolver una copia tras un cambio concurrente de responsabilidad o cierre. No obtiene contenidos que solo existan en otro dispositivo. [Código de exportación](https://github.com/Toydrum/roadmap2u-backend/blob/5a4bb3ba7a25f250c0485082669a1c5249b873e9/lambda/handlers/family.ts#L386), [código de visitas](https://github.com/Toydrum/roadmap2u-backend/blob/5a4bb3ba7a25f250c0485082669a1c5249b873e9/lambda/handlers/forests.ts).

La clasificación de categorías sensibles, consentimiento/representación, información infantil y manejo del archivo por su receptor requieren aprobación. El aviso no debe prometer que los check-ins nunca son accesibles por el responsable principal.

### Conservación técnica observada

| Categoría | Valor comprobado | Límite de la observación |
| --- | --- | --- |
| 14 grupos de logs Lambda | 30 días cada uno | Es la configuración activa de CloudWatch, no el plazo de expedientes de soporte. |
| Log de acceso HTTP API | 30 días | Formato configurado: requestId, routeKey, status, responseLength y latency; no contiene campos de body ni cabeceras de autorización. No se inspeccionaron entradas de logs. |
| Datos activos, relaciones e identidad | Sin un vencimiento universal de cuenta | No se puede describir el TTL de la tabla como plazo general de todas las cuentas y bosques. |
| Tabla principal | TTL habilitado sobre `ttl` | Solo se aplica a registros que tengan ese atributo válido. TTL no garantiza eliminación instantánea tras el vencimiento. [Documentación AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html). |
| Marca de cierre completado | El código asigna `ttl` a 30 días tras completar | Mantiene idempotencia de entregas tardías/duplicadas; no implica que todos los datos del usuario se guarden otros 30 días. |
| Auditoría | TTL deshabilitado; el escritor no asigna caducidad | No hay un vencimiento automático configurado. Debe definirse y aprobarse la política aplicable antes de activar el piloto. |
| Recuperación de ambas tablas | PITR habilitado, ventana máxima configurada de 35 días | Es una ventana de puntos de recuperación, distinta de la conservación de datos activos. La inferencia técnica es que borrar en la tabla viva no borra de inmediato los puntos anteriores. [Documentación AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html). |
| Cola de cierre / cola de fallos | 4 / 14 días, cifrado administrado SQS | Plazos de mensajes, no de cuentas. |
| Recursos al retirar infraestructura | Tablas, pool y logs con `Retain` | La política de CloudFormation evita destruir recursos al retirar el stack; no sustituye una política de conservación por categoría. |

Quedan fuera de esta observación los contratos del proveedor, la existencia o política de respaldos manuales, copias externas a estos recursos, expedientes futuros de soporte y archivos que descarguen las personas. No deben presentarse como ya reconciliados o aprobados.

## EN — services and data flow

| Area | Observed implementation | Review information |
| --- | --- | --- |
| Device | IndexedDB and backups downloaded by the person | The forest works locally; downloaded copies are controlled by whoever receives them. |
| Identity | Amazon Cognito, `us-east-1` | Account, authentication attributes and identity administration. Each person has a separate account. |
| API and processing | Amazon API Gateway and AWS Lambda, `us-east-1` | Account, role and scope authorization; server-verified transfers and consents. |
| Synced data | Amazon DynamoDB, `us-east-1` | Sync is opt-in and includes trees, nodes, check-ins, sessions, harvests and preserves. Local preferences are not included in a family cloud export. |
| Audit | Separate DynamoDB audit table | Actions, actor, subject, timestamp and operational details; not the forest backup file. |
| Asynchronous closure | Amazon SQS, Lambda and reconciliation | Work messages and identifiers needed to process closure. |
| Web delivery | Amazon S3 and global Amazon CloudFront distribution | Static app artifacts. CloudFront logging is disabled in the observed configuration. |
| Operations | Amazon CloudWatch and Amazon SNS | Operational logs/metrics and private alerts. The controller must designate the public privacy contact separately; an alert subscription does not establish that role. |

The observed technical provider brand is **AWS**. The contracting entity, processing terms, transfer locations/rules and applicable basis require contract verification and legal review. The configured region for regional services does not establish that all operations or global delivery are confined to that region.

### Minor visits and backup

The visit view serves a limited forest and never serves check-ins or sessions, regardless of relationship. The authorized primary responsible adult can perform a separate export of the minor account’s synced records; it **includes check-ins and sessions**. The additional responsible adult and friends lack that authority. The export checks authority before and after querying records to avoid returning data following a concurrent care change or closure. It cannot obtain contents existing only on another device. [Export implementation](https://github.com/Toydrum/roadmap2u-backend/blob/5a4bb3ba7a25f250c0485082669a1c5249b873e9/lambda/handlers/family.ts#L386), [visit implementation](https://github.com/Toydrum/roadmap2u-backend/blob/5a4bb3ba7a25f250c0485082669a1c5249b873e9/lambda/handlers/forests.ts).

Sensitive data classification, consent/representation, child-facing disclosure and the recipient’s handling of the file require approval. The notice must not promise that the primary responsible adult can never access check-ins.

### Observed technical retention

| Category | Verified setting | Observation limit |
| --- | --- | --- |
| 14 Lambda log groups | 30 days each | Active CloudWatch setting, not a support case retention period. |
| HTTP API access log | 30 days | Configured fields: requestId, routeKey, status, responseLength and latency; no body or authorization-header fields. Log entries were not inspected. |
| Active data, relationships and identity | No universal account expiration | Table TTL is not a general retention period for every account or forest. |
| Main table | TTL enabled on `ttl` | Applies only to records carrying a valid attribute; expiration does not guarantee instant deletion. [AWS documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html). |
| Completed closure marker | Code sets a TTL 30 days after completion | Supports delayed/duplicate-delivery idempotency; does not mean all user data is kept for another 30 days. |
| Audit | TTL disabled; writer sets no expiration | No automatic expiration is configured. An applicable policy must be defined and approved before pilot activation. |
| Recovery for both tables | PITR enabled, configured maximum recovery window of 35 days | Recovery points differ from active-data retention. The technical inference is that deleting live data does not immediately erase prior recovery points. [AWS documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html). |
| Closure queue / dead-letter queue | 4 / 14 days, SQS managed encryption | Message retention periods, not account retention. |
| Infrastructure removal | Tables, pool and logs use `Retain` | CloudFormation avoids destroying those resources on stack removal; this is not a category-specific retention policy. |

Provider contracts, existence/policy of manual backups, copies outside these resources, future support records and files downloaded by people were not inventoried here. They must not be described as already reconciled or approved.
