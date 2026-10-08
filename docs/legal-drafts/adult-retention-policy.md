# Conservación y eliminación: adultos y adolescentes privados

Versión candidata adult-retention-2026-10-07-v1. Fecha de preparación: 7/10/2026. Estado: código y pruebas locales preparados; reconciliación real, aprobación de textos por el responsable y activación pendientes. El responsable decidió prescindir por ahora de revisión externa de abogado el 7/10/2026. Este documento no modifica cuentas ni la política efectiva de producción.

## Regla jurídica y regla operativa

La ley mexicana no fija un plazo único para todos los datos de la app. La finalidad y necesidad rigen la conservación; la cancelación comprende el bloqueo aplicable y la supresión posterior. Las excepciones requieren justificar qué información se mantiene y durante qué obligación o responsabilidad. [LFPDPPP, artículos 10, 12, 24 y 25](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf).

Para documentación fiscal, el artículo 30 prevé como regla general cinco años desde que se presentaron o debieron presentarse las declaraciones relacionadas, con excepciones y reglas de inicio distintas. Esto no convierte el bosque personal en documentación fiscal ni permite guardar todo cinco años. [Código Fiscal vigente](https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf).

## Calendario propuesto

| Categoría | Regla | Eliminación y límite |
|---|---|---|
| Cuenta, bosque y contenido sincronizado | Mientras la cuenta y finalidad estén vigentes; atender cancelaciones por categoría o de cuenta. | Bloquear el uso al cancelar y suprimir tras el periodo aplicable. La excepción registra datos mínimos, fundamento, fecha y responsable. No imponer borrado por inactividad. |
| Contenido archivado | Recuperable mientras la persona lo conserve para ese fin. | Archivar no equivale a cancelación ARCO. El borrado definitivo debe revisar si quedan notas en marcadores de sincronización. |
| Decisiones adultas, autorización del representante y aceptación adolescente | Evidencia mínima mientras exista el tratamiento autorizado; al terminar, bloqueo únicamente por responsabilidades aplicables. | Texto realmente mostrado, versiones, idioma, decisiones y sujeto/hora/revisión del servidor; sin bosque ni credenciales. Registro independiente protege ante restauraciones antiguas. Si una obligación exige archivo al cerrar, lista explícita de atributos y vencimiento. |
| Invitación privada y verificación mínima | Pendiente/autorizada: siete días. Aceptada: vigencia de representación y margen operativo. | Solo destinatario, fecha de mayoría y referencia del caso; sin documentos de identidad. Cierre físico revoca la invitación y acorta su retención a máximo 36 días. Expedientes externos siguen su procedimiento propio. |
| Logs técnicos ordinarios | PROD 30 días; DEV 7; TEST 14, como configuración operativa propuesta conservada. | No incluir cuerpos, notas, tokens ni contraseñas. Un incidente se registra aparte y solo conserva evidencia necesaria con vencimiento propio. |
| Auditoría ordinaria de seguridad/operación | Propuesta: 30 días para investigar errores, accesos y acciones; no es un plazo legal fijo. | Clasificación explícita, worker limitado y comprobación de obligaciones antes de purga. Históricos/comerciales quedan review_required. Código local preparado; falta reconciliación real. TTL no sustituye la consulta de bloqueos. |
| Soporte ordinario resuelto | Propuesta: 30 días después de cerrar el caso para atender aclaraciones del resultado. | Suprimir adjuntos y datos personales innecesarios. Un caso ARCO, disputa o incidente sigue su fundamento y bloqueo específico, no el plazo ordinario. |
| Puntos de recuperación PITR | Hasta 35 días, conforme a la configuración observada el 6/10; revalidar antes de publicar. | Expiran por la ventana del proveedor. Restaurar en aislamiento y reaplicar exclusiones antes de poner datos a disposición. No prometer borrado instantáneo de un punto histórico. |
| Registro mínimo de exclusión de restauración | Propuesta: 36 días desde la supresión física final: 35 de PITR más 1 día de margen de operación. | Solo identificadores necesarios, fecha y estado; sin bosque. Usar registro independiente de los datos restaurados. Si existen otras copias, ampliar únicamente por su ventana documentada. |
| Comprobantes fiscales/comerciales, cuando existan | Calendario por obligación aplicable; regla fiscal general de cinco años con inicio correcto y excepciones. | No usar la fecha de cierre de cuenta como inicio fiscal automático. Conservar comprobantes mínimos separados del bosque. |
| Copias descargadas por la persona | Bajo control de quien recibió el archivo. | Explicar alcance. El cierre remoto no elimina archivos del dispositivo ni copias entregadas voluntariamente a terceros. |

Los plazos operativos propuestos deben aprobarse por el responsable y implementarse antes de anunciarse como vigentes. Un vencimiento lógico y TTL eventual no prueban supresión física.

## Ficha para cada obligación de bloqueo

Registrar categoría, finalidad terminada, responsable, fundamento y obligación concreta, información mínima retenida, fecha que inicia el cómputo, fecha de fin, acceso permitido y comprobación de supresión. Una ficha sin fundamento o fecha de revisión no justifica conservación indefinida.

Si una solicitud necesita clasificación jurídica, registrar la decisión dentro del plazo de atención y explicar el bloqueo aplicable. No borrar evidencia obligatoria ni extenderlo a datos no necesarios. Antes de cobrar, el contador confirma documentación e inicio fiscal; contratos o controversias pueden tener obligaciones distintas.

## Procedimiento de cancelación y recuperación

1. Recibir y acreditar la solicitud con datos mínimos; distinguir desconexión de un dispositivo, revocación de nube, eliminación de contenido y cierre total.
2. Identificar datos en Cognito, DynamoDB, auditoría, soporte, colas y copias. Una exportación local no acredita el inventario de todos los datos remotos.
3. Bloquear el uso que corresponda y resolver obligaciones comerciales, permisos y fichas de bloqueo. Seguir los plazos ARCO de decisión y cumplimiento; no declarar eliminación por aceptar una solicitud asíncrona.
4. Ofrecer exportación propia por canal seguro; una descarga conserva una copia bajo control de la persona. No exigir una copia local como condición del ejercicio de derechos si la ley no lo permite.
5. Ejecutar supresión verificada de los datos que procedan, registrar resultado mínimo y comunicar excepciones y finalización.
6. Conservar y reaplicar el registro independiente vigente. El cierre preparado conserva exclusiones mínimas 36 días desde supresión física; mientras siga pendiente no caducan. No restaurar las decisiones antiguas sobre el registro vigente ni abrir lecturas antes de reconciliar. Ampliar el horizonte mínimo si otras copias reales duran más.
7. Ensayar purga, reintentos, concurrencia y restauración en DEV/TEST con datos sintéticos. Auditar el resultado sin guardar contenido íntimo.

## Brechas y verificaciones

El anexo del 6/10 registra un estado anterior. El código local preparado purga contenido, mutaciones y uso del sujeto por lotes, consulta obligaciones documentadas y verifica vacío antes de terminar. Exportación/cancelación propias no requieren Premium ni descarga obligatoria. Archivar o borrar un elemento no equivale a cancelar todo el tratamiento o eliminar copias descargadas. La configuración efectiva y el ensayo de recuperación siguen pendientes.

Para adolescentes privados, la autorización no permite exportación cotidiana por el representante. Soporte verifica derechos y cierre completo por caso, sin abrir supervisión. La mayoría de edad conserva cuenta y datos y termina autorización parental/nube; una aceptación adulta y nube propias no abren funciones sociales. Procedimiento técnico preparado: backend `docs/runbooks/privacy-operations.md`.

Se requiere confirmar contratos del proveedor, copias manuales y expedientes de atención. Si un caso incluye obligación legal distinta, su ficha prevalece para esa evidencia mínima. No se activa la purga de cuentas reales al aprobar este documento.

## English summary

Retention follows purpose, necessity and applicable obligations. Cancellation includes any required blocking period and subsequent deletion. Proposed operational periods are 30-day PROD logs/ordinary security audits, 30 days after an ordinary support case closes, up to 35-day PITR and a minimal 36-day restore-exclusion record. These are operational choices, not universal legal deadlines.

Fiscal records generally have a five-year rule with a statutory starting point and exceptions; personal forest content is not retained as a fiscal record. Consent, disputes and privacy cases need category-specific grounds and expiry. A user interface deletion, TTL expiry, or accepted closure request alone is not proof that all copies were erased.
